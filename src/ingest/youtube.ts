/**
 * YouTube ingestion — fetch transcript and store in Obsidian vault.
 */

import { getTranscript, extractVideoId } from "../core/transcript.js";
import { writeYouTubeTranscript } from "../obsidian/vault.js";
import { upsertEntry, getEntry, type IndexEntry } from "../obsidian/index-manager.js";
import { frontmatterSummary, extractTopics } from "../context/summarizer.js";
import { generateMOC } from "../obsidian/moc.js";

/**
 * Fetch the most recent video IDs from a YouTube channel via its public RSS feed.
 * No API key required — YouTube exposes up to 15 entries per channel RSS feed.
 */
export async function getChannelRecentVideos(channelId: string, limit = 15): Promise<string[]> {
  const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`YouTube channel RSS fetch failed for ${channelId}: HTTP ${res.status}`);
  const xml = await res.text();
  const matches = [...xml.matchAll(/<yt:videoId>([a-zA-Z0-9_-]{11})<\/yt:videoId>/g)];
  return matches.slice(0, limit).map((m) => m[1]).filter((id): id is string => id !== undefined);
}

/**
 * Fetch a YouTube video transcript and store it in the Obsidian vault.
 * Returns the index entry for the stored transcript.
 */
export async function ingestYouTubeVideo(
  urlOrId: string,
  language = "en",
  tags: string[] = [],
): Promise<IndexEntry> {
  // Check for duplicates before fetching to avoid redundant network calls
  const videoId = extractVideoId(urlOrId);
  const existing = await getEntry(videoId);
  if (existing) return existing;

  const transcript = await getTranscript(urlOrId, language);
  const summary = frontmatterSummary(transcript.fullText);
  const autoTags = extractTopics(transcript.fullText, 5);

  await writeYouTubeTranscript({
    videoId: transcript.videoId,
    title: transcript.title,
    channelName: transcript.channelName,
    url: transcript.url,
    language: transcript.language,
    durationSeconds: transcript.durationSeconds,
    wordCount: transcript.wordCount,
    fullText: transcript.fullText,
    summary,
    tags: [...new Set([...tags, ...autoTags])],
    fetchedAt: transcript.fetchedAt,
  });

  const entry: IndexEntry = {
    id: transcript.videoId,
    type: "youtube-transcript",
    title: transcript.title,
    url: transcript.url,
    summary,
    tags: [...new Set([...tags, ...autoTags])],
    fetchedAt: transcript.fetchedAt,
    filePath: `${transcript.videoId}.md`,
    wordCount: transcript.wordCount,
    channel: transcript.channelName,
    duration: transcript.durationSeconds,
  };
  await upsertEntry(entry);
  await generateMOC();

  return entry;
}
