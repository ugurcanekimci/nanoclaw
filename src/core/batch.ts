import { config } from '../config.js';
import { getTranscript, extractVideoId } from './transcript.js';
import type { BatchResult } from '../types.js';

/**
 * Process multiple YouTube URLs with concurrency limiting.
 * Each URL is independent — failures don't block successes.
 */
export async function batchFetch(
  urls: string[],
  language: string,
  concurrency = config.batchConcurrency,
): Promise<BatchResult[]> {
  const results: BatchResult[] = [];
  const queue = [...urls];
  const active: Promise<void>[] = [];

  async function processOne(url: string): Promise<void> {
    let videoId: string;
    try {
      videoId = extractVideoId(url);
    } catch {
      results.push({
        url,
        videoId: '',
        status: 'error',
        error: 'Invalid YouTube URL or video ID',
      });
      return;
    }

    try {
      const transcript = await getTranscript(url, language);
      results.push({ url, videoId, status: 'success', transcript });
    } catch (err) {
      results.push({
        url,
        videoId,
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  while (queue.length > 0 || active.length > 0) {
    while (active.length < concurrency && queue.length > 0) {
      const url = queue.shift()!;
      const p = processOne(url).then(() => {
        active.splice(active.indexOf(p), 1);
      });
      active.push(p);
    }
    if (active.length > 0) {
      await Promise.race(active);
    }
  }

  return results;
}
