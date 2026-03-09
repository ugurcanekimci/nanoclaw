import os from 'node:os';
import path from 'node:path';
import { resolve } from 'node:path';

// ── Swarm API config ──

export const config = {
  port: Number(process.env.PORT) || 3100,
  dataDir: resolve(process.env.DATA_DIR || './data'),
  cacheTTL: Number(process.env.CACHE_TTL) || 86_400_000, // 24h in ms
  batchConcurrency: Number(process.env.BATCH_CONCURRENCY) || 3,
  batchMaxUrls: Number(process.env.BATCH_MAX_URLS) || 50,
  defaultLanguage: process.env.DEFAULT_LANGUAGE || 'en',
  apifyToken: process.env.APIFY_API_TOKEN || '',

  // Obsidian vault
  obsidianVault: resolve(
    process.env.OBSIDIAN_VAULT || '/Users/u/Documents/swarm-kb',
  ),

  // Proxy config
  proxyHost: process.env.PROXY_HOST || '',
  proxyPort: Number(process.env.PROXY_PORT) || 0,
  proxyUser: process.env.PROXY_USER || '',
  proxyPass: process.env.PROXY_PASS || '',

  // Crawl4AI
  crawl4aiUrl: process.env.CRAWL4AI_URL || 'http://localhost:11235',

  // Camoufox browser REST API
  camofoxUrl: process.env.CAMOFOX_URL || 'http://localhost:9377',

  // Context optimization
  maxToolResultTokens: Number(process.env.MAX_TOOL_RESULT_TOKENS) || 4000,
  maxSearchResults: Number(process.env.MAX_SEARCH_RESULTS) || 10,

  // Ollama
  ollamaUrl: process.env.OLLAMA_URL || 'http://localhost:11434',
} as const;

// ── NanoClaw runtime config ──

import { readEnvFile } from './env.js';

// Read config values from .env (falls back to process.env).
// Secrets (API keys, tokens) are NOT read here — they are loaded only
// by the credential proxy (credential-proxy.ts), never exposed to containers.
const envConfig = readEnvFile(['ASSISTANT_NAME', 'ASSISTANT_HAS_OWN_NUMBER']);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER ||
    envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const SENDER_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'sender-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const CREDENTIAL_PROXY_PORT = parseInt(
  process.env.CREDENTIAL_PROXY_PORT || '3001',
  10,
);
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const TRIGGER_PATTERN = new RegExp(
  `^@${escapeRegex(ASSISTANT_NAME)}\\b`,
  'i',
);

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
