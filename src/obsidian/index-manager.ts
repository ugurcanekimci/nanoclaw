import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { config } from '../config.js';
import type { ContentType } from './vault.js';

export interface IndexEntry {
  id: string;
  type: ContentType;
  title: string;
  url: string;
  summary: string;
  tags: string[];
  fetchedAt: string;
  filePath: string;
  wordCount?: number;
  // YouTube-specific
  channel?: string;
  duration?: number;
  // X-specific
  author?: string;
  tweetCount?: number;
}

interface VaultIndex {
  version: number;
  lastUpdated: string;
  entries: Record<string, IndexEntry>;
}

const INDEX_DIR = join(config.obsidianVault, '_index');

function indexPath(type: ContentType | 'all'): string {
  const filename =
    type === 'all'
      ? 'sources.json'
      : `${type === 'youtube-transcript' ? 'youtube' : type === 'x-post' ? 'x-posts' : 'research'}.json`;
  return join(INDEX_DIR, filename);
}

const memoryCache = new Map<string, VaultIndex>();

async function loadIndex(type: ContentType | 'all'): Promise<VaultIndex> {
  const cached = memoryCache.get(type);
  if (cached) return cached;

  const path = indexPath(type);
  try {
    const raw = await readFile(path, 'utf-8');
    const index = JSON.parse(raw) as VaultIndex;
    memoryCache.set(type, index);
    return index;
  } catch {
    const empty: VaultIndex = { version: 1, lastUpdated: '', entries: {} };
    memoryCache.set(type, empty);
    return empty;
  }
}

async function persistIndex(
  type: ContentType | 'all',
  index: VaultIndex,
): Promise<void> {
  index.lastUpdated = new Date().toISOString();
  const path = indexPath(type);
  await mkdir(dirname(path), { recursive: true });
  const tmp = path + '.tmp';
  await writeFile(tmp, JSON.stringify(index, null, 2), 'utf-8');
  await rename(tmp, path);
  memoryCache.set(type, index);
}

export async function upsertEntry(entry: IndexEntry): Promise<void> {
  // Update type-specific index
  const typeIndex = await loadIndex(entry.type);
  typeIndex.entries[entry.id] = entry;
  await persistIndex(entry.type, typeIndex);

  // Update master index
  const masterIndex = await loadIndex('all');
  masterIndex.entries[entry.id] = entry;
  await persistIndex('all', masterIndex);
}

export async function removeEntry(
  id: string,
  type: ContentType,
): Promise<boolean> {
  const typeIndex = await loadIndex(type);
  if (!(id in typeIndex.entries)) return false;
  delete typeIndex.entries[id];
  await persistIndex(type, typeIndex);

  const masterIndex = await loadIndex('all');
  delete masterIndex.entries[id];
  await persistIndex('all', masterIndex);

  return true;
}

export async function getEntry(id: string): Promise<IndexEntry | undefined> {
  const masterIndex = await loadIndex('all');
  return masterIndex.entries[id];
}

export async function listEntries(type?: ContentType): Promise<IndexEntry[]> {
  const index = await loadIndex(type ?? 'all');
  return Object.values(index.entries);
}

export async function listByTag(tag: string): Promise<IndexEntry[]> {
  const index = await loadIndex('all');
  const lower = tag.toLowerCase();
  return Object.values(index.entries).filter((e) =>
    e.tags.some((t) => t.toLowerCase() === lower),
  );
}

export async function listRecent(limit = 20): Promise<IndexEntry[]> {
  const index = await loadIndex('all');
  return Object.values(index.entries)
    .sort((a, b) => b.fetchedAt.localeCompare(a.fetchedAt))
    .slice(0, limit);
}
