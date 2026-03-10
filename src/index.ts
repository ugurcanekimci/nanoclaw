/**
 * NanoClaw runtime entrypoint.
 *
 * Starts the message loop: channels → group queue → container dispatch → IPC.
 * The Swarm API (Hono) runs alongside as a secondary service.
 */

// Register channel factories (side-effect imports)
import './channels/index.js';

import {
  ASSISTANT_NAME,
  CREDENTIAL_PROXY_PORT,
  LANGFUSE_CAPTURE_PROMPTS,
  TRIGGER_PATTERN,
  TIMEZONE,
} from './config.js';
import {
  initDatabase,
  getAllRegisteredGroups,
  setRegisteredGroup,
  storeMessage,
  storeMessageDirect,
  storeChatMetadata,
  getMessagesSince,
  getRouterState,
  setRouterState,
  getSession,
  setSession,
  getAllSessions,
  getAllTasks,
  getAvailableGroups,
  setLastGroupSync,
} from './db.js';
import { startCredentialProxy } from './credential-proxy.js';
import {
  runContainerAgent,
  writeTasksSnapshot,
  writeGroupsSnapshot,
} from './container-runner.js';
import { GroupQueue } from './group-queue.js';
import { startIpcWatcher } from './ipc.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { loadSenderAllowlist, isTriggerAllowed } from './sender-allowlist.js';
import {
  getRegisteredChannelNames,
  getChannelFactory,
} from './channels/registry.js';
import { routeOutbound, formatMessages, formatOutbound } from './router.js';
import { logger } from './logger.js';
import { createTraceContext } from './observability/context.js';
import {
  getLangfuse,
  initLangfuse,
  shouldSample,
  shutdownLangfuse,
} from './observability/langfuse.js';
import { startSwarmApi } from './swarm-api.js';
import type { Channel, NewMessage, RegisteredGroup } from './types.js';

async function main(): Promise<void> {
  logger.info('Starting NanoClaw runtime');

  // ── Observability ──
  initLangfuse();

  // ── Database ──
  initDatabase();

  // ── Credential proxy ──
  await startCredentialProxy(CREDENTIAL_PROXY_PORT);

  // ── Group queue ──
  const queue = new GroupQueue();
  const channels: Channel[] = [];
  const senderAllowlist = loadSenderAllowlist();

  // ── Helpers ──

  const registeredGroups = (): Record<string, RegisteredGroup> =>
    getAllRegisteredGroups();

  const sendMessage = async (jid: string, text: string): Promise<void> => {
    const formatted = formatOutbound(text);
    if (!formatted) return;
    await routeOutbound(channels, jid, formatted);
  };

  const injectPrompt = (
    chatJid: string,
    text: string,
    sender: string,
  ): void => {
    const msg: NewMessage = {
      id: `ipc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      chat_jid: chatJid,
      sender,
      sender_name: sender,
      content: text,
      timestamp: new Date().toISOString(),
      is_ipc_injected: true,
    };
    storeMessage(msg);
    // Try to send to active container first; otherwise enqueue
    if (!queue.sendMessage(chatJid, text)) {
      queue.enqueueMessageCheck(chatJid);
    }
  };

  const registerGroup = (jid: string, group: RegisteredGroup): void => {
    setRegisteredGroup(jid, group);
    logger.info({ jid, folder: group.folder }, 'Group registered');
  };

  const syncGroups = async (force: boolean): Promise<void> => {
    for (const ch of channels) {
      if (ch.syncGroups) await ch.syncGroups(force);
    }
    setLastGroupSync();
  };

  const getAvailableGroupsHelper = () => {
    const groups = registeredGroups();
    return getAvailableGroups(new Set(Object.keys(groups)));
  };

  // ── Message processing ──

  queue.setProcessMessagesFn(async (groupJid: string): Promise<boolean> => {
    const groups = registeredGroups();
    const group = groups[groupJid];
    if (!group) {
      logger.warn({ groupJid }, 'No registered group for JID');
      return false;
    }

    const lastKey = `last_timestamp:${group.folder}`;
    const lastTimestamp = getRouterState(lastKey) || '1970-01-01T00:00:00.000Z';
    const messages = getMessagesSince(groupJid, lastTimestamp, ASSISTANT_NAME);

    if (messages.length === 0) {
      logger.debug({ groupJid }, 'No new messages');
      return true;
    }

    // ── Observability: trace this turn ──
    const sampled = shouldSample();
    const langfuse = getLangfuse();
    const trace = sampled
      ? langfuse.trace({
          name: 'message-turn',
          sessionId: group.folder,
          input: { chatJid: groupJid, messageCount: messages.length },
          metadata: { source: 'user', groupFolder: group.folder },
        })
      : null;

    // Trigger check
    const requiresTrigger = group.requiresTrigger !== false && !group.isMain;
    const triggerGateStart = Date.now();
    const triggered = requiresTrigger
      ? messages.some((m) => !m.is_from_me && TRIGGER_PATTERN.test(m.content))
      : true;

    let senderAllowed = true;
    if (!triggered) {
      const lastMsg = messages[messages.length - 1]!;
      setRouterState(lastKey, lastMsg.timestamp);
      logger.debug({ groupJid }, 'Trigger not matched, skipping');
      if (trace) {
        trace.span({
          name: 'trigger-gate',
          startTime: new Date(triggerGateStart),
          endTime: new Date(),
          output: { triggered: false, requiresTrigger, senderAllowed: true },
        });
      }
      return true;
    }

    // Sender allowlist check
    if (requiresTrigger) {
      const triggeringMsg = messages.find(
        (m) => !m.is_from_me && TRIGGER_PATTERN.test(m.content),
      );
      if (
        triggeringMsg &&
        !isTriggerAllowed(groupJid, triggeringMsg.sender, senderAllowlist)
      ) {
        senderAllowed = false;
        const lastMsg = messages[messages.length - 1]!;
        setRouterState(lastKey, lastMsg.timestamp);
        if (trace) {
          trace.span({
            name: 'trigger-gate',
            startTime: new Date(triggerGateStart),
            endTime: new Date(),
            output: { triggered: true, requiresTrigger, senderAllowed: false },
          });
        }
        return true;
      }
    }

    if (trace) {
      trace.span({
        name: 'trigger-gate',
        startTime: new Date(triggerGateStart),
        endTime: new Date(),
        output: { triggered: true, requiresTrigger, senderAllowed },
      });
    }

    // Build prompt
    const formatStart = Date.now();
    const prompt = formatMessages(messages, TIMEZONE);
    const isMain = group.isMain === true;

    if (trace) {
      trace.span({
        name: 'format-messages',
        startTime: new Date(formatStart),
        endTime: new Date(),
        output: { messageCount: messages.length },
        ...(LANGFUSE_CAPTURE_PROMPTS ? { input: { prompt } } : {}),
      });
    }

    // Write snapshots for container
    const allTasks = getAllTasks();
    writeTasksSnapshot(
      group.folder,
      isMain,
      allTasks.map((t) => ({
        id: t.id,
        groupFolder: t.group_folder,
        prompt: t.prompt,
        schedule_type: t.schedule_type,
        schedule_value: t.schedule_value,
        status: t.status,
        next_run: t.next_run,
      })),
    );

    if (isMain) {
      const available = getAvailableGroupsHelper();
      writeGroupsSnapshot(
        group.folder,
        isMain,
        available,
        new Set(Object.keys(groups)),
      );
    }

    const sessionId = getSession(group.folder);

    // Typing indicator
    const channel = channels.find((c) => c.ownsJid(groupJid));
    if (channel?.setTyping) {
      await channel.setTyping(groupJid, true).catch(() => {});
    }

    const traceContext = createTraceContext({
      source: 'user',
      chatJid: groupJid,
      groupFolder: group.folder,
      sessionId: sessionId ?? undefined,
      ...(trace ? { parentTraceId: trace.id } : {}),
    });

    const dispatchStart = Date.now();
    let streamChunkCount = 0;

    try {
      const output = await runContainerAgent(
        group,
        {
          prompt,
          sessionId,
          groupFolder: group.folder,
          chatJid: groupJid,
          isMain,
          assistantName: ASSISTANT_NAME,
          traceContext,
        },
        (proc, containerName) => {
          queue.registerProcess(groupJid, proc, containerName, group.folder);
          if (trace) {
            trace.event({
              name: 'container-started',
              metadata: { containerName, groupFolder: group.folder },
            });
          }
        },
        async (streamedOutput) => {
          if (streamedOutput.result) {
            streamChunkCount++;
            const sendStart = Date.now();
            await sendMessage(groupJid, streamedOutput.result);
            if (trace) {
              trace.span({
                name: 'send-message',
                startTime: new Date(sendStart),
                endTime: new Date(),
                output: {
                  targetJid: groupJid,
                  messageLength: streamedOutput.result.length,
                  chunkIndex: streamChunkCount,
                },
              });
            }
            storeMessageDirect({
              id: `bot-${Date.now()}`,
              chat_jid: groupJid,
              sender: ASSISTANT_NAME,
              sender_name: ASSISTANT_NAME,
              content: streamedOutput.result,
              timestamp: new Date().toISOString(),
              is_from_me: true,
              is_bot_message: true,
            });
          }
          if (streamedOutput.newSessionId) {
            setSession(group.folder, streamedOutput.newSessionId);
            if (trace) {
              trace.event({
                name: 'session-updated',
                metadata: { newSessionId: streamedOutput.newSessionId },
              });
            }
          }
          if (streamedOutput.status === 'success') {
            queue.notifyIdle(groupJid);
          }
        },
      );

      if (trace) {
        trace.span({
          name: 'agent-dispatch',
          startTime: new Date(dispatchStart),
          endTime: new Date(),
          output: {
            status: output.status,
            streamChunks: streamChunkCount,
            groupFolder: group.folder,
          },
        });
      }

      if (output.newSessionId) {
        setSession(group.folder, output.newSessionId);
        if (trace) {
          trace.event({
            name: 'session-updated',
            metadata: { newSessionId: output.newSessionId },
          });
        }
      }

      // Advance timestamp
      const lastMsg = messages[messages.length - 1]!;
      setRouterState(lastKey, lastMsg.timestamp);

      if (trace) {
        trace.update({ output: { status: output.status } });
      }

      return output.status === 'success';
    } catch (err) {
      logger.error({ groupJid, err }, 'Container execution failed');
      if (trace) {
        trace.span({
          name: 'agent-dispatch',
          startTime: new Date(dispatchStart),
          endTime: new Date(),
          statusMessage: 'error',
          output: { streamChunks: streamChunkCount },
        });
        trace.event({
          name: 'error',
          metadata: {
            error: err instanceof Error ? err.message : 'Unknown error',
            groupFolder: group.folder,
          },
        });
        trace.update({ output: { status: 'error' } });
      }
      return false;
    } finally {
      if (channel?.setTyping) {
        await channel.setTyping(groupJid, false).catch(() => {});
      }
    }
  });

  // ── Channels ──

  for (const name of getRegisteredChannelNames()) {
    const factory = getChannelFactory(name);
    if (!factory) continue;

    try {
      const channel = factory({
        onMessage: (chatJid: string, msg: NewMessage) => {
          storeMessage(msg);
          queue.enqueueMessageCheck(chatJid);
        },
        onChatMetadata: (
          chatJid,
          timestamp,
          chatName,
          channelName,
          isGroup,
        ) => {
          storeChatMetadata(chatJid, timestamp, chatName, channelName, isGroup);
        },
        registeredGroups,
      });

      if (channel) {
        await channel.connect();
        channels.push(channel);
        logger.info({ channel: name }, 'Channel connected');
      }
    } catch (err) {
      logger.error({ channel: name, err }, 'Failed to initialize channel');
    }
  }

  // ── IPC watcher ──

  startIpcWatcher({
    sendMessage,
    injectPrompt,
    registeredGroups,
    registerGroup,
    syncGroups,
    getAvailableGroups: getAvailableGroupsHelper,
    writeGroupsSnapshot,
  });

  // ── Task scheduler ──

  startSchedulerLoop({
    registeredGroups,
    getSessions: () => getAllSessions(),
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) => {
      queue.registerProcess(groupJid, proc, containerName, groupFolder);
    },
    sendMessage,
  });

  // ── Swarm API (secondary service) ──

  const swarmApi = await startSwarmApi();

  logger.info('NanoClaw runtime started');

  // ── Graceful shutdown ──

  const shutdown = async (): Promise<void> => {
    logger.info('Shutting down...');
    await shutdownLangfuse();
    await queue.shutdown(30_000);
    for (const ch of channels) {
      await ch.disconnect().catch(() => {});
    }
    swarmApi.close();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  logger.fatal({ err }, 'Failed to start NanoClaw runtime');
  process.exit(1);
});
