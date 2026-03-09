import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { stringify as yamlStringify, parse as yamlParse } from 'yaml';
import { config } from '../config.js';

export type ContentType = 'youtube-transcript' | 'x-post' | 'research';

export interface VaultFrontmatter {
  type: ContentType;
  [key: string]: unknown;
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n/;

function vaultPath(...segments: string[]): string {
  return join(config.obsidianVault, ...segments);
}

async function ensureDir(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
}

export function parseFrontmatter(content: string): {
  meta: VaultFrontmatter | null;
  body: string;
} {
  const match = content.match(FRONTMATTER_RE);
  if (!match?.[1]) return { meta: null, body: content };
  const meta = yamlParse(match[1]) as VaultFrontmatter;
  const body = content.slice(match[0].length);
  return { meta, body };
}

export function buildMarkdown(
  frontmatter: Record<string, unknown>,
  body: string,
): string {
  const yaml = yamlStringify(frontmatter, { lineWidth: 0 });
  return `---\n${yaml}---\n\n${body}\n`;
}

export async function writeNote(
  subdir: string,
  filename: string,
  frontmatter: Record<string, unknown>,
  body: string,
): Promise<string> {
  const filePath = vaultPath(subdir, filename);
  await ensureDir(filePath);
  const content = buildMarkdown(frontmatter, body);
  await writeFile(filePath, content, 'utf-8');
  return filePath;
}

export async function readNote(
  subdir: string,
  filename: string,
): Promise<string | null> {
  try {
    return await readFile(vaultPath(subdir, filename), 'utf-8');
  } catch {
    return null;
  }
}

export async function readNoteWithMeta(
  subdir: string,
  filename: string,
): Promise<{ meta: VaultFrontmatter | null; body: string } | null> {
  const content = await readNote(subdir, filename);
  if (!content) return null;
  return parseFrontmatter(content);
}

export async function writeYouTubeTranscript(params: {
  videoId: string;
  title: string;
  channelName?: string;
  url: string;
  language: string;
  durationSeconds: number;
  wordCount: number;
  fullText: string;
  summary?: string;
  tags?: string[];
  fetchedAt?: string;
}): Promise<string> {
  const frontmatter = {
    type: 'youtube-transcript',
    videoId: params.videoId,
    title: params.title,
    channel: params.channelName || '',
    url: params.url,
    language: params.language,
    duration: params.durationSeconds,
    wordCount: params.wordCount,
    summary: params.summary || '',
    fetchedAt: params.fetchedAt || new Date().toISOString(),
    tags: params.tags || [],
    relatedPosts: [],
  };

  const body = [
    `# ${params.title || params.videoId}`,
    '',
    `**Channel:** ${params.channelName || 'Unknown'}`,
    `**URL:** ${params.url}`,
    `**Duration:** ${params.durationSeconds}s | **Words:** ${params.wordCount}`,
    '',
    '## Summary',
    '',
    params.summary || '',
    '',
    '## Transcript',
    '',
    params.fullText,
  ].join('\n');

  return writeNote('youtube', `${params.videoId}.md`, frontmatter, body);
}

export async function writeXPost(params: {
  tweetId: string;
  author: string;
  authorName?: string;
  url: string;
  isThread: boolean;
  tweetCount: number;
  content: string;
  summary?: string;
  tags?: string[];
}): Promise<string> {
  const frontmatter = {
    type: 'x-post',
    tweetId: params.tweetId,
    author: params.author,
    authorName: params.authorName || params.author,
    url: params.url,
    isThread: params.isThread,
    tweetCount: params.tweetCount,
    summary: params.summary || '',
    fetchedAt: new Date().toISOString(),
    tags: params.tags || [],
    relatedVideos: [],
  };

  const body = [
    `# ${params.authorName || params.author} (@${params.author})`,
    '',
    `**URL:** ${params.url}`,
    `**Thread:** ${params.tweetCount} posts`,
    '',
    '## Content',
    '',
    params.content,
  ].join('\n');

  return writeNote('x-posts', `${params.tweetId}.md`, frontmatter, body);
}

export async function writeResearch(params: {
  slug: string;
  title: string;
  content: string;
  sources: string[];
  summary?: string;
  tags?: string[];
}): Promise<string> {
  const frontmatter = {
    type: 'research',
    title: params.title,
    summary: params.summary || '',
    fetchedAt: new Date().toISOString(),
    tags: params.tags || [],
    sources: params.sources,
  };

  const body = [
    `# ${params.title}`,
    '',
    params.content,
    '',
    '## Sources',
    '',
    ...params.sources.map((s) => `- ${s}`),
  ].join('\n');

  return writeNote('research', `${params.slug}.md`, frontmatter, body);
}
