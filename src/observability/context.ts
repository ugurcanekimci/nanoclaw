/**
 * Trace context contract for distributed tracing across NanoClaw.
 *
 * Created at each entry point (user message, IPC, scheduler) and propagated
 * through container-runner → agent-runner via env var + stdin JSON.
 */

import crypto from 'node:crypto';

export type TraceSource = 'user' | 'ipc' | 'scheduler';

export interface TraceContext {
  traceId: string;
  spanId?: string;
  sessionId?: string;
  runId: string;
  source: TraceSource;
  taskId?: string;
  chatJid?: string;
  groupFolder?: string;
}

export interface CreateTraceContextOpts {
  source: TraceSource;
  chatJid?: string;
  groupFolder?: string;
  taskId?: string;
  sessionId?: string;
  parentTraceId?: string;
  parentSpanId?: string;
}

export function createTraceContext(opts: CreateTraceContextOpts): TraceContext {
  return {
    traceId: opts.parentTraceId || crypto.randomUUID(),
    spanId: opts.parentSpanId,
    sessionId: opts.sessionId,
    runId: crypto.randomUUID(),
    source: opts.source,
    taskId: opts.taskId,
    chatJid: opts.chatJid,
    groupFolder: opts.groupFolder,
  };
}

export function serializeTraceContext(ctx: TraceContext): string {
  return JSON.stringify(ctx);
}

export function deserializeTraceContext(json: string): TraceContext | null {
  try {
    const parsed = JSON.parse(json);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof parsed.traceId === 'string' &&
      typeof parsed.runId === 'string' &&
      typeof parsed.source === 'string'
    ) {
      return parsed as TraceContext;
    }
    return null;
  } catch {
    return null;
  }
}
