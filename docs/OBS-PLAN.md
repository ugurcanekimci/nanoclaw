# OBS — Langfuse Observability Implementation Plan

**Repo scope**: NanoClaw (host runtime + container agent-runner) and Swarm (API + MCP tools)
**Goal**: End-to-end distributed tracing across user→host→container→MCP→IPC→scheduler paths

---

## Current State

### Already done (Swarm — OBS-00)
- `src/tracing.ts` — Langfuse singleton (`initTracing()`, `getLangfuse()`, `shutdownTracing()`)
- `src/api/routes.ts` — HTTP middleware traces all `/api/*` endpoints
- `src/index.ts` — Init at startup, flush on SIGTERM/SIGINT
- `get_trace_url` MCP tool returns dashboard URL
- Langfuse `3.38.6` pinned in `package.json`

### Not yet done
- No trace context propagation to NanoClaw containers
- No per-tool MCP instrumentation
- No IPC/scheduler/container-lifecycle tracing
- No redaction layer for telemetry
- No tests for observability code

---

## Environment Variables (all tiers)

```
LANGFUSE_ENABLED=true              # master kill switch
LANGFUSE_PUBLIC_KEY=...
LANGFUSE_SECRET_KEY=...
LANGFUSE_BASEURL=...
LANGFUSE_SAMPLE_RATE=1.0           # 0.0–1.0 rollout control
LANGFUSE_CAPTURE_PROMPTS=false     # gated: log prompt text
LANGFUSE_CAPTURE_TOOL_IO=false     # gated: log tool inputs/outputs
```

---

## Phase 1 — Foundation (OBS-01 + OBS-02)

**Branch**: `feat/obs-01-02-langfuse-foundation`
**PR**: single foundational PR

### OBS-01: Shared Langfuse client wrapper (NanoClaw host)

**Files**: new `src/observability/langfuse.ts`, `src/config.ts`, `src/logger.ts`

| Step | Detail |
|------|--------|
| 1 | Add env vars to `src/config.ts`: `LANGFUSE_ENABLED`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASEURL`, `LANGFUSE_SAMPLE_RATE`, `LANGFUSE_CAPTURE_PROMPTS`, `LANGFUSE_CAPTURE_TOOL_IO` |
| 2 | Create `src/observability/langfuse.ts` with `initLangfuse()` → returns client or no-op stub. Validates config (key pair required when enabled). Sample rate checked per-trace. `shutdownLangfuse()` flushes + closes. Singleton via `getLangfuse()`. |
| 3 | No-op fallback: when disabled or env missing, `getLangfuse()` returns a proxy that swallows all calls (no crashes, no branching at call sites). |
| 4 | Wire `initLangfuse()` into `src/index.ts` startup (after DB init, before channel connect). Wire `shutdownLangfuse()` into existing SIGTERM/SIGINT handler (before `queue.shutdown()`). |
| 5 | Log Langfuse init status in `src/logger.ts` at info level. |

**Acceptance**:
- App starts normally with all LANGFUSE_ vars unset → no errors, no traces emitted
- App starts with valid vars → Langfuse initialized, logged
- App starts with invalid vars (e.g. key but no secret) → warning logged, no-op fallback
- Langfuse service down → no crash, degraded silently

### OBS-02: Trace context contract and propagation

**Files**: new `src/observability/context.ts`, `src/types.ts`, `src/container-runner.ts`, `src/ipc.ts`, `src/task-scheduler.ts`, `container/agent-runner/src/index.ts`

**TraceContext type** (in `src/observability/context.ts`):
```typescript
export interface TraceContext {
  traceId: string;        // Langfuse trace ID
  spanId?: string;        // parent span ID for linking
  sessionId?: string;     // Langfuse session (maps to NanoClaw group)
  runId?: string;         // unique per container run
  source: 'user' | 'ipc' | 'scheduler';
  taskId?: string;        // scheduled task ID
  chatJid?: string;       // originating chat
  groupFolder?: string;   // NanoClaw group folder
}
```

| Step | Detail |
|------|--------|
| 1 | Create `src/observability/context.ts` with `TraceContext` interface, `createTraceContext(source, metadata)` factory, `serializeContext(ctx)` / `deserializeContext(json)` helpers. |
| 2 | Add `TraceContext` to `src/types.ts` (re-export from observability). |
| 3 | **User message path** (`src/index.ts` L202): Create trace context before `runContainerAgent()`, pass as new field on `ContainerInput`. |
| 4 | **IPC path** (`src/ipc.ts` L132): Create trace context with `source: 'ipc'`, include in `injectPrompt()` call chain. Read trace context from IPC message JSON if present (cross-agent linking). |
| 5 | **Scheduler path** (`src/task-scheduler.ts` L172): Create trace context with `source: 'scheduler'`, `taskId` from task record, pass to `runContainerAgent()`. |
| 6 | **Container runner** (`src/container-runner.ts`): Accept `traceContext` in `ContainerInput` interface (L37-45). Serialize into env var `NANOCLAW_TRACE_CONTEXT` passed to container (L228-268). Also include in stdin JSON. |
| 7 | **Agent runner** (`container/agent-runner/src/index.ts`): Read `traceContext` from `ContainerInput` (L22-31). Store for later use by OBS-07. No instrumentation yet — just propagation. |

**Acceptance**:
- Trace context present in container env + stdin for all three entry paths
- `npm run build` passes in both repos
- No runtime behavior change — context is created and passed but not yet consumed

---

## Phase 2 — Host Instrumentation (OBS-03 through OBS-06)

Each task is one PR. No inter-dependencies — can land in any order after Phase 1.

### OBS-03: Host message loop spans/events

**Branch**: `feat/obs-03-message-loop`
**Files**: `src/index.ts`

**Spans created per group turn**:
```
trace("message-turn", { sessionId: groupFolder, input: { chatJid, messageCount } })
  ├─ span("queue-wait")      — time in GroupQueue before processing
  ├─ span("trigger-gate")    — trigger pattern + sender check
  ├─ span("format-messages") — message formatting
  ├─ span("agent-dispatch")  — runContainerAgent() wall time
  │   └─ events for streaming output chunks
  ├─ span("send-message")    — outbound message delivery
  └─ event("error") or event("rollback") — on failure
```

| Step | Detail |
|------|--------|
| 1 | Import `getLangfuse()` and `createTraceContext()` at top of message processing function. |
| 2 | Create root trace when `queue.setProcessMessagesFn()` callback fires (L124). End trace after message send completes or errors. |
| 3 | Wrap trigger-gate check (L140-165) in span. Record outcome (triggered/skipped/cooldown). |
| 4 | Wrap `runContainerAgent()` call (L202) in span. Pass trace context. Record container name, group, exit status. |
| 5 | Wrap `sendMessage()` calls (L215-235) in span. Record target JID, message length. |
| 6 | On error: create error event with sanitized message (no secrets). |
| 7 | On session update: record as event with new session ID. |

**Acceptance**: Each processed turn produces linked spans with status and duration in Langfuse.

### OBS-04: Container lifecycle instrumentation

**Branch**: `feat/obs-04-container-lifecycle`
**Files**: `src/container-runner.ts`

**Spans/events within `runContainerAgent()`**:
```
span("container-lifecycle", { metadata: { containerName, groupFolder } })
  ├─ event("mounts-summary")   — mount count + types (NO paths with secrets)
  ├─ span("container-spawn")   — from spawn() to first stdout byte
  ├─ event("stdin-written")    — input JSON size (not content)
  ├─ span("stream-output")     — stdout parsing loop
  │   ├─ event("output-chunk") — per OUTPUT_START/END pair, size only
  │   └─ event("stderr-line")  — non-sensitive stderr (filtered)
  ├─ event("timeout")          — if timeout fires, with configured limit
  ├─ event("kill")             — if forceful kill needed
  └─ event("exit", { exitCode, outcome: "success"|"error"|"timeout"|"killed" })
```

| Step | Detail |
|------|--------|
| 1 | Accept `traceContext` from caller. Create child span under parent trace. |
| 2 | Log mounts summary: count per type (project/group/global/extra), NO full paths. |
| 3 | Span around `spawn()` call (L339) to first data on stdout/stderr. |
| 4 | Events for each output chunk: size in bytes, sequence number. |
| 5 | On timeout (L439-462): event with timeout value, then outcome classification. |
| 6 | On exit (L573-592): event with exit code, classify outcome. |
| 7 | End lifecycle span with outcome in metadata. |

**Acceptance**: Every `runContainerAgent()` produces a lifecycle trace with outcome classification.

### OBS-05: IPC pipeline instrumentation

**Branch**: `feat/obs-05-ipc-pipeline`
**Files**: `src/ipc.ts`

**Events per IPC file processed**:
```
trace("ipc-process", { sessionId: sourceGroup })
  ├─ event("file-read", { type: "message"|"task", sourceGroup })
  ├─ event("auth-check", { authorized: bool, reason? })
  ├─ event("rate-limit", { allowed: bool, remaining, window })
  ├─ event("inject-decision", { targetGroup, injected: bool })
  ├─ event("send-message", { targetJid, textLength })
  └─ event("task-action", { action, taskId? })
```

| Step | Detail |
|------|--------|
| 1 | Create trace per IPC file in `startIpcWatcher()` polling loop (L91). |
| 2 | Event after authorization check (L132-177): authorized/blocked + reason. |
| 3 | Event after rate-limit check (L34-60): allowed/dropped + remaining quota. |
| 4 | Event on `injectPrompt()` (L179): target group, injected flag. |
| 5 | Event on `sendMessage()`: target JID, text length (NOT text content). |
| 6 | `processTaskIpc()` (L257-556): event per task action (schedule/pause/resume/cancel/update). |
| 7 | Move processed file: event with outcome (success/error directory). |

**Acceptance**: Every IPC file produces one deterministic event path in Langfuse.

### OBS-06: Scheduler run instrumentation

**Branch**: `feat/obs-06-scheduler`
**Files**: `src/task-scheduler.ts`

**Spans per due task execution**:
```
trace("scheduled-task", { metadata: { taskId, groupFolder, cronExpr } })
  ├─ span("task-resolve")       — find group, validate, write snapshots
  ├─ span("container-run")      — runContainerAgent() (links to OBS-04 span)
  ├─ span("message-forward")    — sendMessage() with result
  ├─ event("update-task")       — computeNextRun(), DB update
  └─ event("error")             — on failure, with sanitized message
```

| Step | Detail |
|------|--------|
| 1 | Create root trace in `runTask()` (L78) with task metadata. |
| 2 | Span for group resolution + snapshot writes (L106-147). |
| 3 | Span around `runContainerAgent()` (L172-200), passing trace context. |
| 4 | Span for message forwarding (L163-169). |
| 5 | Event for next-run computation (L232-238) with next timestamp. |
| 6 | Error handling: event with error class, message (no stack traces in telemetry). |

**Acceptance**: Scheduled tasks appear as traceable runs with `task_id` and `next_run` metadata.

---

## Phase 3 — Container + MCP Instrumentation (OBS-07, OBS-08)

### OBS-07: In-container agent runner instrumentation

**Branch**: `feat/obs-07-agent-runner`
**Files**: `container/agent-runner/src/index.ts`

**Note**: The container has no direct Langfuse client (no secret key in container). Instead, it emits structured trace events via stdout that the host collects in OBS-04's stream parser.

**Alternative**: Pass `LANGFUSE_PUBLIC_KEY` only and use Langfuse's client-side SDK, or emit trace JSON that the host stitches. Decision: **emit structured events via stdout** — simpler, no new dependency in container.

**Event protocol** (new markers alongside existing OUTPUT markers):
```
---NANOCLAW_TRACE_EVENT---
{"spanName":"query-iteration","iteration":1,"durationMs":3200,"resultType":"text","tokenCount":1500}
---NANOCLAW_TRACE_EVENT_END---
```

| Step | Detail |
|------|--------|
| 1 | Read `traceContext` from `ContainerInput`. Store as module-level state. |
| 2 | Emit trace event at `runQuery()` start (L677): iteration number, prompt length (not content). |
| 3 | Emit trace event at `runQuery()` end (L813): duration, result type, output size. |
| 4 | Emit event for close-sentinel detection and resume points. |
| 5 | Emit event for hook block/redact actions (PreToolUse secret scanner). |
| 6 | **Host side** (`src/container-runner.ts`): Parse `NANOCLAW_TRACE_EVENT` markers in stdout stream. Create child spans/events under container lifecycle span from OBS-04. |

**Acceptance**: One trace chain across host + container for a single conversation run. Query iterations visible as child spans.

### OBS-08: MCP tool-level instrumentation

**Branch**: `feat/obs-08-mcp-tools`
**Files**: `src/mcp/server.ts` (Swarm), new `src/observability/mcp.ts` (Swarm)

| Step | Detail |
|------|--------|
| 1 | Create `src/observability/mcp.ts` with `wrapToolHandler(name, handler)` higher-order function. |
| 2 | Wrapper creates child span under current trace, records: tool name, input schema keys (not values unless `LANGFUSE_CAPTURE_TOOL_IO`), start time. |
| 3 | On success: end span with output size, status "ok", duration. |
| 4 | On error: end span with error event, exception class + sanitized message. |
| 5 | Apply wrapper to all 14 tool handlers in `src/mcp/server.ts`. |
| 6 | For batch tools (`batch_fetch_transcripts`): create sub-spans per item. |

**Acceptance**: Each MCP tool call visible as a child span with timing and status.

---

## Phase 4 — Governance + Testing (OBS-09 + OBS-10)

**Branch**: `feat/obs-09-10-governance-tests`
**PR**: single PR

### OBS-09: Redaction and governance hardening

**Files**: `container/agent-runner/src/index.ts`, `src/observability/langfuse.ts`, `.env.example`

| Step | Detail |
|------|--------|
| 1 | **Default**: metadata-only capture — no prompt text, no tool input/output in traces. |
| 2 | **Gated capture**: `LANGFUSE_CAPTURE_PROMPTS=true` enables prompt logging. `LANGFUSE_CAPTURE_TOOL_IO=true` enables tool I/O logging. Both default false. |
| 3 | **Redaction layer**: Before any payload is emitted to Langfuse, run through redaction filter. Reuse the 13 regex patterns from PreToolUse secret scanner hook + known secret values from `readSecrets()`. |
| 4 | **Sanitize paths**: Strip home directory prefixes, replace with `~`. Remove mount paths that could leak directory structure. |
| 5 | Update `.env.example` with all LANGFUSE_ vars and documentation comments. |

**Acceptance**: Tests prove no secret leakage in exported telemetry (regex patterns, known values, path patterns).

### OBS-10: Tests and trace coverage

**Files**: new `src/observability/__tests__/langfuse.test.ts`, updates in existing test files

| Step | Detail |
|------|--------|
| 1 | **Mock Langfuse client**: Create test double that records all trace/span/event calls. |
| 2 | **Unit tests for OBS-01**: init with/without env vars, no-op fallback, shutdown flush. |
| 3 | **Unit tests for OBS-02**: context creation for each source, serialization round-trip. |
| 4 | **Integration tests**: Simulate user message → container run → output. Verify trace chain. Simulate IPC file → processing. Verify events. Simulate scheduled task → execution. Verify spans. |
| 5 | **Redaction tests**: Inject known secrets into payloads, verify they're scrubbed before Langfuse emit. |
| 6 | **Coverage metric**: Assert >= 95% of code paths that should emit traces actually do. |

**Acceptance**: `npm run build && npm test` passes in both repos. Trace coverage >= 95%.

---

## Phase 5 — Rollout (OBS-11)

**Branch**: `feat/obs-11-rollout`
**Files**: new `docs/observability/langfuse-rollout.md`, `README.md`

| Step | Detail |
|------|--------|
| 1 | Staged enablement via `LANGFUSE_SAMPLE_RATE`: 0.1 → 0.5 → 1.0. Each stage runs for 24h minimum before escalation. |
| 2 | Dashboard definitions: template for Langfuse dashboard showing trace volume, error rate, p95 duration per entry path. |
| 3 | Alert thresholds: trace error rate > 5%, p95 duration > 60s, Langfuse client errors > 10/min. |
| 4 | Runbook: on-call can diagnose failures from trace IDs. Covers: finding trace by session/group, reading span waterfall, correlating host↔container spans, disabling tracing in emergency. |
| 5 | Update `README.md` with observability section and env var reference. |

**Acceptance**: On-call can diagnose failures end-to-end from trace IDs.

---

## Execution Order & Dependencies

```
OBS-01 + OBS-02 ─────────────────────────────────────────── Phase 1 (foundation)
       │
       ├─→ OBS-03 (message loop)  ─┐
       ├─→ OBS-04 (container)     ─┤
       ├─→ OBS-05 (IPC)           ─┼─── Phase 2 (parallel, any order)
       └─→ OBS-06 (scheduler)     ─┘
                                    │
                     OBS-04 ───────→├─→ OBS-07 (agent runner, depends on OBS-04 stream parser)
                                    └─→ OBS-08 (MCP tools, independent)  ── Phase 3
                                         │
                                         ├─→ OBS-09 + OBS-10 (governance + tests) ── Phase 4
                                         │
                                         └─→ OBS-11 (rollout)                     ── Phase 5
```

## Key Design Decisions

1. **No Langfuse client in containers** — containers emit structured trace events via stdout markers; host stitches them into the trace tree. Avoids leaking secret key into containers.

2. **No-op proxy pattern** — `getLangfuse()` returns a no-op proxy when disabled, so call sites never branch on `if (langfuse)`.

3. **Metadata-only by default** — prompts and tool I/O only captured when explicitly enabled via env vars. Redaction layer runs regardless.

4. **Sample rate at trace creation** — decided once per trace, not per span. Ensures complete or absent traces (no partial).

5. **Reuse existing secret scanner** — the 13 regex patterns from PreToolUse hook are the redaction source of truth for OBS-09.

6. **Swarm tracing.ts coexists** — Swarm's existing `src/tracing.ts` handles the Hono API layer. NanoClaw's `src/observability/langfuse.ts` handles the host runtime. Both use the same Langfuse project but different trace roots.
