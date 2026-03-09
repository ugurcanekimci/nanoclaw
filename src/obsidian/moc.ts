import { writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { config } from '../config.js';
import { listEntries, listRecent } from './index-manager.js';

/**
 * Auto-generate MOC.md (Map of Content) for the Obsidian vault.
 * Called after each write operation to keep the index current.
 */
export async function generateMOC(): Promise<void> {
  const recent = await listRecent(15);
  const allEntries = await listEntries();

  const youtube = allEntries.filter((e) => e.type === 'youtube-transcript');
  const xPosts = allEntries.filter((e) => e.type === 'x-post');
  const research = allEntries.filter((e) => e.type === 'research');

  // Collect all tags
  const tagMap = new Map<string, number>();
  for (const entry of allEntries) {
    for (const tag of entry.tags) {
      tagMap.set(tag, (tagMap.get(tag) || 0) + 1);
    }
  }
  const sortedTags = [...tagMap.entries()].sort((a, b) => b[1] - a[1]);

  const lines: string[] = [
    '# Swarm Knowledge Base',
    '',
    `*Auto-generated — ${allEntries.length} total entries*`,
    '',
    '## Recent',
    '',
  ];

  for (const entry of recent) {
    const subdir =
      entry.type === 'youtube-transcript'
        ? 'youtube'
        : entry.type === 'x-post'
          ? 'x-posts'
          : 'research';
    const filename = entry.filePath.replace(/\.md$/, '');
    const prefix =
      entry.type === 'youtube-transcript'
        ? 'YT'
        : entry.type === 'x-post'
          ? 'X'
          : 'Research';
    lines.push(`- [[${subdir}/${filename}]] — [${prefix}] ${entry.title}`);
  }

  lines.push('', `## YouTube Transcripts (${youtube.length})`, '');
  for (const entry of youtube.slice(0, 30)) {
    const filename = entry.filePath.replace(/\.md$/, '');
    lines.push(
      `- [[youtube/${filename}]] — ${entry.title} (${entry.channel || 'Unknown'})`,
    );
  }
  if (youtube.length > 30) lines.push(`- *...and ${youtube.length - 30} more*`);

  lines.push('', `## X/Twitter Posts (${xPosts.length})`, '');
  for (const entry of xPosts.slice(0, 30)) {
    const filename = entry.filePath.replace(/\.md$/, '');
    lines.push(`- [[x-posts/${filename}]] — @${entry.author}: ${entry.title}`);
  }
  if (xPosts.length > 30) lines.push(`- *...and ${xPosts.length - 30} more*`);

  lines.push('', `## Research (${research.length})`, '');
  for (const entry of research.slice(0, 30)) {
    const filename = entry.filePath.replace(/\.md$/, '');
    lines.push(`- [[research/${filename}]] — ${entry.title}`);
  }

  lines.push('', '## Tags', '');
  for (const [tag, count] of sortedTags.slice(0, 20)) {
    lines.push(`- **#${tag}** (${count} notes)`);
  }

  const mocPath = join(config.obsidianVault, 'MOC.md');
  await mkdir(dirname(mocPath), { recursive: true });
  await writeFile(mocPath, lines.join('\n') + '\n', 'utf-8');
}
