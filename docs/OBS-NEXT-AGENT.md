# OBS-05 + OBS-06: IPC Pipeline & Scheduler Instrumentation — Next Agent Prompt

## Status
- **OBS-01+02 landed** on branch `feat/obs-01-02-langfuse-foundation` (commit `fd31c9b`)
- **OBS-03+04 landed** on branch `feat/obs-03-message-loop` (commit `2e06ea7`)
- Branch `feat/obs-03-message-loop` is based on `feat/obs-01-02-langfuse-foundation`

## What's done
- `src/observability/langfuse.ts` — `initLangfuse()`, `getLangfuse()` (no-op proxy), `shouldSample()`, `shutdownLangfuse()`
- `src/observability/context.ts` — `TraceContext`, `createTraceContext()`, `serializeTraceContext()`, `deserializeTraceContext()`
- `src/index.ts` — OBS-03: per-turn `message-turn` trace with spans for `trigger-gate`, `format-messages`, `agent-dispatch`, `send-message`, plus events for `container-started`, `session-updated`, `error`
- `src/container-runner.ts` — OBS-04: `container-lifecycle` span with `container-spawn`, `mounts-summary`, `stdin-written`, `output-chunk`, `timeout`, `kill`, `exit` events

## Task: OBS-05 — Instrument IPC pipeline

**Branch**: `feat/obs-05-06-ipc-scheduler` (off `feat/obs-03-message-loop`)
**File**: `src/ipc.ts` (572 lines)

### What to implement

Add Langfuse traces/events inside `processIpcFiles()` (the polling callback in `startIpcWatcher()`).

**Event tree per IPC file:**
```
trace("ipc-process", { sessionId: sourceGroup })
  ├─ event("file-read", { type: "message"|"task", sourceGroup })
  ├─ event("auth-check", { authorized: bool, reason? })
  ├─ event("rate-limit", { allowed: bool, type: "source"|"pair" })
  ├─ event("inject-decision", { targetGroup, injected: bool, reason? })
  ├─ event("send-message", { targetJid, textLength })
  └─ event("task-action", { action, taskId? })
```

### Key integration points

1. **Imports**: Add `getLangfuse`, `shouldSample` from `../observability/langfuse.js`.

2. **Message file processing** (line 130): Create trace at start of per-file try block. Use `shouldSample()` to gate. The `parentTrace` from `deserializeTraceContext()` (line 134) can provide `parentTraceId` for cross-agent linking.

3. **Authorization check** (lines 148-210): Event after the `isMain || targetGroup.folder === sourceGroup` check. Record `{ authorized, reason }`. Also event for each rate-limit check (lines 180-192).

4. **Send message** (line 155): Event with `{ targetJid: data.chatJid, textLength: data.text.length }`. NOT text content.

5. **Inject decision** (lines 165-203): Event recording the inject outcome: `{ targetGroup, injected, reason }` where reason is one of: 'no-registered-group', 'self-injection-blocked', 'rate-limit-source', 'rate-limit-pair', 'injected'.

6. **Task file processing** (line 242): Event per task action in `processTaskIpc()`. Record `{ action: data.type, taskId: data.taskId, sourceGroup, authorized }`.

7. **Error/move-to-errors** (lines 213-224, 247-257): Event on catch with sanitized error message. Record whether file was moved to errors dir.

### Important: `processTaskIpc()` is exported (line 273)

The function `processTaskIpc()` is called from two places:
- Inside `processIpcFiles()` (line 245) — trace context available from calling scope
- Potentially from tests

Pass the trace object as an optional parameter to `processTaskIpc()` so it can emit events under the same trace. Add it as the last parameter with type `{ event: (opts: { name: string; metadata: Record<string, unknown> }) => void } | null`.

---

## Task: OBS-06 — Instrument scheduler

**File**: `src/task-scheduler.ts` (293 lines)

### What to implement

Add Langfuse traces/spans inside `runTask()` (line 79).

**Span tree per task execution:**
```
trace("scheduled-task", { metadata: { taskId, groupFolder, scheduleType, cronExpr } })
  ├─ span("task-resolve")       — group lookup + snapshot writes (lines 86-148)
  ├─ span("container-run")      — runContainerAgent() wall time (lines 180-210)
  ├─ span("message-forward")    — sendMessage() within streaming callback (line 199)
  ├─ event("update-task")       — computeNextRun + DB update (lines 242-248)
  └─ event("error")             — on failure (line 228), sanitized message
```

### Key integration points

1. **Imports**: Add `getLangfuse`, `shouldSample` from `./observability/langfuse.js`.

2. **Root trace** (line 83): Create at start of `runTask()`. Use `shouldSample()`. Set `sessionId: task.group_folder`, include `taskId`, `scheduleType`, `scheduleValue` in metadata.

3. **Task resolve span** (lines 86-148): Wraps group folder resolution, group lookup, and snapshot writes. Record outcome: group found or not.

4. **Container run span** (lines 180-210): Wraps `runContainerAgent()`. Record `{ status, durationMs, hasResult }`.

5. **Message forward span** (line 199): Inside streaming callback, wrap `deps.sendMessage()`. Record `{ chatJid, textLength }`.

6. **Update task event** (lines 242-248): After `computeNextRun()`, record `{ taskId, nextRun, status }`.

7. **Error event** (line 228): On catch, record `{ taskId, error: sanitized message }`.

8. **Link to container trace**: The `traceContext` created at line 172 already has `source: 'scheduler'` and `taskId`. Pass `parentTraceId: trace.id` (from the Langfuse trace) into `createTraceContext()` so container spans link back.

### Early returns

`runTask()` has early returns at lines 90-103 (invalid group folder) and 117-131 (group not found). These should get error events on the trace before returning, or skip trace creation entirely since they're configuration errors.

---

## Rules (apply to both)
- Use `getLangfuse()` — never check if null (no-op proxy handles it)
- Use `shouldSample()` once at trace creation — skip all spans if not sampled
- No message text in traces (metadata only unless LANGFUSE_CAPTURE_PROMPTS)
- No secrets in any trace metadata
- Keep existing behavior exactly — spans are observability-only additions

## Acceptance criteria
- Each processed IPC file produces a trace with deterministic event path
- Each scheduled task run produces linked spans with duration and status
- Skipped IPC files (no valid data) produce no trace
- App works identically with LANGFUSE_ENABLED=false
- `tsc --noEmit` passes

## Full plan reference
See `docs/OBS-PLAN.md` for the complete OBS-01 through OBS-11 plan.
