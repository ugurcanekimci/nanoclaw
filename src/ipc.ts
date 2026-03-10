import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import { DATA_DIR, IPC_POLL_INTERVAL, TIMEZONE } from './config.js';
import { createTask, deleteTask, getTaskById, updateTask } from './db.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import type { TraceContext } from './observability/context.js';
import { deserializeTraceContext } from './observability/context.js';
import { getLangfuse, shouldSample } from './observability/langfuse.js';
import { AvailableGroup, RegisteredGroup } from './types.js';

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  /**
   * Inject a prompt directly into a target group's agent session.
   * Stores the message in DB and wakes the message loop — no Slack round-trip needed.
   * Used when one agent needs to trigger another agent's session (e.g., sub-agent → orchestrator).
   */
  injectPrompt: (chatJid: string, text: string, sender: string) => void;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroups: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
}

let ipcWatcherRunning = false;

// === IPC Injection Rate Limiting ===
// Prevents runaway loops from IPC injection storms.
const IPC_INJECT_MAX_PER_MINUTE = 10;

// Per source→target rate limiter: tracks injections from a specific source to a
// specific target within a 60s window. Keyed as "source:target" for precision —
// multiple sources can inject into the same target without sharing a counter.
const ipcInjectCounts = new Map<
  string,
  { count: number; windowStart: number }
>();

function checkInjectRateLimit(
  sourceFolder: string,
  targetFolder: string,
): boolean {
  const key = `${sourceFolder}:${targetFolder}`;
  const now = Date.now();
  const entry = ipcInjectCounts.get(key);
  if (!entry || now - entry.windowStart > 60_000) {
    ipcInjectCounts.set(key, { count: 1, windowStart: now });
    return true;
  }
  if (entry.count >= IPC_INJECT_MAX_PER_MINUTE) return false;
  entry.count++;
  return true;
}

// Per-pair rate limiter: prevents cross-group loops (A→B→A→B).
// Tracks combined injection count for both directions of a pair within a 60s window.
const PAIR_INJECT_MAX_PER_MINUTE = 5;
const ipcPairCounts = new Map<string, { count: number; windowStart: number }>();

function checkPairRateLimit(
  sourceFolder: string,
  targetFolder: string,
): boolean {
  // Canonical pair key: alphabetically sorted so A→B and B→A share the same counter.
  const pairKey = [sourceFolder, targetFolder].sort().join('↔');
  const now = Date.now();
  const entry = ipcPairCounts.get(pairKey);
  if (!entry || now - entry.windowStart > 60_000) {
    ipcPairCounts.set(pairKey, { count: 1, windowStart: now });
    return true;
  }
  if (entry.count >= PAIR_INJECT_MAX_PER_MINUTE) return false;
  entry.count++;
  return true;
}

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    // Scan all group IPC directories (identity determined by directory)
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    const registeredGroups = deps.registeredGroups();

    // Build folder→isMain lookup from registered groups
    const folderIsMain = new Map<string, boolean>();
    for (const group of Object.values(registeredGroups)) {
      if (group.isMain) folderIsMain.set(group.folder, true);
    }

    for (const sourceGroup of groupFolders) {
      const isMain = folderIsMain.get(sourceGroup) === true;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

      // Process messages from this group's IPC directory
      try {
        if (fs.existsSync(messagesDir)) {
          const messageFiles = fs
            .readdirSync(messagesDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              // Recover trace context from IPC message for cross-agent linking
              const parentTrace: TraceContext | null = data.traceContext
                ? deserializeTraceContext(
                    typeof data.traceContext === 'string'
                      ? data.traceContext
                      : JSON.stringify(data.traceContext),
                  )
                : null;
              if (parentTrace) {
                logger.debug(
                  { traceId: parentTrace.traceId, sourceGroup },
                  'IPC message carries trace context',
                );
              }

              // ── OBS-05: trace this IPC file ──
              const sampled = shouldSample();
              const trace = sampled
                ? getLangfuse().trace({
                    name: 'ipc-process',
                    sessionId: sourceGroup,
                    metadata: {
                      type: data.type || 'unknown',
                      sourceGroup,
                      file,
                      parentTraceId: parentTrace?.traceId,
                    },
                  })
                : null;

              if (trace) {
                trace.event({
                  name: 'file-read',
                  metadata: { type: data.type || 'unknown', sourceGroup },
                });
              }

              if (data.type === 'message' && data.chatJid && data.text) {
                // Authorization: verify this group can send to this chatJid
                const targetGroup = registeredGroups[data.chatJid];
                const authorized =
                  isMain ||
                  (targetGroup !== undefined &&
                    targetGroup.folder === sourceGroup);

                if (trace) {
                  trace.event({
                    name: 'auth-check',
                    metadata: {
                      authorized,
                      reason: authorized
                        ? isMain
                          ? 'main-group'
                          : 'own-channel'
                        : 'unauthorized',
                    },
                  });
                }

                if (authorized) {
                  // Post to Slack (or other channel) for human visibility
                  await deps.sendMessage(data.chatJid, data.text);
                  logger.info(
                    { chatJid: data.chatJid, sourceGroup },
                    'IPC message sent',
                  );

                  if (trace) {
                    trace.event({
                      name: 'send-message',
                      metadata: {
                        targetJid: data.chatJid,
                        textLength: data.text.length,
                      },
                    });
                  }

                  // Inject into the target group's agent session directly so the
                  // orchestrator wakes up without relying on the Slack round-trip
                  // (bot messages are filtered out by getNewMessages and never trigger
                  // agent sessions).
                  let injectReason: string;
                  if (!targetGroup) {
                    // No registered group for this JID — it's a channel-only send.
                    // Nothing to inject.
                    injectReason = 'no-registered-group';
                    logger.debug(
                      { chatJid: data.chatJid, sourceGroup },
                      'IPC target has no registered agent group — skipping session inject',
                    );
                  } else if (targetGroup.folder === sourceGroup) {
                    // Self-injection: would cause an infinite loop. Slack send above
                    // already provides visibility; block the session injection.
                    injectReason = 'self-injection-blocked';
                    logger.warn(
                      { sourceGroup },
                      'Blocked self-targeted IPC injection (loop prevention)',
                    );
                  } else if (
                    !checkInjectRateLimit(sourceGroup, targetGroup.folder)
                  ) {
                    injectReason = 'rate-limit-source';
                    logger.warn(
                      { sourceGroup, targetFolder: targetGroup.folder },
                      `IPC injection rate limit exceeded (>${IPC_INJECT_MAX_PER_MINUTE}/min from source to target) — dropping`,
                    );
                  } else if (
                    !checkPairRateLimit(sourceGroup, targetGroup.folder)
                  ) {
                    injectReason = 'rate-limit-pair';
                    logger.warn(
                      { sourceGroup, targetFolder: targetGroup.folder },
                      `IPC cross-group injection rate limit exceeded (>${PAIR_INJECT_MAX_PER_MINUTE}/min per pair) — dropping`,
                    );
                  } else {
                    injectReason = 'injected';
                    const senderName = data.sender || sourceGroup;
                    deps.injectPrompt(data.chatJid, data.text, senderName);
                    logger.info(
                      {
                        chatJid: data.chatJid,
                        sourceGroup,
                        sender: senderName,
                      },
                      'IPC message injected into target session',
                    );
                  }

                  if (trace) {
                    trace.event({
                      name: 'inject-decision',
                      metadata: {
                        targetGroup: targetGroup?.folder,
                        injected: injectReason === 'injected',
                        reason: injectReason,
                      },
                    });
                  }
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC message attempt blocked',
                  );
                }
              }
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC message',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC messages directory',
        );
      }

      // Process tasks from this group's IPC directory
      try {
        if (fs.existsSync(tasksDir)) {
          const taskFiles = fs
            .readdirSync(tasksDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

              // ── OBS-05: trace task IPC file ──
              const taskSampled = shouldSample();
              const taskTrace = taskSampled
                ? getLangfuse().trace({
                    name: 'ipc-process',
                    sessionId: sourceGroup,
                    metadata: {
                      type: data.type || 'unknown',
                      sourceGroup,
                      file,
                      isTask: true,
                    },
                  })
                : null;

              if (taskTrace) {
                taskTrace.event({
                  name: 'file-read',
                  metadata: { type: data.type || 'unknown', sourceGroup },
                });
              }

              // Pass source group identity to processTaskIpc for authorization
              await processTaskIpc(data, sourceGroup, isMain, deps, taskTrace);
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC task',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}

/** Minimal trace handle for emitting events — accepts Langfuse trace or null. */
type TraceHandle = {
  event: (opts: { name: string; metadata: Record<string, unknown> }) => void;
} | null;

export async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    requiresTrigger?: boolean;
    containerConfig?: RegisteredGroup['containerConfig'];
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
  deps: IpcDeps,
  trace: TraceHandle = null,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();

  const emitTaskAction = (
    action: string,
    extra: Record<string, unknown> = {},
  ) => {
    if (trace) {
      trace.event({
        name: 'task-action',
        metadata: {
          action,
          taskId: data.taskId,
          sourceGroup,
          authorized: true,
          ...extra,
        },
      });
    }
  };

  const emitUnauthorized = (action: string) => {
    if (trace) {
      trace.event({
        name: 'task-action',
        metadata: {
          action,
          taskId: data.taskId,
          sourceGroup,
          authorized: false,
        },
      });
    }
  };

  switch (data.type) {
    case 'schedule_task':
      if (
        data.prompt &&
        data.schedule_type &&
        data.schedule_value &&
        data.targetJid
      ) {
        // Resolve the target group from JID
        const targetJid = data.targetJid as string;
        const targetGroupEntry = registeredGroups[targetJid];

        if (!targetGroupEntry) {
          logger.warn(
            { targetJid },
            'Cannot schedule task: target group not registered',
          );
          break;
        }

        const targetFolder = targetGroupEntry.folder;

        // Authorization: non-main groups can only schedule for themselves
        if (!isMain && targetFolder !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetFolder },
            'Unauthorized schedule_task attempt blocked',
          );
          break;
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, {
              tz: TIMEZONE,
            });
            nextRun = interval.next().toISOString();
          } catch {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid cron expression',
            );
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid interval',
            );
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          const date = new Date(data.schedule_value);
          if (isNaN(date.getTime())) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid timestamp',
            );
            break;
          }
          nextRun = date.toISOString();
        }

        const taskId =
          data.taskId ||
          `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated'
            ? data.context_mode
            : 'isolated';
        createTask({
          id: taskId,
          group_folder: targetFolder,
          chat_jid: targetJid,
          prompt: data.prompt,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
        });
        emitTaskAction('schedule_task', {
          taskId,
          targetFolder,
          scheduleType,
          contextMode,
        });
        logger.info(
          { taskId, sourceGroup, targetFolder, contextMode },
          'Task created via IPC',
        );
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'paused' });
          emitTaskAction('pause_task');
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task paused via IPC',
          );
        } else {
          emitUnauthorized('pause_task');
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task pause attempt',
          );
        }
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'active' });
          emitTaskAction('resume_task');
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task resumed via IPC',
          );
        } else {
          emitUnauthorized('resume_task');
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task resume attempt',
          );
        }
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          deleteTask(data.taskId);
          emitTaskAction('cancel_task');
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task cancelled via IPC',
          );
        } else {
          emitUnauthorized('cancel_task');
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task cancel attempt',
          );
        }
      }
      break;

    case 'update_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (!task) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Task not found for update',
          );
          break;
        }
        if (!isMain && task.group_folder !== sourceGroup) {
          emitUnauthorized('update_task');
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task update attempt',
          );
          break;
        }

        const updates: Parameters<typeof updateTask>[1] = {};
        if (data.prompt !== undefined) updates.prompt = data.prompt;
        if (data.schedule_type !== undefined)
          updates.schedule_type = data.schedule_type as
            | 'cron'
            | 'interval'
            | 'once';
        if (data.schedule_value !== undefined)
          updates.schedule_value = data.schedule_value;

        // Recompute next_run if schedule changed
        if (data.schedule_type || data.schedule_value) {
          const updatedTask = {
            ...task,
            ...updates,
          };
          if (updatedTask.schedule_type === 'cron') {
            try {
              const interval = CronExpressionParser.parse(
                updatedTask.schedule_value,
                { tz: TIMEZONE },
              );
              updates.next_run = interval.next().toISOString();
            } catch {
              logger.warn(
                { taskId: data.taskId, value: updatedTask.schedule_value },
                'Invalid cron in task update',
              );
              break;
            }
          } else if (updatedTask.schedule_type === 'interval') {
            const ms = parseInt(updatedTask.schedule_value, 10);
            if (!isNaN(ms) && ms > 0) {
              updates.next_run = new Date(Date.now() + ms).toISOString();
            }
          }
        }

        updateTask(data.taskId, updates);
        emitTaskAction('update_task', { updates: Object.keys(updates) });
        logger.info(
          { taskId: data.taskId, sourceGroup, updates },
          'Task updated via IPC',
        );
      }
      break;

    case 'refresh_groups':
      // Only main group can request a refresh
      if (isMain) {
        emitTaskAction('refresh_groups');
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        );
        await deps.syncGroups(true);
        // Write updated snapshot immediately
        const availableGroups = deps.getAvailableGroups();
        deps.writeGroupsSnapshot(
          sourceGroup,
          true,
          availableGroups,
          new Set(Object.keys(registeredGroups)),
        );
      } else {
        emitUnauthorized('refresh_groups');
        logger.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
        );
      }
      break;

    case 'register_group':
      // Only main group can register new groups
      if (!isMain) {
        emitUnauthorized('register_group');
        logger.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        if (!isValidGroupFolder(data.folder)) {
          logger.warn(
            { sourceGroup, folder: data.folder },
            'Invalid register_group request - unsafe folder name',
          );
          break;
        }
        // Defense in depth: agent cannot set isMain via IPC
        deps.registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
          requiresTrigger: data.requiresTrigger,
        });
        emitTaskAction('register_group', {
          jid: data.jid,
          folder: data.folder,
        });
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}
