/**
 * NanoClaw Agent Runner
 * Runs inside a container, receives config via stdin, outputs result to stdout
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON (read until EOF, like before)
 *   IPC:   Follow-up messages written as JSON files to /workspace/ipc/input/
 *          Files: {type:"message", text:"..."}.json — polled and consumed
 *          Sentinel: /workspace/ipc/input/_close — signals session end
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 *   Multiple results may be emitted (one per agent teams result).
 *   Final marker after loop ends signals completion.
 */

import fs from 'fs';
import path from 'path';
import {
  query,
  HookCallback,
  PreCompactHookInput,
  PreToolUseHookInput,
} from '@anthropic-ai/claude-agent-sdk';
import { fileURLToPath } from 'url';

interface TraceContext {
  traceId: string;
  spanId?: string;
  sessionId?: string;
  runId: string;
  source: 'user' | 'ipc' | 'scheduler';
  taskId?: string;
  chatJid?: string;
  groupFolder?: string;
}

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  secrets?: Record<string, string>;
  traceContext?: TraceContext;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

interface SessionEntry {
  sessionId: string;
  fullPath: string;
  summary: string;
  firstPrompt: string;
}

interface SessionsIndex {
  entries: SessionEntry[];
}

interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
}

const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;

/**
 * Push-based async iterable for streaming user messages to the SDK.
 * Keeps the iterable alive until end() is called, preventing isSingleUserTurn.
 */
class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>((r) => {
        this.waiting = r;
      });
      this.waiting = null;
    }
  }
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';
const TRACE_EVENT_START_MARKER = '---NANOCLAW_TRACE_EVENT---';
const TRACE_EVENT_END_MARKER = '---NANOCLAW_TRACE_EVENT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

/**
 * Emit a structured trace event via stdout for the host to collect.
 * The container has no Langfuse client — events are parsed by the host's
 * container-runner (OBS-04) and stitched into the trace tree.
 */
function emitTraceEvent(
  name: string,
  metadata: Record<string, unknown>,
): void {
  console.log(TRACE_EVENT_START_MARKER);
  console.log(JSON.stringify({ name, metadata, timestamp: Date.now() }));
  console.log(TRACE_EVENT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

function getSessionSummary(
  sessionId: string,
  transcriptPath: string,
): string | null {
  const projectDir = path.dirname(transcriptPath);
  const indexPath = path.join(projectDir, 'sessions-index.json');

  if (!fs.existsSync(indexPath)) {
    log(`Sessions index not found at ${indexPath}`);
    return null;
  }

  try {
    const index: SessionsIndex = JSON.parse(
      fs.readFileSync(indexPath, 'utf-8'),
    );
    const entry = index.entries.find((e) => e.sessionId === sessionId);
    if (entry?.summary) {
      return entry.summary;
    }
  } catch (err) {
    log(
      `Failed to read sessions index: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return null;
}

/**
 * Archive the full transcript to conversations/ before compaction.
 */
function createPreCompactHook(assistantName?: string): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preCompact = input as PreCompactHookInput;
    const transcriptPath = preCompact.transcript_path;
    const sessionId = preCompact.session_id;

    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      log('No transcript found for archiving');
      return {};
    }

    try {
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const messages = parseTranscript(content);

      if (messages.length === 0) {
        log('No messages to archive');
        return {};
      }

      const summary = getSessionSummary(sessionId, transcriptPath);
      const name = summary ? sanitizeFilename(summary) : generateFallbackName();

      const conversationsDir = '/workspace/group/conversations';
      fs.mkdirSync(conversationsDir, { recursive: true });

      const date = new Date().toISOString().split('T')[0];
      const filename = `${date}-${name}.md`;
      const filePath = path.join(conversationsDir, filename);

      const markdown = formatTranscriptMarkdown(
        messages,
        summary,
        assistantName,
      );
      fs.writeFileSync(filePath, markdown);

      log(`Archived conversation to ${filePath}`);
    } catch (err) {
      log(
        `Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return {};
  };
}

// Secrets to strip from Bash tool subprocess environments.
// These are needed by claude-code for API auth but should never
// be visible to commands Kit runs.
const SECRET_ENV_VARS = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'];

function createSanitizeBashHook(): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preInput = input as PreToolUseHookInput;
    const command = (preInput.tool_input as { command?: string })?.command;
    if (!command) return {};

    const unsetPrefix = `unset ${SECRET_ENV_VARS.join(' ')} 2>/dev/null; `;
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput: {
          ...(preInput.tool_input as Record<string, unknown>),
          command: unsetPrefix + command,
        },
      },
    };
  };
}

// === Secret Leak Prevention ===
// Regex patterns that match common secret formats.
// Applied to all tool inputs when using external providers.
const SECRET_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: 'AWS Access Key', pattern: /AKIA[0-9A-Z]{16}/ },
  // AWS Secret Access Key: require variable-name context to avoid matching arbitrary
  // 40-char base64 strings (e.g. hashes, UUIDs). The key is always 40 chars of
  // [A-Za-z0-9/+] but only meaningful when adjacent to the known variable names.
  {
    name: 'AWS Secret Key',
    pattern:
      /(?:AWS_SECRET_ACCESS_KEY|aws_secret_access_key|SecretAccessKey)['":\s=]+[A-Za-z0-9/+]{40}/,
  },
  { name: 'GitHub Token', pattern: /gh[pousr]_[A-Za-z0-9_]{36,}/ },
  { name: 'GitHub Classic Token', pattern: /ghp_[A-Za-z0-9]{36}/ },
  { name: 'Slack Token', pattern: /xox[bpasr]-[0-9A-Za-z-]+/ },
  { name: 'Anthropic API Key', pattern: /sk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: 'OpenAI API Key', pattern: /sk-[A-Za-z0-9]{20,}/ },
  { name: 'xAI API Key', pattern: /xai-[A-Za-z0-9]{20,}/ },
  {
    name: 'Generic API Key',
    pattern:
      /['\"]?(?:api[_-]?key|apikey|secret[_-]?key|access[_-]?token)['\"]?\s*[:=]\s*['\"][A-Za-z0-9_\-/.+]{20,}['\"]/i,
  },
  {
    name: 'Private Key',
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  },
  { name: 'OAuth Token', pattern: /ya29\.[0-9A-Za-z_-]+/ },
  {
    name: 'Connection String',
    pattern: /(?:mongodb|postgres|mysql|redis):\/\/[^\s'"]+@[^\s'"]+/,
  },
  { name: '1Password Reference', pattern: /op:\/\/[^\s'"]+/ },
];

/**
 * Build a set of literal secret values from containerInput.secrets.
 * These are exact-matched against tool inputs for redaction.
 */
function buildSecretValues(
  secrets: Record<string, string> | undefined,
): Set<string> {
  const values = new Set<string>();
  if (!secrets) return values;
  for (const [_key, value] of Object.entries(secrets)) {
    // Only track values that look like actual secrets (not URLs or short values)
    if (value && value.length >= 10 && !/^https?:\/\//.test(value)) {
      values.add(value);
    }
  }
  return values;
}

/**
 * Scan text for secret patterns and known secret values.
 * Returns list of findings, empty if clean.
 */
function scanForSecrets(text: string, knownSecrets: Set<string>): string[] {
  const findings: string[] = [];

  // Check regex patterns
  for (const { name, pattern } of SECRET_PATTERNS) {
    if (pattern.test(text)) {
      findings.push(name);
    }
  }

  // Check known secret values (exact substring match)
  for (const secret of knownSecrets) {
    if (text.includes(secret)) {
      findings.push('Known secret value');
      break; // One match is enough
    }
  }

  return findings;
}

/**
 * Redact known secret values from text.
 * Replaces exact occurrences with [REDACTED].
 */
function redactSecrets(text: string, knownSecrets: Set<string>): string {
  let result = text;
  for (const secret of knownSecrets) {
    if (result.includes(secret)) {
      result = result.split(secret).join('[REDACTED]');
    }
  }
  return result;
}

/**
 * Determine if the current provider is external (not Ollama local).
 */
function isExternalProvider(
  sdkEnv: Record<string, string | undefined>,
): boolean {
  const baseUrl = sdkEnv.ANTHROPIC_BASE_URL || '';
  // Ollama local is safe — no leak risk
  if (
    baseUrl.includes('localhost') ||
    baseUrl.includes('127.0.0.1') ||
    baseUrl.includes('host.docker.internal')
  ) {
    // host.docker.internal pointing to Ollama is local
    if (!baseUrl || baseUrl.includes('11434')) return false;
  }
  // Default Anthropic API (no ANTHROPIC_BASE_URL set) — trusted provider
  if (!baseUrl) return false;
  // Everything else (xAI, OpenAI, etc.) is external
  return true;
}

/**
 * Extract all text from a tool input for scanning.
 */
function extractToolInputText(toolInput: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const value of Object.values(toolInput)) {
    if (typeof value === 'string') {
      parts.push(value);
    } else if (typeof value === 'object' && value !== null) {
      parts.push(JSON.stringify(value));
    }
  }
  return parts.join('\n');
}

/**
 * PreToolUse hook: scans all tool inputs for secrets when using external providers.
 * - Blocks tool calls that contain regex-matched secret patterns
 * - Redacts known secret values (from containerInput.secrets)
 * - Only active for external providers (xAI, OpenAI, etc.)
 * - Ollama local and Anthropic API are trusted (no scanning)
 */
function createSecretScannerHook(
  knownSecrets: Set<string>,
  isExternal: boolean,
): HookCallback {
  return async (input, _toolUseId, _context) => {
    // Skip scanning for local/trusted providers
    if (!isExternal) return {};

    const preInput = input as PreToolUseHookInput;
    const toolInput = preInput.tool_input as Record<string, unknown>;
    if (!toolInput) return {};

    const text = extractToolInputText(toolInput);
    if (!text) return {};

    // Scan for secret patterns
    const findings = scanForSecrets(text, knownSecrets);

    if (findings.length > 0) {
      const uniqueFindings = [...new Set(findings)];
      log(
        `[SECRET-SCANNER] BLOCKED: ${preInput.tool_name} — found: ${uniqueFindings.join(', ')}`,
      );
      emitTraceEvent('hook-block', {
        hook: 'secret-scanner',
        tool: preInput.tool_name,
        findings: uniqueFindings,
      });

      // Attempt redaction for known values; block entirely for pattern matches
      const hasPatternMatch = uniqueFindings.some(
        (f) => f !== 'Known secret value',
      );
      if (hasPatternMatch) {
        // Block the tool call — pattern match means potential unknown secret
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            decision: 'block',
            reason: `Secret leak prevention: detected ${uniqueFindings.join(', ')} in tool input. This content cannot be sent to external providers.`,
          },
        };
      }

      // Redact known secret values and allow
      const redacted = { ...toolInput };
      for (const [key, value] of Object.entries(redacted)) {
        if (typeof value === 'string') {
          redacted[key] = redactSecrets(value, knownSecrets);
        }
      }
      log(`[SECRET-SCANNER] Redacted known secrets in ${preInput.tool_name}`);
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          updatedInput: redacted,
        },
      };
    }

    return {};
  };
}

// === Git Safety Enforcement ===
// Blocks destructive git and gh commands based on agent group role.
// Logs all git/gh commands to an audit file for orchestrator visibility.

const CODER_BLOCKED_GIT: RegExp[] = [
  /git\s+push\s+.*--force/,
  /git\s+push\s+-f\b/,
  /git\s+push\s+.*\b(origin|upstream)\s+main\b/,
  /git\s+reset\s+--hard/,
  /git\s+rebase\b/,
  /git\s+clean\s+-[fd]/,
  /git\s+branch\s+-D\b/,
  /git\s+checkout\s+--\s*\./,
  /git\s+config\b/,
  /rm\s+-rf?\s+\.git\b/,
];

const CODER_BLOCKED_GH: RegExp[] = [
  /gh\s+pr\s+merge\b/,
  /gh\s+pr\s+close\b/,
  /gh\s+repo\s+delete\b/,
];

const REVIEW_BLOCKED_GIT: RegExp[] = [
  /git\s+(push|commit|reset|rebase|clean|checkout\s+--|merge|cherry-pick|branch\s+-[dD]|config|stash\s+drop)\b/,
];

const REVIEW_BLOCKED_GH: RegExp[] = [
  /gh\s+pr\s+merge\b/,
  /gh\s+pr\s+create\b/,
  /gh\s+pr\s+close\b/,
];

const DEFAULT_BLOCKED_GIT: RegExp[] = [/\bgit\s+/];

const DEFAULT_BLOCKED_GH: RegExp[] = [
  /gh\s+pr\s+(merge|create|close|review)\b/,
];

function getGitBlocklist(groupFolder: string): { git: RegExp[]; gh: RegExp[] } {
  if (groupFolder.endsWith('-coder'))
    return { git: CODER_BLOCKED_GIT, gh: CODER_BLOCKED_GH };
  if (groupFolder.endsWith('-review'))
    return { git: REVIEW_BLOCKED_GIT, gh: REVIEW_BLOCKED_GH };
  // Orchestrator (main) can run gh pr merge but not destructive git ops
  if (groupFolder.endsWith('-main')) return { git: CODER_BLOCKED_GIT, gh: [] };
  return { git: DEFAULT_BLOCKED_GIT, gh: DEFAULT_BLOCKED_GH };
}

const GIT_AUDIT_FILE = '/workspace/group/git-audit.log';

function auditGitCommand(
  command: string,
  blocked: boolean,
  group: string,
  reason?: string,
): void {
  try {
    const entry = JSON.stringify({
      timestamp: new Date().toISOString(),
      command: command.slice(0, 500),
      blocked,
      group,
      ...(reason ? { reason } : {}),
    });
    fs.appendFileSync(GIT_AUDIT_FILE, entry + '\n');
  } catch {
    /* audit is best-effort */
  }
}

function createGitSafetyHook(groupFolder: string): HookCallback {
  const { git: gitBlocked, gh: ghBlocked } = getGitBlocklist(groupFolder);

  return async (input, _toolUseId, _context) => {
    const preInput = input as PreToolUseHookInput;
    const command = (preInput.tool_input as { command?: string })?.command;
    if (!command) return {};

    const isGitCmd = /\bgit\s+/.test(command);
    const isGhCmd = /\bgh\s+/.test(command);
    if (!isGitCmd && !isGhCmd) return {};

    // Check git blocklist
    for (const pattern of gitBlocked) {
      if (pattern.test(command)) {
        const reason = `Blocked: destructive git operation not permitted for ${groupFolder}`;
        auditGitCommand(command, true, groupFolder, reason);
        log(`[GIT-SAFETY] ${reason}: ${command.slice(0, 200)}`);
        emitTraceEvent('hook-block', {
          hook: 'git-safety',
          group: groupFolder,
          commandPrefix: command.slice(0, 100),
        });
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            decision: 'block',
            reason,
          },
        };
      }
    }

    // Check gh CLI blocklist
    for (const pattern of ghBlocked) {
      if (pattern.test(command)) {
        const reason = `Blocked: gh operation not permitted for ${groupFolder}`;
        auditGitCommand(command, true, groupFolder, reason);
        log(`[GIT-SAFETY] ${reason}: ${command.slice(0, 200)}`);
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            decision: 'block',
            reason,
          },
        };
      }
    }

    // Allowed — still audit it
    auditGitCommand(command, false, groupFolder);
    return {};
  };
}

// === Protected Path Enforcement ===
// Blocks Write/Edit to infrastructure files that agents should never modify.

const PROTECTED_PATHS = [
  'container/Dockerfile',
  'container/build.sh',
  'container/skills/',
  '.husky/',
  '.github/',
  'scripts/start.sh',
];

function createProtectedPathHook(groupFolder: string): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preInput = input as PreToolUseHookInput;
    const filePath = (preInput.tool_input as { file_path?: string })?.file_path;
    if (!filePath) return {};

    for (const protected_ of PROTECTED_PATHS) {
      if (filePath.includes(protected_)) {
        const reason = `Blocked: ${protected_} is a protected infrastructure file`;
        log(`[PATH-SAFETY] ${reason} (agent: ${groupFolder})`);
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            decision: 'block',
            reason,
          },
        };
      }
    }

    return {};
  };
}

function sanitizeFilename(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

function generateFallbackName(): string {
  const time = new Date();
  return `conversation-${time.getHours().toString().padStart(2, '0')}${time.getMinutes().toString().padStart(2, '0')}`;
}

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text =
          typeof entry.message.content === 'string'
            ? entry.message.content
            : entry.message.content
                .map((c: { text?: string }) => c.text || '')
                .join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { text: string }) => c.text);
        const text = textParts.join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {}
  }

  return messages;
}

function formatTranscriptMarkdown(
  messages: ParsedMessage[],
  title?: string | null,
  assistantName?: string,
): string {
  const now = new Date();
  const formatDateTime = (d: Date) =>
    d.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });

  const lines: string[] = [];
  lines.push(`# ${title || 'Conversation'}`);
  lines.push('');
  lines.push(`Archived: ${formatDateTime(now)}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : assistantName || 'Assistant';
    const content =
      msg.content.length > 2000
        ? msg.content.slice(0, 2000) + '...'
        : msg.content;
    lines.push(`**${sender}**: ${content}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Check for _close sentinel.
 */
function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try {
      fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
    } catch {
      /* ignore */
    }
    return true;
  }
  return false;
}

/**
 * Drain all pending IPC input messages.
 * Returns messages found, or empty array.
 */
function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs
      .readdirSync(IPC_INPUT_DIR)
      .filter((f) => f.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        }
      } catch (err) {
        log(
          `Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`,
        );
        try {
          fs.unlinkSync(filePath);
        } catch {
          /* ignore */
        }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Wait for a new IPC message or _close sentinel.
 * Returns the messages as a single string, or null if _close.
 */
function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        resolve(messages.join('\n'));
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

/**
 * Run a single query and stream results via writeOutput.
 * Uses MessageStream (AsyncIterable) to keep isSingleUserTurn=false,
 * allowing agent teams subagents to run to completion.
 * Also pipes IPC messages into the stream during the query.
 */
async function runQuery(
  prompt: string,
  sessionId: string | undefined,
  mcpServerPath: string,
  containerInput: ContainerInput,
  sdkEnv: Record<string, string | undefined>,
  resumeAt?: string,
): Promise<{
  newSessionId?: string;
  lastAssistantUuid?: string;
  closedDuringQuery: boolean;
}> {
  const queryStartTime = Date.now();
  const hasTraceContext = !!containerInput.traceContext;

  if (hasTraceContext) {
    emitTraceEvent('query-start', {
      iteration: sessionId ? 'resume' : 'initial',
      promptLength: prompt.length,
      hasSession: !!sessionId,
    });
  }

  const stream = new MessageStream();
  stream.push(prompt);

  // Poll IPC for follow-up messages and _close sentinel during the query
  let ipcPolling = true;
  let closedDuringQuery = false;
  const pollIpcDuringQuery = () => {
    if (!ipcPolling) return;
    if (shouldClose()) {
      log('Close sentinel detected during query, ending stream');
      closedDuringQuery = true;
      stream.end();
      ipcPolling = false;
      return;
    }
    const messages = drainIpcInput();
    for (const text of messages) {
      log(`Piping IPC message into active query (${text.length} chars)`);
      stream.push(text);
    }
    setTimeout(pollIpcDuringQuery, IPC_POLL_MS);
  };
  setTimeout(pollIpcDuringQuery, IPC_POLL_MS);

  let newSessionId: string | undefined;
  let lastAssistantUuid: string | undefined;
  let messageCount = 0;
  let resultCount = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let modelName: string | undefined;

  // Load global CLAUDE.md as additional system context (shared across all groups)
  const globalClaudeMdPath = '/workspace/global/CLAUDE.md';
  let globalClaudeMd: string | undefined;
  if (!containerInput.isMain && fs.existsSync(globalClaudeMdPath)) {
    globalClaudeMd = fs.readFileSync(globalClaudeMdPath, 'utf-8');
  }

  // Discover additional directories mounted at /workspace/extra/*
  // These are passed to the SDK so their CLAUDE.md files are loaded automatically
  const extraDirs: string[] = [];
  const extraBase = '/workspace/extra';
  if (fs.existsSync(extraBase)) {
    for (const entry of fs.readdirSync(extraBase)) {
      const fullPath = path.join(extraBase, entry);
      if (fs.statSync(fullPath).isDirectory()) {
        extraDirs.push(fullPath);
      }
    }
  }
  if (extraDirs.length > 0) {
    log(`Additional directories: ${extraDirs.join(', ')}`);
  }

  // Secret leak prevention: build scanner context
  const knownSecrets = buildSecretValues(containerInput.secrets);
  const external = isExternalProvider(sdkEnv);
  if (external) {
    log(
      `[SECRET-SCANNER] External provider detected — secret scanning ACTIVE (${knownSecrets.size} known values)`,
    );
  }

  for await (const message of query({
    prompt: stream,
    options: {
      cwd: '/workspace/group',
      additionalDirectories: extraDirs.length > 0 ? extraDirs : undefined,
      resume: sessionId,
      resumeSessionAt: resumeAt,
      systemPrompt: globalClaudeMd
        ? {
            type: 'preset' as const,
            preset: 'claude_code' as const,
            append: globalClaudeMd,
          }
        : undefined,
      allowedTools: [
        'Bash',
        'Read',
        'Write',
        'Edit',
        'Glob',
        'Grep',
        'WebSearch',
        'WebFetch',
        'Task',
        'TaskOutput',
        'TaskStop',
        'TeamCreate',
        'TeamDelete',
        'SendMessage',
        'TodoWrite',
        'ToolSearch',
        'Skill',
        'NotebookEdit',
        'mcp__nanoclaw__*',
        'mcp__ollama__*',
      ],
      env: sdkEnv,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      settingSources: ['project', 'user'],
      mcpServers: {
        nanoclaw: {
          command: 'node',
          args: [mcpServerPath],
          env: {
            NANOCLAW_CHAT_JID: containerInput.chatJid,
            NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
            NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
          },
        },
        ollama: {
          command: 'node',
          args: [path.join(path.dirname(mcpServerPath), 'ollama-mcp-stdio.js')],
        },
      },
      hooks: {
        PreCompact: [
          { hooks: [createPreCompactHook(containerInput.assistantName)] },
        ],
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [
              createSanitizeBashHook(),
              createGitSafetyHook(containerInput.groupFolder),
            ],
          },
          {
            matcher: 'Write',
            hooks: [createProtectedPathHook(containerInput.groupFolder)],
          },
          {
            matcher: 'Edit',
            hooks: [createProtectedPathHook(containerInput.groupFolder)],
          },
          { hooks: [createSecretScannerHook(knownSecrets, external)] },
        ],
      },
    },
  })) {
    messageCount++;
    const msgType =
      message.type === 'system'
        ? `system/${(message as { subtype?: string }).subtype}`
        : message.type;
    // ── Enhanced logging: show what the agent is actually doing ──
    let detail = '';
    if (message.type === 'assistant' && 'message' in message) {
      const msg = message as { message?: { content?: Array<{ type: string; name?: string; text?: string }> } };
      const blocks = msg.message?.content || [];
      const tools = blocks.filter((b) => b.type === 'tool_use').map((b) => b.name);
      const textBlocks = blocks.filter((b) => b.type === 'text').map((b) => (b.text || '').slice(0, 120));
      if (tools.length > 0) detail = ` tools=[${tools.join(', ')}]`;
      else if (textBlocks.length > 0) detail = ` text="${textBlocks[0]}"`;
    } else if (message.type === 'user' && 'message' in message) {
      const msg = message as { message?: { content?: string | Array<{ type: string; tool_use_id?: string }> } };
      const content = msg.message?.content;
      if (Array.isArray(content)) {
        const toolResults = content.filter((b) => b.type === 'tool_result');
        if (toolResults.length > 0) detail = ` tool_results=${toolResults.length}`;
      } else if (typeof content === 'string') {
        detail = ` text="${content.slice(0, 120)}"`;
      }
    }
    log(`[msg #${messageCount}] type=${msgType}${detail}`);

    if (message.type === 'assistant' && 'uuid' in message) {
      lastAssistantUuid = (message as { uuid: string }).uuid;
      // Extract token usage from assistant messages for LangFuse generation tracking
      const assistantMsg = message as {
        message?: {
          model?: string;
          usage?: { input_tokens?: number; output_tokens?: number };
        };
      };
      if (assistantMsg.message?.usage) {
        totalInputTokens += assistantMsg.message.usage.input_tokens || 0;
        totalOutputTokens += assistantMsg.message.usage.output_tokens || 0;
      }
      if (assistantMsg.message?.model) {
        modelName = assistantMsg.message.model;
      }
    }

    if (message.type === 'system' && message.subtype === 'init') {
      newSessionId = message.session_id;
      log(`Session initialized: ${newSessionId}`);
      if (hasTraceContext) {
        emitTraceEvent('session-init', { sessionId: newSessionId });
      }
    }

    if (
      message.type === 'system' &&
      (message as { subtype?: string }).subtype === 'task_notification'
    ) {
      const tn = message as {
        task_id: string;
        status: string;
        summary: string;
      };
      log(
        `Task notification: task=${tn.task_id} status=${tn.status} summary=${tn.summary}`,
      );
    }

    if (message.type === 'result') {
      resultCount++;
      const textResult =
        'result' in message ? (message as { result?: string }).result : null;
      log(
        `Result #${resultCount}: subtype=${message.subtype}${textResult ? ` text=${textResult.slice(0, 200)}` : ''}`,
      );
      writeOutput({
        status: 'success',
        result: textResult || null,
        newSessionId,
      });
    }
  }

  ipcPolling = false;

  const queryDurationMs = Date.now() - queryStartTime;
  if (hasTraceContext) {
    // Emit token usage for LangFuse generation tracking (OBS fix-005)
    if (totalInputTokens > 0 || totalOutputTokens > 0) {
      emitTraceEvent('result-usage', {
        model: modelName || sdkEnv.SWARM_MODEL || 'unknown',
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
      });
    }
    emitTraceEvent('query-end', {
      durationMs: queryDurationMs,
      messageCount,
      resultCount,
      closedDuringQuery,
    });
  }

  log(
    `Query done. Messages: ${messageCount}, results: ${resultCount}, lastAssistantUuid: ${lastAssistantUuid || 'none'}, closedDuringQuery: ${closedDuringQuery}`,
  );
  return { newSessionId, lastAssistantUuid, closedDuringQuery };
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    // Delete the temp file the entrypoint wrote — it contains secrets
    try {
      fs.unlinkSync('/tmp/input.json');
    } catch {
      /* may not exist */
    }
    // Recover trace context: prefer stdin JSON, fall back to env var
    if (!containerInput.traceContext && process.env.NANOCLAW_TRACE_CONTEXT) {
      try {
        containerInput.traceContext = JSON.parse(
          process.env.NANOCLAW_TRACE_CONTEXT,
        );
      } catch {
        /* ignore malformed trace context */
      }
    }
    if (containerInput.traceContext) {
      log(
        `Trace context: traceId=${containerInput.traceContext.traceId} source=${containerInput.traceContext.source}`,
      );
      emitTraceEvent('agent-start', {
        traceId: containerInput.traceContext.traceId,
        source: containerInput.traceContext.source,
        groupFolder: containerInput.groupFolder,
      });
    }
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`,
    });
    process.exit(1);
  }

  // Build SDK env: merge secrets into process.env for the SDK only.
  // Secrets never touch process.env itself, so Bash subprocesses can't see them.
  const sdkEnv: Record<string, string | undefined> = { ...process.env };
  for (const [key, value] of Object.entries(containerInput.secrets || {})) {
    sdkEnv[key] = value;
  }

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');

  let sessionId = containerInput.sessionId;
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });

  // Clean up stale _close sentinel from previous container runs
  try {
    fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
  } catch {
    /* ignore */
  }

  // Build initial prompt (drain any pending IPC messages too)
  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }
  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    prompt += '\n' + pending.join('\n');
  }

  // Query loop: run query → wait for IPC message → run new query → repeat
  let resumeAt: string | undefined;
  try {
    while (true) {
      log(
        `Starting query (session: ${sessionId || 'new'}, resumeAt: ${resumeAt || 'latest'})...`,
      );

      const queryResult = await runQuery(
        prompt,
        sessionId,
        mcpServerPath,
        containerInput,
        sdkEnv,
        resumeAt,
      );
      if (queryResult.newSessionId) {
        sessionId = queryResult.newSessionId;
      }
      if (queryResult.lastAssistantUuid) {
        resumeAt = queryResult.lastAssistantUuid;
      }

      // If _close was consumed during the query, exit immediately.
      // Don't emit a session-update marker (it would reset the host's
      // idle timer and cause a 30-min delay before the next _close).
      if (queryResult.closedDuringQuery) {
        log('Close sentinel consumed during query, exiting');
        break;
      }

      // Emit session update so host can track it
      writeOutput({ status: 'success', result: null, newSessionId: sessionId });

      log('Query ended, waiting for next IPC message...');

      // Wait for the next message or _close sentinel
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(`Got new message (${nextMessage.length} chars), starting new query`);
      prompt = nextMessage;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    if (containerInput.traceContext) {
      emitTraceEvent('agent-error', {
        error: errorMessage.slice(0, 500),
      });
    }
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: sessionId,
      error: errorMessage,
    });
    process.exit(1);
  }
}

main();
