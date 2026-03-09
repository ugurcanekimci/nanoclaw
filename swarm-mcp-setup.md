# Wiring Swarm MCP Server into NanoClaw Containers

## How It Works

NanoClaw containers already run the Claude Agent SDK with `mcp__nanoclaw__*` tools.
To add our swarm tools, we configure additional MCP servers in each group's
`.claude/settings.json`.

The swarm API runs on the host at `http://localhost:3100`. Containers access it
via `host.docker.internal:3100` (Docker's bridge to the host).

## Per-Group MCP Configuration

Each group's `.claude/settings.json` at `data/sessions/{folder}/.claude/settings.json`
should include:

```json
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1",
    "CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD": "1",
    "CLAUDE_CODE_DISABLE_AUTO_MEMORY": "0"
  },
  "mcpServers": {
    "swarm": {
      "command": "npx",
      "args": ["tsx", "/workspace/extra/swarm-project/src/mcp/stdio.ts"],
      "env": {
        "OBSIDIAN_VAULT": "/workspace/extra/swarm-kb",
        "DATA_DIR": "/workspace/group/data",
        "CRAWL4AI_URL": "http://host.docker.internal:11235",
        "OLLAMA_URL": "http://host.docker.internal:11434"
      }
    }
  }
}
```

This gives agents access to:
- `mcp__swarm__fetch_transcript`
- `mcp__swarm__batch_fetch_transcripts`
- `mcp__swarm__fetch_tweet`
- `mcp__swarm__fetch_user_timeline`
- `mcp__swarm__search_tweets`
- `mcp__swarm__kb_search`
- `mcp__swarm__kb_recent`
- `mcp__swarm__kb_by_tag`
- `mcp__swarm__web_scrape`
- `mcp__swarm__plan_task`
- `mcp__swarm__cost_report`

## Alternative: Agent-Runner Modification

For tighter integration, modify `container/agent-runner/src/index.ts` to add
the swarm MCP server alongside the nanoclaw MCP server in the `mcpServers` config:

```typescript
mcpServers: {
  nanoclaw: { ... },
  swarm: {
    command: 'npx',
    args: ['tsx', '/workspace/extra/swarm-project/src/mcp/stdio.ts'],
    env: {
      OBSIDIAN_VAULT: '/workspace/extra/swarm-kb',
      DATA_DIR: '/workspace/group/data',
      CRAWL4AI_URL: 'http://host.docker.internal:11235',
      OLLAMA_URL: 'http://host.docker.internal:11434',
    },
  },
},
allowedTools: [
  ...existingTools,
  'mcp__swarm__*'
],
```

This approach requires rebuilding the container image but gives more control.

## Startup Sequence

1. Start Ollama: `ollama serve`
2. Start Crawl4AI: `docker run -d --name crawl4ai -p 11235:11235 unclecode/crawl4ai:latest`
3. Start Swarm API: `cd /Users/u/swarm && npm run dev` (port 3100)
4. Start NanoClaw: `cd /Users/u/nanoclaw && npm start`
5. NanoClaw connects to Slack, spawns containers for each group
6. Each container has both `mcp__nanoclaw__*` and `mcp__swarm__*` tools
