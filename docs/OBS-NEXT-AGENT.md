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

## Task: OBS-11 — Rollout — COMPLETED

**Branch**: `feat/obs-05-06-ipc-scheduler` (landed alongside prior phases)

### Deliverables

1. **Staged enablement plan** — `docs/observability/langfuse-rollout.md`
   - 3-stage rollout: 10% → 50% → 100% with 24h minimum per stage
   - Go/no-go criteria per stage (error rate, latency, secret leakage checks)
   - Rollback procedures (disable, reduce sampling, disable capture)

2. **Dashboard template** — 7 panels documented in rollout.md:
   - Trace volume by entry path, error rate, p95 duration, agent group breakdown
   - Container lifecycle outcomes, hook block events, MCP tool performance

3. **Alert thresholds** — 5 alert rules with windows and actions

4. **On-call runbook** — `docs/observability/langfuse-runbook.md`:
   - Finding traces by session/group, trace ID, entry path, or error status
   - Full span waterfall reference for all three trace types
   - Host ↔ container correlation guide
   - 5 common diagnostic scenarios with step-by-step resolution
   - Emergency disable/reduce procedures

5. **Environment variables** — `.env.example` updated in both NanoClaw and Swarm repos

## OBS Plan — Complete

All 11 tasks (OBS-01 through OBS-11) are now implemented:
- Phase 1: Foundation (OBS-01+02) — Langfuse client + trace context
- Phase 2: Host instrumentation (OBS-03+04+05+06) — message loop, container, IPC, scheduler
- Phase 3: Container + MCP (OBS-07+08) — agent-runner events, MCP tool wrapping
- Phase 4: Governance + tests (OBS-09+10) — redaction, 36 tests
- Phase 5: Rollout (OBS-11) — documentation, staged plan, runbook

## Full plan reference
See `docs/OBS-PLAN.md` for the complete OBS-01 through OBS-11 plan.
