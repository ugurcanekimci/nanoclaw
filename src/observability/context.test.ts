import { describe, it, expect } from 'vitest';
import {
  createTraceContext,
  serializeTraceContext,
  deserializeTraceContext,
} from './context.js';

describe('createTraceContext', () => {
  it('creates context with user source', () => {
    const ctx = createTraceContext({
      source: 'user',
      chatJid: 'slack:C123',
      groupFolder: 'slack_swarm-main',
    });
    expect(ctx.source).toBe('user');
    expect(ctx.chatJid).toBe('slack:C123');
    expect(ctx.groupFolder).toBe('slack_swarm-main');
    expect(ctx.traceId).toBeTruthy();
    expect(ctx.runId).toBeTruthy();
    expect(ctx.traceId).not.toBe(ctx.runId);
  });

  it('creates context with ipc source', () => {
    const ctx = createTraceContext({ source: 'ipc' });
    expect(ctx.source).toBe('ipc');
  });

  it('creates context with scheduler source and taskId', () => {
    const ctx = createTraceContext({
      source: 'scheduler',
      taskId: 'task-123',
    });
    expect(ctx.source).toBe('scheduler');
    expect(ctx.taskId).toBe('task-123');
  });

  it('uses parentTraceId when provided', () => {
    const ctx = createTraceContext({
      source: 'ipc',
      parentTraceId: 'parent-trace-id',
    });
    expect(ctx.traceId).toBe('parent-trace-id');
  });

  it('generates unique traceId when no parent', () => {
    const ctx1 = createTraceContext({ source: 'user' });
    const ctx2 = createTraceContext({ source: 'user' });
    expect(ctx1.traceId).not.toBe(ctx2.traceId);
  });

  it('stores parentSpanId in spanId', () => {
    const ctx = createTraceContext({
      source: 'user',
      parentSpanId: 'span-abc',
    });
    expect(ctx.spanId).toBe('span-abc');
  });
});

describe('serializeTraceContext / deserializeTraceContext', () => {
  it('round-trips a full context', () => {
    const original = createTraceContext({
      source: 'scheduler',
      taskId: 'task-456',
      chatJid: 'slack:C789',
      groupFolder: 'slack_swarm-ingest',
      sessionId: 'session-abc',
    });
    const json = serializeTraceContext(original);
    const parsed = deserializeTraceContext(json);

    expect(parsed).not.toBeNull();
    expect(parsed!.traceId).toBe(original.traceId);
    expect(parsed!.runId).toBe(original.runId);
    expect(parsed!.source).toBe('scheduler');
    expect(parsed!.taskId).toBe('task-456');
    expect(parsed!.chatJid).toBe('slack:C789');
    expect(parsed!.groupFolder).toBe('slack_swarm-ingest');
    expect(parsed!.sessionId).toBe('session-abc');
  });

  it('returns null for invalid JSON', () => {
    expect(deserializeTraceContext('not json')).toBeNull();
  });

  it('returns null for valid JSON without required fields', () => {
    expect(deserializeTraceContext('{}')).toBeNull();
    expect(
      deserializeTraceContext('{"traceId": "a", "source": "user"}'),
    ).toBeNull(); // missing runId
  });

  it('returns null for non-object JSON', () => {
    expect(deserializeTraceContext('"hello"')).toBeNull();
    expect(deserializeTraceContext('42')).toBeNull();
  });
});
