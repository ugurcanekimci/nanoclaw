import { join } from 'node:path';
import {
  fetchTranscript as ytFetchTranscript,
  FsCache,
} from 'youtube-transcript-plus';
import { config } from '../config.js';
import { fetchViaApify } from '../fallback/apify.js';
import { segmentsToText, wordCount, totalDuration } from './parser.js';
import type { Transcript, TranscriptSegment } from '../types.js';

const cache = new FsCache(join(config.dataDir, 'cache'), config.cacheTTL);

const VIDEO_ID_RE =
  /(?:youtube\.com\/(?:watch\?.*v=|embed\/|shorts\/|live\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;

export function extractVideoId(urlOrId: string): string {
  if (/^[a-zA-Z0-9_-]{11}$/.test(urlOrId)) return urlOrId;
  const match = urlOrId.match(VIDEO_ID_RE);
  if (match?.[1]) return match[1];
  throw new Error(`Cannot extract video ID from: ${urlOrId}`);
}

interface OEmbedMeta {
  title: string;
  channelName: string;
}

/**
 * Fetch video title and channel name via YouTube oEmbed API (no API key required).
 * Returns empty strings on failure so ingest continues gracefully.
 */
async function fetchOEmbedMeta(videoId: string): Promise<OEmbedMeta> {
  try {
    const url = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
    const res = await fetch(url);
    if (!res.ok) return { title: '', channelName: '' };
    const data = (await res.json()) as { title?: string; author_name?: string };
    return {
      title: data.title || '',
      channelName: data.author_name || '',
    };
  } catch {
    return { title: '', channelName: '' };
  }
}

/**
 * Fetch a YouTube transcript with automatic Apify fallback on non-rate-limit errors.
 */
export async function getTranscript(
  urlOrId: string,
  language = config.defaultLanguage,
): Promise<Transcript> {
  const videoId = extractVideoId(urlOrId);
  const url = `https://www.youtube.com/watch?v=${videoId}`;

  let segments: TranscriptSegment[];

  try {
    const raw = await ytFetchTranscript(videoId, {
      lang: language,
      cache,
      cacheTTL: config.cacheTTL,
    });
    segments = raw.map((s) => ({
      text: s.text,
      offset: s.offset,
      duration: s.duration,
      lang: s.lang,
    }));
  } catch (err) {
    // Don't fallback on rate limits — propagate immediately
    if (
      err instanceof Error &&
      err.name === 'YoutubeTranscriptTooManyRequestError'
    )
      throw err;

    const apifyResult = await fetchViaApify(url, language);
    if (apifyResult && apifyResult.length > 0) {
      segments = apifyResult;
    } else {
      throw err;
    }
  }

  const fullText = segmentsToText(segments);
  const meta = await fetchOEmbedMeta(videoId);
  const fetchedAt = new Date().toISOString();

  return {
    videoId,
    title: meta.title,
    channelName: meta.channelName,
    url,
    language,
    fetchedAt,
    durationSeconds: totalDuration(segments),
    segments,
    fullText,
    wordCount: wordCount(fullText),
  };
}
