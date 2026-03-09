---
date: 2026-03-09
agent: swarm-coder
project: nanoclaw
type: feature
files_changed:
  - src/web-broadcaster.ts (new)
  - src/db-web.ts (new)
  - src/web-server.ts (new)
  - src/channels/web.ts (new)
  - public/index.html (new)
  - src/db.ts
  - src/channels/index.ts
  - src/index.ts
  - package.json
---

Implemented NanoClaw Web UI (pipe-1773015400, step 3/3).

- `src/web-broadcaster.ts` — EventEmitter singleton; `broadcastEvent(WebEvent)` / `onWebEvent(handler)` API
- `src/db-web.ts` — schema migrations for `agent_status`, `pipeline_runs`, `agent_costs` tables; `getRecentMessages()` / `getCostSummaries()` query helpers
- `src/web-server.ts` — HTTP server (port 3100, `WEB_PORT` env override) + WebSocket server (`ws@^8`); sends 50-message snapshot per group on connect; streams live events to clients; `/api/costs` REST endpoint
- `src/channels/web.ts` — pseudo-channel that broadcasts outbound messages via broadcaster; returns null when `WEB_UI_MODE=slack-only`
- `public/index.html` — single-file SPA (no build step, browser-native WS); Chat, Costs, Agents panels; dark theme
- `src/db.ts` — added `getDb()` export for web modules
- `src/channels/index.ts` — added `./web.js` to self-registration barrel
- `src/index.ts` — `WEB_UI_MODE` feature flag (default `dual`); calls `migrateWebDb()` + `startWebServer()` at startup; broadcasts inbound and scheduler outbound messages
- `package.json` — added `ws@^8.18.0`, `@types/ws@^8.5.14`

All 331 tests pass, `npm run build` clean.

Env vars:
- `WEB_UI_MODE` — `dual` (default) | `slack-only` | `web-primary`
- `WEB_PORT` — HTTP/WS port (default: 3100)
