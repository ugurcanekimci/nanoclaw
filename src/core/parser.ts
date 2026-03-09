import type { TranscriptSegment } from '../types.js';

const HTML_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
};

const ENTITY_RE = /&(?:amp|lt|gt|quot|apos|nbsp|#39);/g;
const MUSIC_RE = /\[(?:Music|Applause|Laughter)\]/gi;
const FILLER_RE = /\b(?:um|uh|hmm|erm)\b/gi;
const MULTI_SPACE_RE = /\s{2,}/g;
const PARA_GAP_SECONDS = 2;

function decodeEntities(text: string): string {
  return text.replace(ENTITY_RE, (match) => HTML_ENTITIES[match] ?? match);
}

function cleanText(text: string): string {
  let cleaned = decodeEntities(text);
  cleaned = cleaned.replace(MUSIC_RE, '');
  cleaned = cleaned.replace(FILLER_RE, '');
  cleaned = cleaned.replace(MULTI_SPACE_RE, ' ');
  return cleaned.trim();
}

/**
 * Convert transcript segments into cleaned text with paragraph breaks.
 * Paragraphs are inserted where gaps between segments exceed PARA_GAP_SECONDS.
 */
export function segmentsToText(segments: TranscriptSegment[]): string {
  if (segments.length === 0) return '';

  const paragraphs: string[] = [];
  let currentParagraph: string[] = [];

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]!;
    const cleaned = cleanText(segment.text);
    if (!cleaned) continue;

    if (i > 0 && currentParagraph.length > 0) {
      const prev = segments[i - 1]!;
      const prevEnd = prev.offset + prev.duration;
      const gap = segment.offset - prevEnd;
      if (gap >= PARA_GAP_SECONDS) {
        paragraphs.push(currentParagraph.join(' '));
        currentParagraph = [];
      }
    }

    currentParagraph.push(cleaned);
  }

  if (currentParagraph.length > 0) {
    paragraphs.push(currentParagraph.join(' '));
  }

  return paragraphs.join('\n\n');
}

export function wordCount(text: string): number {
  if (!text) return 0;
  return text.split(/\s+/).filter(Boolean).length;
}

export function totalDuration(segments: TranscriptSegment[]): number {
  if (segments.length === 0) return 0;
  const last = segments[segments.length - 1]!;
  return Math.ceil(last.offset + last.duration);
}
