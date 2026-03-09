import { config } from '../config.js';
import type { TranscriptSegment } from '../types.js';

interface ApifyTranscriptResult {
  text?: string;
  transcriptText?: string;
  captions?: Array<{ text: string; start: number; dur: number }>;
}

/**
 * Fetch transcript via Apify YouTube Transcript Scraper actor.
 * Returns null if APIFY_API_TOKEN is not configured.
 */
export async function fetchViaApify(
  videoUrl: string,
  language: string,
): Promise<TranscriptSegment[] | null> {
  if (!config.apifyToken) return null;

  const runUrl =
    'https://api.apify.com/v2/acts/topaz_sharingan~youtube-transcript-scraper/run-sync-get-dataset-items';

  const response = await fetch(`${runUrl}?token=${config.apifyToken}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      urls: [videoUrl],
      language,
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!response.ok) {
    throw new Error(
      `Apify request failed: ${response.status} ${response.statusText}`,
    );
  }

  const results = (await response.json()) as ApifyTranscriptResult[];
  if (!results.length) return null;

  const result = results[0]!;

  if (result.captions && result.captions.length > 0) {
    return result.captions.map((c) => ({
      text: c.text,
      offset: c.start,
      duration: c.dur,
      lang: language,
    }));
  }

  const text = result.transcriptText ?? result.text;
  if (text) {
    return [{ text, offset: 0, duration: 0, lang: language }];
  }

  return null;
}
