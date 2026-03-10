# Langfuse Observability — Rollout Plan

## Overview

NanoClaw and Swarm have full Langfuse instrumentation across all code paths:
- Host message loop, container lifecycle, IPC pipeline, task scheduler (NanoClaw)
- Agent-runner trace events emitted via stdout markers (container)
- MCP tool-level instrumentation with `instrumentTools()` wrapper (Swarm)
- Auto-redacting proxy on all Langfuse calls — 13 secret regex patterns + home dir sanitization
- Prompt/tool-IO capture gated behind explicit env vars (default off)

This document covers staged enablement, dashboard setup, alert thresholds, and rollback.

---

## Environment Variables

All variables apply to the NanoClaw host process. Containers do **not** receive Langfuse credentials.

| Variable | Default | Description |
|----------|---------|-------------|
| `LANGFUSE_ENABLED` | `false` | Master kill switch. Set `true` to enable tracing. |
| `LANGFUSE_PUBLIC_KEY` | — | Langfuse project public key (`pk-lf-...`) |
| `LANGFUSE_SECRET_KEY` | — | Langfuse project secret key (`sk-lf-...`) |
| `LANGFUSE_BASEURL` | `https://cloud.langfuse.com` | Langfuse API endpoint (use `http://localhost:3000` for self-hosted) |
| `LANGFUSE_SAMPLE_RATE` | `1.0` | Fraction of traces to capture (0.0–1.0). Decided per-trace, not per-span. |
| `LANGFUSE_CAPTURE_PROMPTS` | `false` | When `true`, log prompt text in traces. Redaction still applies. |
| `LANGFUSE_CAPTURE_TOOL_IO` | `false` | When `true`, log MCP tool inputs/outputs. Redaction still applies. |

**Swarm** uses its own `src/tracing.ts` for the Hono API layer with the same Langfuse project. Both trace roots coexist.

---

## Staged Enablement

### Prerequisites

Before Stage 1:
- [ ] Langfuse instance running (cloud or self-hosted)
- [ ] `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` stored in 1Password `Swarm` vault
- [ ] `config/nanoclaw.env.tpl` updated with `op://Swarm/langfuse/*` references
- [ ] NanoClaw build passes: `npm run build && npm test`

### Stage 1 — Canary (10%)

```bash
LANGFUSE_ENABLED=true
LANGFUSE_SAMPLE_RATE=0.1
LANGFUSE_CAPTURE_PROMPTS=false
LANGFUSE_CAPTURE_TOOL_IO=false
```

**Duration**: 24 hours minimum

**Go criteria**:
- [ ] Traces appear in Langfuse dashboard for all three entry paths (user, ipc, scheduler)
- [ ] No Langfuse client errors in NanoClaw logs (`grep -i langfuse logs/nanoclaw.log`)
- [ ] No increase in message processing latency (p95 < 2s overhead)
- [ ] No container spawn failures attributable to tracing
- [ ] Redaction working: spot-check 10 traces for absence of secrets/home paths

**No-go criteria** (rollback to Stage 0):
- Langfuse client errors > 10/min sustained
- Message processing p95 increases by > 5s
- Any secret material visible in trace metadata

### Stage 2 — Partial (50%)

```bash
LANGFUSE_SAMPLE_RATE=0.5
```

**Duration**: 24 hours minimum

**Go criteria**:
- [ ] All Stage 1 criteria still hold at 5x volume
- [ ] Dashboard shows balanced trace distribution across agent groups
- [ ] IPC cross-agent trace linking works (verify parent span IDs)
- [ ] Scheduled task traces include `taskId` and `nextRun` metadata

**No-go criteria**: Same as Stage 1, scaled to higher volume.

### Stage 3 — Full (100%)

```bash
LANGFUSE_SAMPLE_RATE=1.0
```

**Duration**: Ongoing

**Go criteria**:
- [ ] All previous criteria hold
- [ ] On-call has successfully used traces to diagnose at least one issue
- [ ] Dashboard alerts configured (see Alert Thresholds below)

### Optional: Debug capture

Enable temporarily for debugging specific issues:

```bash
LANGFUSE_CAPTURE_PROMPTS=true    # see prompt text (redacted)
LANGFUSE_CAPTURE_TOOL_IO=true    # see MCP tool inputs/outputs (redacted)
```

**Always disable after debugging session.** These increase trace storage significantly.

---

## Dashboard Template

Create a Langfuse dashboard with these panels:

### Panel 1: Trace Volume by Entry Path
- **Filter**: trace name in (`message-turn`, `ipc-process`, `scheduled-task`)
- **Group by**: trace name
- **Metric**: count per 1h bucket
- **Purpose**: Verify all paths are instrumented and traffic is balanced

### Panel 2: Error Rate by Trace Type
- **Filter**: traces with error events or non-zero exit codes
- **Group by**: trace name
- **Metric**: error count / total count, per 1h bucket
- **Alert**: > 5% sustained for 15 minutes

### Panel 3: p95 Duration by Trace Type
- **Filter**: all traces
- **Group by**: trace name
- **Metric**: p95 of trace duration, per 1h bucket
- **Alert**: > 60s sustained for 15 minutes

### Panel 4: Agent Group Breakdown
- **Filter**: `message-turn` traces
- **Group by**: `metadata.groupFolder`
- **Metric**: count per 1h bucket
- **Purpose**: Verify all groups are active and producing traces

### Panel 5: Container Lifecycle Outcomes
- **Filter**: spans named `container-lifecycle`
- **Group by**: `metadata.outcome` (success / error / timeout / killed)
- **Metric**: count per 1h bucket
- **Purpose**: Spot container stability issues

### Panel 6: Hook Block Events
- **Filter**: trace events with name `hook-block`
- **Group by**: `metadata.hookType` (secret-scanner, git-safety)
- **Metric**: count per 1h bucket
- **Purpose**: Monitor security hook activity inside containers

### Panel 7: MCP Tool Performance (Swarm)
- **Filter**: spans from `instrumentTools()` wrapper
- **Group by**: `metadata.tool`
- **Metric**: p95 duration + error rate per tool
- **Purpose**: Identify slow or failing MCP tools

---

## Alert Thresholds

| Metric | Threshold | Window | Action |
|--------|-----------|--------|--------|
| Trace error rate | > 5% | 15 min sustained | Page on-call, check runbook |
| p95 trace duration | > 60s | 15 min sustained | Investigate container or MCP tool slowness |
| Langfuse client errors | > 10/min | 5 min sustained | Check Langfuse service health; consider `LANGFUSE_ENABLED=false` |
| Container timeout rate | > 10% | 1h sustained | Check container resources, model provider latency |
| Zero traces received | 30 min | — | Verify NanoClaw is running, check Langfuse connectivity |

---

## Rollback

### Emergency disable

```bash
# In .env or environment:
LANGFUSE_ENABLED=false
```

Then restart NanoClaw:
```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

Tracing stops immediately. No code changes required. All call sites use the no-op proxy.

### Reduce sampling

If full tracing causes performance issues but you want to keep some visibility:
```bash
LANGFUSE_SAMPLE_RATE=0.1
```

Restart NanoClaw to apply.

### Disable capture features

If storage is growing too fast:
```bash
LANGFUSE_CAPTURE_PROMPTS=false
LANGFUSE_CAPTURE_TOOL_IO=false
```

These are the highest-volume data sources. Metadata-only tracing is lightweight.
