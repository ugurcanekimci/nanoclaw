/**
 * Standalone MCP server entry point for Claude Desktop / Claude Code.
 *
 * Configure in .mcp.json:
 * {
 *   "mcpServers": {
 *     "youtube-transcript": {
 *       "command": "npx",
 *       "args": ["tsx", "src/mcp/stdio.ts"],
 *       "cwd": "/path/to/swarm"
 *     }
 *   }
 * }
 */
import { transcriptMcpServer } from './server.js';

console.error('YouTube Transcript MCP server starting (stdio mode)...');

export { transcriptMcpServer };
