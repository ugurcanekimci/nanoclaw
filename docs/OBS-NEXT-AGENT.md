# OBS-09 + OBS-10: Governance & Tests — Next Agent Prompt

## Status
- **OBS-01+02 landed** on branch `feat/obs-01-02-langfuse-foundation` (commit `fd31c9b`)
- **OBS-03+04 landed** on branch `feat/obs-03-message-loop` (commit `2e06ea7`)
- **OBS-05+06 landed** on branch `feat/obs-05-06-ipc-scheduler` (commit `fc035cd`)
- **OBS-07+08 landed** on current branch (container trace events + MCP tool instrumentation)

## What's done

### NanoClaw host (`src/`)
- `src/observability/langfuse.ts` — `initLangfuse()`, `getLangfuse()` (no-op proxy), `shouldSample()`, `shutdownLangfuse()`
- `src/observability/context.ts` — `TraceContext`, `createTraceContext()`, `serializeTraceContext()`, `deserializeTraceContext()`
- `src/index.ts` — OBS-03: per-turn `message-turn` trace with spans for `trigger-gate`, `format-messages`, `agent-dispatch`, `send-message`
- `src/container-runner.ts` — OBS-04: `container-lifecycle` span + OBS-07: parses `NANOCLAW_TRACE_EVENT` markers from agent stdout, creates `agent:*` events under lifecycle span
- `src/ipc.ts` — OBS-05: `ipc-process` trace with events for file-read, auth-check, send-message, inject-decision, task-action
- `src/task-scheduler.ts` — OBS-06: `scheduled-task` trace with spans for task-resolve, container-run, message-forward

### Container agent-runner (`container/agent-runner/src/index.ts`)
- OBS-07: Emits structured trace events via stdout markers (`---NANOCLAW_TRACE_EVENT---`/`---NANOCLAW_TRACE_EVENT_END---`)
- Events: `agent-start`, `session-init`, `query-start`, `query-end`, `hook-block` (secret-scanner + git-safety), `agent-error`
- Host container-runner parses these markers and creates `agent:*` child events under the container lifecycle span

### Swarm MCP (`swarm/src/mcp/`)
- OBS-08: `src/mcp/observability.ts` — `instrumentTools()` wraps all 14 MCP tool handlers with Langfuse spans
- Each tool call creates a trace (`mcp:{toolName}`) with a span recording duration, status, content item count
- Input keys recorded by default; full I/O when `LANGFUSE_CAPTURE_TOOL_IO=true`
- Applied in `src/mcp/server.ts` via `instrumentTools([...tools])`

---

## Task: OBS-09 — Redaction and governance hardening

**Branch**: `feat/obs-09-10-governance-tests` (off current branch)

### What to implement

1. **Default metadata-only capture** — verify no prompt text or tool I/O appears in traces unless gated env vars are set.

2. **Gated capture env vars** (already partially in place):
   - `LANGFUSE_CAPTURE_PROMPTS=true` — enables prompt text logging in traces (host side)
   - `LANGFUSE_CAPTURE_TOOL_IO=true` — enables MCP tool input/output logging (swarm side, already implemented in OBS-08)

3. **Redaction layer** — Before any payload is emitted to Langfuse, run through redaction filter:
   - Reuse the 13 regex patterns from `container/agent-runner/src/index.ts` (lines 249-280: `SECRET_PATTERNS`)
   - Also check against known secret values from `readSecrets()` (NanoClaw host) or `readEnvFile()` values
   - Create `src/observability/redact.ts` with:
     - `redactMetadata(obj: Record<string, unknown>): Record<string, unknown>` — deep-walks object, replaces string matches with `[REDACTED]`
     - Import and use `SECRET_PATTERNS` (extract to shared module or duplicate — patterns are stable)

4. **Sanitize paths** — Strip home directory prefixes, replace with `~`. Remove mount paths that could leak directory structure.
   - Apply in all `.event()` and `.span()` metadata calls across OBS-03 through OBS-07

5. **Update `.env.example`** with all `LANGFUSE_*` vars and documentation comments.

### Key files to create/modify
- New: `src/observability/redact.ts` (NanoClaw)
- Modify: `src/observability/langfuse.ts` — wrap `getLangfuse()` return to auto-redact (or add helper)
- Modify: All files with `.event()` / `.span()` calls to pass metadata through redaction
- New: `swarm/src/mcp/redact.ts` (Swarm, simpler — just wraps the Langfuse calls in observability.ts)
- Update: `.env.example` in both repos

### Important: shared secret patterns
The `SECRET_PATTERNS` array (13 patterns) lives in `container/agent-runner/src/index.ts`. For OBS-09:
- Extract to a shared file `src/observability/secret-patterns.ts` (NanoClaw host side)
- The container agent-runner can't import from host `src/` (different build), so keep a copy there
- Or: define patterns in a JSON file that both can read

---

## Task: OBS-10 — Tests and trace coverage

### What to implement

1. **Mock Langfuse client** — Create test double in `src/observability/__tests__/helpers.ts`:
   - Records all `trace()`, `span()`, `event()` calls with args
   - Returns chainable objects (mimics real Langfuse client)
   - `getTraces()`, `getSpans()`, `getEvents()` accessors

2. **Unit tests for OBS-01** (`src/observability/__tests__/langfuse.test.ts`):
   - `initLangfuse()` with valid env → returns client
   - `initLangfuse()` with missing env → returns null, `getLangfuse()` returns no-op proxy
   - No-op proxy swallows all calls without error
   - `shutdownLangfuse()` flushes and nulls client
   - `shouldSample()` respects `LANGFUSE_SAMPLE_RATE`

3. **Unit tests for OBS-02** (`src/observability/__tests__/context.test.ts`):
   - `createTraceContext()` for each source type (user, ipc, scheduler)
   - Serialization round-trip: `deserializeTraceContext(serializeTraceContext(ctx))` matches original
   - `deserializeTraceContext()` returns null for invalid JSON
   - `parentTraceId` propagation

4. **Unit tests for OBS-09** (`src/observability/__tests__/redact.test.ts`):
   - Inject known secrets (API keys, tokens) → verify scrubbed
   - Path sanitization: home dir → `~`
   - Deep object traversal
   - Regex patterns catch all 13 secret formats

5. **Integration tests** (can be in existing test files or new):
   - Mock Langfuse, simulate user message → verify trace chain
   - Simulate IPC file → verify events
   - Simulate scheduled task → verify spans

6. **Swarm MCP tests** (`swarm/src/mcp/__tests__/observability.test.ts`):
   - `instrumentTools()` wraps handlers correctly
   - Wrapped handler creates trace + span
   - Error in handler creates error span
   - `LANGFUSE_CAPTURE_TOOL_IO` controls input logging

### Test framework
- NanoClaw: Vitest (already configured, `npx vitest`)
- Swarm: Vitest (already configured, `npm test`)

---

## Rules (apply to both tasks)
- Use `getLangfuse()` — never check if null (no-op proxy handles it)
- No message text in traces (metadata only unless `LANGFUSE_CAPTURE_PROMPTS`)
- No secrets in any trace metadata — that's the whole point of OBS-09
- Keep existing behavior exactly — governance is additive
- Tests must pass: `npm run build && npm test` in both repos

## Acceptance criteria
- **OBS-09**: No secret can appear in any Langfuse trace. Tests prove it.
- **OBS-10**: `npm test` passes in both repos. Trace coverage ≥ 95% of instrumented code paths.
- `tsc --noEmit` passes in both repos

## Full plan reference
See `docs/OBS-PLAN.md` for the complete OBS-01 through OBS-11 plan.
