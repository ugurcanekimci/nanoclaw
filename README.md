# Swarm — Knowledge Ingestion System

Multi-agent pipeline for YouTube transcript and X/Twitter content ingestion, stored in an Obsidian-backed knowledge base. Exposes a REST API and MCP server consumed by a Claude agent swarm.

---

## Overview

```
YouTube / X/Twitter → Crawl4AI / Camoufox → Transcript + Summary → Obsidian Vault
                                                                          ↓
                                               MCP Server ← Claude Agent Swarm
```

- **Ingest** — YouTube RSS polling + X timeline scraping, summarized and written as Obsidian notes
- **Knowledge base** — Obsidian vault at `OBSIDIAN_VAULT`, agents query via MCP tools
- **REST API** — Port 3100 for external triggers and health checks
- **MCP server** — stdio transport for Claude Code agent integration
- **Scheduler** — cron-based jobs per source (default: `0 */6 * * *`)

---

## Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| Node.js | 20+ | `node --version` |
| Docker | any | For Crawl4AI + Camoufox |
| Ollama | any | Local model inference (`qwen3:8b`, `qwen3-coder`) |
| Slack app | — | Bot token + App-level token (socket mode) |
| Anthropic API key | — | For frontier model fallback |

---

## Environment Setup

Copy `.env.example` to `.env` and fill in values.

### Required

| Variable | Example | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | `sk-ant-...` | Anthropic API key |
| `OBSIDIAN_VAULT` | `/Users/u/Documents/swarm-kb` | Absolute path to Obsidian vault |
| `SLACK_BOT_TOKEN` | `xoxb-...` | Slack bot token (for swarm agent messaging) |
| `SLACK_APP_TOKEN` | `xapp-...` | Slack app-level token (socket mode) |

### Optional — Scraping

| Variable | Default | Description |
|---|---|---|
| `CRAWL4AI_URL` | `http://localhost:11235` | Crawl4AI self-hosted endpoint |
| `CAMOFOX_URL` | `http://localhost:9377` | Camoufox anti-detect browser endpoint |
| `APIFY_API_TOKEN` | — | Apify fallback for protected pages |
| `PROXY_HOST` | — | Residential proxy host |
| `PROXY_PORT` | — | Residential proxy port |
| `PROXY_USER` | — | Residential proxy username |
| `PROXY_PASS` | — | Residential proxy password |

### Optional — AI / Models

| Variable | Default | Description |
|---|---|---|
| `OLLAMA_URL` | `http://localhost:11434` | Ollama inference endpoint |
| `OPENAI_API_KEY` | — | OpenAI key (for `SWARM_MODEL=gpt-4o` groups) |

### Observability — LangFuse

| Variable | Default | Description |
|---|---|---|
| `LANGFUSE_PUBLIC_KEY` | — | LangFuse project public key |
| `LANGFUSE_SECRET_KEY` | — | LangFuse project secret key |
| `LANGFUSE_HOST` | `https://cloud.langfuse.com` | LangFuse host (override for self-hosted) |

---

## LangFuse Setup

**Cloud (recommended)**

1. Sign up at [cloud.langfuse.com](https://cloud.langfuse.com)
2. Create a project → copy **Public Key** and **Secret Key**
3. Add to `.env`:
   ```
   LANGFUSE_PUBLIC_KEY=pk-lf-...
   LANGFUSE_SECRET_KEY=sk-lf-...
   ```

**Self-hosted (Docker)**

```bash
git clone https://github.com/langfuse/langfuse.git
cd langfuse
docker compose up -d
# Default: http://localhost:3000
```

Add to `.env`:
```
LANGFUSE_HOST=http://localhost:3000
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...
```

---

## Starting Services

```bash
# 1. Start Crawl4AI + Camoufox scraping stack
docker compose up -d

# 2. Install dependencies
npm install

# 3. Build TypeScript
npm run build

# 4. Start API + scheduler (development, watch mode)
npm run dev

# 5. Start MCP stdio server (for Claude Code integration)
npm run mcp
```

---

## Obsidian Vault

The vault is stored at `OBSIDIAN_VAULT`. Notes are written as Obsidian-compatible Markdown with YAML frontmatter:

```
swarm-kb/
  youtube/        ← YouTube transcript notes
  x-twitter/      ← X/Twitter post notes
  _templates/     ← Note templates
  changelogs/     ← Agent activity log
```

---

## Common Commands

| Command | Description |
|---|---|
| `npm run dev` | Watch mode (tsx, hot reload) |
| `npm run build` | Compile TypeScript → `dist/` |
| `npm test` | Run Vitest test suite |
| `npm run typecheck` | Type-check without emit |
| `npm run mcp` | Start MCP stdio server |
| `docker compose up -d` | Start Crawl4AI + Camoufox |
| `docker compose down` | Stop all services |

---

## API Endpoints (port 3100)

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Health check |
| `POST` | `/api/transcript` | Ingest a single YouTube video |
| `POST` | `/api/transcript/batch` | Batch ingest YouTube videos |
| `POST` | `/api/x/tweet` | Ingest a single tweet |
| `POST` | `/api/x/timeline` | Ingest a user's timeline |
| `POST` | `/api/x/search` | Search + ingest tweets |
| `POST` | `/api/scrape` | Scrape an arbitrary URL |
| `GET` | `/api/kb` | List knowledge base entries |
| `GET` | `/api/kb/search` | Search the knowledge base |
| `POST` | `/api/plan` | Generate a research plan |
| `GET` | `/api/cost` | Token usage + cost summary |
| `GET` | `/api/scheduler/status` | Scheduled job status |
| `POST` | `/api/scheduler/trigger/:jobName` | Manually trigger a job |
| `GET` | `/api/scheduler/history` | Job run history |
| `GET` | `/api/sources` | List configured sources |
| `PUT` | `/api/sources` | Update sources config |

---

## Agent Channels

| Channel | Trigger | Role |
|---|---|---|
| `#swarm-main` | none (always active) | Orchestrator |
| `#swarm-ingest` | `@Swarm` | YouTube + X ingestion |
| `#swarm-research` | `@Swarm` | Research tasks |
| `#swarm-coder` | `@Swarm` | Code implementation |
| `#swarm-review` | `@Swarm` | Code review and audit |
