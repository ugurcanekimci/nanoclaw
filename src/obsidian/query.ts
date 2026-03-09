import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config.js';
import { listEntries, type IndexEntry } from './index-manager.js';
import type { ContentType } from './vault.js';

export interface VaultSearchResult {
  entry: IndexEntry;
  matchedLines: string[];
  score: number;
}

interface QueryFilter {
  type?: ContentType;
  tag?: string;
  channel?: string;
  author?: string;
  text?: string;
}

/**
 * Parse compound query strings like:
 *   type:youtube channel:"3Blue1Brown" tag:math bevy rapier
 *
 * Unqualified terms become text search.
 */
export function parseQuery(raw: string): QueryFilter {
  const filter: QueryFilter = {};
  const textParts: string[] = [];

  const tokenRe = /(\w+):"([^"]+)"|(\w+):(\S+)|(\S+)/g;
  let match: RegExpExecArray | null;

  while ((match = tokenRe.exec(raw)) !== null) {
    const key = match[1] || match[3];
    const value = match[2] || match[4];
    const bare = match[5];

    if (key && value) {
      switch (key) {
        case 'type':
          if (value === 'youtube') filter.type = 'youtube-transcript';
          else if (value === 'x' || value === 'twitter') filter.type = 'x-post';
          else filter.type = value as ContentType;
          break;
        case 'tag':
          filter.tag = value;
          break;
        case 'channel':
          filter.channel = value;
          break;
        case 'author':
          filter.author = value;
          break;
        default:
          textParts.push(`${key}:${value}`);
      }
    } else if (bare) {
      textParts.push(bare);
    }
  }

  if (textParts.length > 0) {
    filter.text = textParts.join(' ');
  }

  return filter;
}

export async function searchVault(query: string): Promise<VaultSearchResult[]> {
  const filter = parseQuery(query);
  let entries = await listEntries(filter.type);

  // Apply metadata filters
  if (filter.tag) {
    const tagLower = filter.tag.toLowerCase();
    entries = entries.filter((e) =>
      e.tags.some((t) => t.toLowerCase() === tagLower),
    );
  }
  if (filter.channel) {
    const chLower = filter.channel.toLowerCase();
    entries = entries.filter((e) => e.channel?.toLowerCase().includes(chLower));
  }
  if (filter.author) {
    const authLower = filter.author.toLowerCase();
    entries = entries.filter((e) =>
      e.author?.toLowerCase().includes(authLower),
    );
  }

  // Text search across content
  const results: VaultSearchResult[] = [];
  const textLower = filter.text?.toLowerCase();

  for (const entry of entries) {
    let score = 0;
    const matchedLines: string[] = [];

    // Title match (high score)
    if (textLower && entry.title.toLowerCase().includes(textLower)) {
      score += 10;
      matchedLines.push(`[title: "${entry.title}"]`);
    }

    // Summary match (medium score)
    if (textLower && entry.summary.toLowerCase().includes(textLower)) {
      score += 5;
      matchedLines.push(`[summary match]`);
    }

    // Tag match boost
    if (
      textLower &&
      entry.tags.some((t) => t.toLowerCase().includes(textLower))
    ) {
      score += 3;
    }

    // Content grep (expensive, only if we have text to search)
    if (textLower) {
      try {
        const subdir =
          entry.type === 'youtube-transcript'
            ? 'youtube'
            : entry.type === 'x-post'
              ? 'x-posts'
              : 'research';
        const content = await readFile(
          join(config.obsidianVault, subdir, entry.filePath),
          'utf-8',
        );
        const lines = content.split('\n');
        for (const line of lines) {
          if (line.toLowerCase().includes(textLower)) {
            matchedLines.push(line.trim());
            score += 1;
          }
        }
      } catch {
        // File missing
      }
    }

    // If no text filter, include all metadata-matched entries
    if (!textLower) {
      score = 1;
    }

    if (score > 0) {
      results.push({
        entry,
        matchedLines: matchedLines.slice(0, config.maxSearchResults),
        score,
      });
    }
  }

  return results
    .sort((a, b) => b.score - a.score)
    .slice(0, config.maxSearchResults);
}
