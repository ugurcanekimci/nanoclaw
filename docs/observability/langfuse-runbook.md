# Langfuse Observability — On-Call Runbook

## Quick Reference

| Action | Command |
|--------|---------|
| NanoClaw logs | `tail -f ~/nanoclaw/logs/nanoclaw.log` |
| NanoClaw error logs | `tail -f ~/nanoclaw/logs/nanoclaw.error.log` |
| Restart NanoClaw | `launchctl kickstart -k gui/$(id -u)/com.nanoclaw` |
| Disable tracing | Set `LANGFUSE_ENABLED=false`, restart |
| Reduce sampling | Set `LANGFUSE_SAMPLE_RATE=0.1`, restart |

---

## 1. Finding a Trace

### By session/group

Every NanoClaw group maps to a Langfuse session ID (`sessionId = groupFolder`).

In the Langfuse UI:
1. Go to **Traces**
2. Filter by **Session** → enter the group folder name (e.g., `slack_swarm-main`)
3. Sort by timestamp descending

### By trace ID

If you have a trace ID from logs:
1. Go to **Traces**
2. Paste the trace ID in the search bar
3. Or use the URL: `{LANGFUSE_BASEURL}/project/{projectId}/traces/{traceId}`

### By entry path

Filter by trace name:
- `message-turn` — user messages processed through the message loop
- `ipc-process` — inter-agent IPC file processing
- `scheduled-task` — cron/scheduled task execution

### By error

1. Go to **Traces** → filter **Status: Error**
2. Or filter traces containing events named `error`

---

## 2. Reading the Span Waterfall

### Message turn (`message-turn`)

```
message-turn (root trace)
├── trigger-gate        — Did the message pass trigger/sender checks?
├── format-messages     — Message formatting before agent dispatch
├── agent-dispatch      — Full container run wall time
│   └── container-lifecycle
│       ├── container-spawn    — Time to spawn container process
│       ├── stream-output      — Stdout parsing (includes trace events)
│       │   ├── agent-start    — Agent runner initialized
│       │   ├── session-init   — Claude session created
│       │   ├── query-start    — SDK query() call begins
│       │   ├── query-end      — SDK query() call completes
│       │   └── hook-block     — PreToolUse hook blocked a tool call
│       └── exit               — Container exit with code + outcome
└── send-message        — Outbound message delivery
```

**Key things to check**:
- `trigger-gate` outcome: was the message triggered or skipped?
- `agent-dispatch` duration: is the container run slow?
- `container-lifecycle` → `exit` metadata: check `outcome` (success/error/timeout/killed)
- `query-start` to `query-end` duration: is the model call slow?
- `hook-block` events: was a tool call blocked by the secret scanner?

### IPC process (`ipc-process`)

```
ipc-process (root trace)
├── file-read          — IPC file type and source group
├── auth-check         — Authorization result + reason
├── rate-limit         — Rate limit check (if applicable)
├── inject-decision    — Was prompt injected into target group?
├── send-message       — Cross-channel message delivery
└── task-action        — Scheduled task CRUD operation
```

**Key things to check**:
- `auth-check` → `authorized: false`: why was IPC blocked?
- `inject-decision`: did the prompt reach the target group?
- `task-action`: which task operation was performed?

### Scheduled task (`scheduled-task`)

```
scheduled-task (root trace)
├── task-resolve       — Group resolution + snapshot writes
├── container-run      — Agent execution (links to container-lifecycle)
├── message-forward    — Result delivery
└── update-task        — Next run computation
```

**Key things to check**:
- `task-resolve` errors: is the group folder valid?
- `container-run` duration: is the scheduled task slow?
- `update-task` → `nextRun`: when will it run next?

---

## 3. Correlating Host and Container Spans

Container agents emit trace events via `---NANOCLAW_TRACE_EVENT---` stdout markers. The host's container-runner parses these and creates child spans under the `container-lifecycle` span.

**How to correlate**:
1. Find the `message-turn` trace
2. Expand `agent-dispatch` → `container-lifecycle` → `stream-output`
3. Child events (`agent-start`, `query-start`, `query-end`, etc.) are from inside the container
4. The `traceId` and `runId` link host and container events

**If container events are missing**:
- Check if the container started successfully (`container-spawn` span)
- Check stderr for agent-runner errors
- Verify `NANOCLAW_TRACE_CONTEXT` env var was passed to the container

---

## 4. Common Diagnostic Scenarios

### Container timing out

1. Find the trace → `container-lifecycle` → look for `timeout` event
2. Check `query-start` → `query-end` duration — is the model provider slow?
3. Check if multiple query iterations occurred (iteration count in metadata)
4. Check NanoClaw logs for the container name and timeout value

### MCP tool failing (Swarm)

1. Find traces from `instrumentTools()` — filter spans by tool name
2. Check span status and error events
3. Enable `LANGFUSE_CAPTURE_TOOL_IO=true` temporarily to see inputs/outputs
4. Check Swarm logs: `tail -f ~/swarm/logs/swarm.log`

### IPC messages not reaching target

1. Find `ipc-process` traces for the source group
2. Check `auth-check` — is the source authorized for the target?
3. Check `rate-limit` — has the source hit the rate limit?
4. Check `inject-decision` — was `injected: false`? Check the reason.

### Secret scanner blocking legitimate tool calls

1. Find traces with `hook-block` events
2. Check `metadata.hookType` — should be `secret-scanner`
3. The blocked content is NOT logged (by design)
4. Check the container's PreToolUse hook patterns in `agent-runner/src/index.ts`
5. If a false positive: update the secret scanner regex patterns

### High error rate across all traces

1. Check Langfuse service health (is Langfuse itself down?)
2. Check NanoClaw logs for Langfuse client errors
3. Check model provider status (Anthropic, Ollama, xAI)
4. If Langfuse is the problem: disable with `LANGFUSE_ENABLED=false`

---

## 5. Emergency Procedures

### Disable all tracing immediately

```bash
# Edit the environment (via 1Password template or direct env)
LANGFUSE_ENABLED=false

# Restart NanoClaw
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

The no-op proxy ensures zero overhead when disabled. No code changes needed.

### Reduce tracing volume

```bash
LANGFUSE_SAMPLE_RATE=0.1    # Only 10% of traces
LANGFUSE_CAPTURE_PROMPTS=false
LANGFUSE_CAPTURE_TOOL_IO=false
```

Restart to apply.

### Langfuse service is down

NanoClaw continues operating normally. The Langfuse client fails silently (no-op proxy pattern). Traces are lost during the outage but no functional impact.

To confirm: check NanoClaw logs for Langfuse connection warnings. Messages continue to be processed.

---

## 6. Enabling Debug Capture

For temporary deep debugging:

```bash
LANGFUSE_CAPTURE_PROMPTS=true     # See prompt text (auto-redacted)
LANGFUSE_CAPTURE_TOOL_IO=true     # See MCP tool I/O (auto-redacted)
```

**Important**:
- Always disable after the debugging session
- The auto-redacting proxy scrubs 13 secret patterns + home directory paths
- But prompt text still increases trace storage significantly
- Review captured traces to confirm no sensitive data leaked through redaction gaps
