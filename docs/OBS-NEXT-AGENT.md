# OBS-11: Rollout — Next Agent Prompt

## Status
- **OBS-01+02** landed (commit `fd31c9b`) — Langfuse client wrapper + trace context propagation
- **OBS-03+04** landed (commit `2e06ea7`) — Host message loop + container lifecycle instrumentation
- **OBS-05+06** landed (commit `fc035cd`) — IPC pipeline + scheduler instrumentation
- **OBS-07+08** landed (commit `cb54d27` nanoclaw, `81f41bf` swarm) — Agent-runner trace events + MCP tool instrumentation
- **OBS-09+10** landed — Redaction governance + tests (36 tests passing)

## What's done

### Phase 1 — Foundation
- `src/observability/langfuse.ts` — `initLangfuse()`, `getLangfuse()` (no-op proxy + auto-redacting wrapper), `shouldSample()`, `shutdownLangfuse()`
- `src/observability/context.ts` — `TraceContext`, `createTraceContext()`, `serializeTraceContext()`, `deserializeTraceContext()`

### Phase 2 — Host Instrumentation
- `src/index.ts` — `message-turn` trace with spans (trigger-gate, format-messages, agent-dispatch, send-message)
- `src/container-runner.ts` — `container-lifecycle` span + agent trace event parser
- `src/ipc.ts` — `ipc-process` trace with events (file-read, auth-check, send-message, inject-decision, task-action)
- `src/task-scheduler.ts` — `scheduled-task` trace with spans (task-resolve, container-run, message-forward)

### Phase 3 — Container + MCP
- `container/agent-runner/src/index.ts` — Emits `---NANOCLAW_TRACE_EVENT---` stdout markers (agent-start, session-init, query-start, query-end, hook-block, agent-error)
- `swarm/src/mcp/observability.ts` — `instrumentTools()` wraps all 14 MCP tool handlers with Langfuse traces

### Phase 4 — Governance + Tests
- `src/observability/redact.ts` — `redactString()`, `redactMetadata()` — 13 secret regex patterns + home dir sanitization
- `src/observability/langfuse.ts` — `getLangfuse()` returns auto-redacting proxy (wraps trace/span/event/generation calls)
- Prompt text gated behind `LANGFUSE_CAPTURE_PROMPTS=true` (default false)
- Tool I/O gated behind `LANGFUSE_CAPTURE_TOOL_IO=true` (default false)
- Tests: 29 nanoclaw (redact: 19, context: 10) + 7 swarm (MCP observability)

---

## Task: OBS-11 — Rollout

**Branch**: `feat/obs-11-rollout`
**Files**: new `docs/observability/langfuse-rollout.md`

### What to implement

1. **Staged enablement plan** via `LANGFUSE_SAMPLE_RATE`:
   - Stage 1: `0.1` (10% of traces) — run for 24h, monitor for errors
   - Stage 2: `0.5` (50%) — run for 24h
   - Stage 3: `1.0` (100%) — full rollout
   - Each stage: check Langfuse dashboard for trace volume, error rate, p95 duration

2. **Dashboard template** — Document a Langfuse dashboard config showing:
   - Trace volume by entry path (user, ipc, scheduler)
   - Error rate per trace type
   - p95 duration per trace type
   - Agent group breakdown
   - Hook block events (secret-scanner, git-safety)

3. **Alert thresholds**:
   - Trace error rate > 5%
   - p95 duration > 60s
   - Langfuse client errors > 10/min

4. **On-call runbook** — Write `docs/observability/langfuse-runbook.md`:
   - How to find a trace by session/group
   - How to read the span waterfall
   - How to correlate host ↔ container spans (trace events)
   - Emergency: disable tracing (`LANGFUSE_ENABLED=false`, restart NanoClaw)
   - How to enable prompt/tool-IO capture for debugging

5. **Environment variables reference** — update `.env.example` in both repos:
   ```
   LANGFUSE_ENABLED=true
   LANGFUSE_PUBLIC_KEY=pk-lf-...
   LANGFUSE_SECRET_KEY=sk-lf-...
   LANGFUSE_BASEURL=http://localhost:3000
   LANGFUSE_SAMPLE_RATE=1.0
   LANGFUSE_CAPTURE_PROMPTS=false
   LANGFUSE_CAPTURE_TOOL_IO=false
   ```

### Acceptance criteria
- Runbook enables on-call to diagnose failures end-to-end from trace IDs
- `.env.example` documents all LANGFUSE_ vars
- Staged rollout plan with clear go/no-go criteria per stage

## Full plan reference
See `docs/OBS-PLAN.md` for the complete OBS-01 through OBS-11 plan.
