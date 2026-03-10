import { z } from 'zod';

// Re-export trace context types for convenience
export type { TraceContext, TraceSource } from './observability/context.js';

// ── Swarm transcript types ──

// Raw segment from youtube-transcript-plus
export const TranscriptSegmentSchema = z.object({
  text: z.string(),
  offset: z.number(),
  duration: z.number(),
  lang: z.string(),
});

export type TranscriptSegment = z.infer<typeof TranscriptSegmentSchema>;

// Processed transcript
export const TranscriptSchema = z.object({
  videoId: z.string(),
  title: z.string(),
  channelName: z.string().optional(),
  url: z.string().url(),
  language: z.string(),
  fetchedAt: z.string().datetime(),
  durationSeconds: z.number(),
  segments: z.array(TranscriptSegmentSchema),
  fullText: z.string(),
  wordCount: z.number(),
});

export type Transcript = z.infer<typeof TranscriptSchema>;

// Single transcript request
export const TranscriptRequestSchema = z.object({
  url: z.string(),
  language: z.string().default('en'),
  store: z.boolean().default(true),
});

export type TranscriptRequest = z.infer<typeof TranscriptRequestSchema>;

// Batch request
export const BatchRequestSchema = z.object({
  urls: z.array(z.string()).min(1).max(50),
  language: z.string().default('en'),
  concurrency: z.number().min(1).max(10).default(3),
  store: z.boolean().default(true),
});

export type BatchRequest = z.infer<typeof BatchRequestSchema>;

// Batch result per URL
export const BatchResultSchema = z.object({
  url: z.string(),
  videoId: z.string(),
  status: z.enum(['success', 'error']),
  transcript: TranscriptSchema.optional(),
  error: z.string().optional(),
});

export type BatchResult = z.infer<typeof BatchResultSchema>;

// Knowledge base entry (stored in index.json)
export const KBEntrySchema = z.object({
  videoId: z.string(),
  title: z.string(),
  channelName: z.string().optional(),
  url: z.string(),
  language: z.string(),
  fetchedAt: z.string().datetime(),
  durationSeconds: z.number(),
  wordCount: z.number(),
  filePath: z.string(),
  tags: z.array(z.string()).default([]),
});

export type KBEntry = z.infer<typeof KBEntrySchema>;

// Knowledge base index file
export const KBIndexSchema = z.object({
  version: z.number(),
  lastUpdated: z.string(),
  entries: z.record(z.string(), KBEntrySchema),
});

export type KBIndex = z.infer<typeof KBIndexSchema>;

// Search result
export interface SearchResult {
  entry: KBEntry;
  matchedLines: string[];
}

// API error response
export interface ApiError {
  error: string;
  message: string;
  videoId?: string;
  availableLanguages?: string[];
}

// ── NanoClaw runtime types ──

export interface AdditionalMount {
  hostPath: string; // Absolute path on host (supports ~ for home)
  containerPath?: string; // Optional — defaults to basename of hostPath. Mounted at /workspace/extra/{value}
  readonly?: boolean; // Default: true for safety
}

/**
 * Mount Allowlist - Security configuration for additional mounts
 * This file should be stored at ~/.config/nanoclaw/mount-allowlist.json
 * and is NOT mounted into any container, making it tamper-proof from agents.
 */
export interface MountAllowlist {
  // Directories that can be mounted into containers
  allowedRoots: AllowedRoot[];
  // Glob patterns for paths that should never be mounted (e.g., ".ssh", ".gnupg")
  blockedPatterns: string[];
  // If true, non-main groups can only mount read-only regardless of config
  nonMainReadOnly: boolean;
}

export interface AllowedRoot {
  // Absolute path or ~ for home (e.g., "~/projects", "/var/repos")
  path: string;
  // Whether read-write mounts are allowed under this root
  allowReadWrite: boolean;
  // Optional description for documentation
  description?: string;
}

export interface ContainerConfig {
  additionalMounts?: AdditionalMount[];
  timeout?: number; // Default: 300000 (5 minutes)
  /** Set true to pass OPENAI_API_KEY to this group's container (e.g. when SWARM_MODEL=gpt-4o). */
  openaiEnabled?: boolean;
}

export interface RegisteredGroup {
  name: string;
  folder: string;
  trigger: string;
  added_at: string;
  containerConfig?: ContainerConfig;
  requiresTrigger?: boolean; // Default: true for groups, false for solo chats
  isMain?: boolean; // True for the main control group (no trigger, elevated privileges)
}

export interface NewMessage {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
  is_bot_message?: boolean;
  /** True for synthetic messages injected by the IPC watcher (agent->agent). */
  is_ipc_injected?: boolean;
}

export interface ScheduledTask {
  id: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  context_mode: 'group' | 'isolated';
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  status: 'active' | 'paused' | 'completed';
  created_at: string;
}

export interface TaskRunLog {
  task_id: string;
  run_at: string;
  duration_ms: number;
  status: 'success' | 'error';
  result: string | null;
  error: string | null;
}

// --- Channel abstraction ---

export interface Channel {
  name: string;
  connect(): Promise<void>;
  sendMessage(jid: string, text: string): Promise<void>;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;
  disconnect(): Promise<void>;
  // Optional: typing indicator. Channels that support it implement it.
  setTyping?(jid: string, isTyping: boolean): Promise<void>;
  // Optional: sync group/chat names from the platform.
  syncGroups?(force: boolean): Promise<void>;
}

// Callback type that channels use to deliver inbound messages
export type OnInboundMessage = (chatJid: string, message: NewMessage) => void;

// Available group for IPC group discovery
export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

// Callback for chat metadata discovery.
// name is optional — channels that deliver names inline (Telegram) pass it here;
// channels that sync names separately (via syncGroups) omit it.
export type OnChatMetadata = (
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
) => void;
