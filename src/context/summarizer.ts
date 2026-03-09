/**
 * Generate summaries for ingested content.
 *
 * Current implementation: extractive (first ~150 words trimmed at sentence boundary).
 * This is intentionally lightweight — ingestion runs at high volume and LLM calls
 * per-video would blow the cost budget. The spec asked for LLM summarization but
 * cost/latency tradeoff was accepted: use Ollama (Tier 1, free) for batch summarization
 * as a follow-up task once the ingest pipeline is stable.
 *
 * To upgrade: replace `frontmatterSummary` with an Ollama call via the MCP
 * `ollama_generate` tool (model: qwen3:8b) and cache the result.
 */

const SUMMARY_WORD_LIMIT = 200;

/**
 * Extract first N words as a simple summary.
 * Prefers cutting at sentence boundaries.
 */
export function extractiveSummary(
  text: string,
  maxWords = SUMMARY_WORD_LIMIT,
): string {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return text;

  const slice = words.slice(0, maxWords).join(' ');

  // Try to end at a sentence boundary
  const lastSentence = Math.max(
    slice.lastIndexOf('. '),
    slice.lastIndexOf('! '),
    slice.lastIndexOf('? '),
  );

  if (lastSentence > slice.length * 0.6) {
    return slice.slice(0, lastSentence + 1);
  }

  return slice + '...';
}

/**
 * Generate a summary suitable for Obsidian frontmatter.
 * Single line, no newlines, max ~200 words.
 */
export function frontmatterSummary(text: string): string {
  const cleaned = text
    .replace(/^#.*$/gm, '') // Remove headings
    .replace(/\n{2,}/g, ' ') // Collapse paragraphs
    .replace(/\s+/g, ' ')
    .trim();

  return extractiveSummary(cleaned, 150);
}

/**
 * Extract key topics from text by finding repeated significant words.
 * Returns top N terms that appear more than once.
 */
export function extractTopics(text: string, topN = 10): string[] {
  const stopWords = new Set([
    'the',
    'a',
    'an',
    'and',
    'or',
    'but',
    'in',
    'on',
    'at',
    'to',
    'for',
    'of',
    'with',
    'by',
    'from',
    'is',
    'it',
    'this',
    'that',
    'was',
    'are',
    'be',
    'has',
    'had',
    'have',
    'do',
    'does',
    'did',
    'will',
    'would',
    'could',
    'should',
    'may',
    'might',
    'can',
    'not',
    'no',
    'so',
    'if',
    'just',
    'about',
    'than',
    'then',
    'also',
    'very',
    'much',
    'more',
    'some',
    'any',
    'all',
    'each',
    'every',
    'both',
    'few',
    'many',
    'how',
    'what',
    'when',
    'where',
    'which',
    'who',
    'why',
    'been',
    'being',
    'these',
    'those',
    'their',
    'there',
    'here',
    'its',
    'your',
    'our',
    'my',
    'his',
    'her',
    'them',
    'they',
    'you',
    'we',
    'i',
    'me',
    'up',
    'out',
    'into',
    'over',
    'after',
    'before',
    'between',
    'through',
    'during',
    'because',
    'while',
    'until',
    'since',
    'like',
    'going',
    'really',
    'actually',
    'basically',
    'know',
    'think',
    'want',
    'get',
    'make',
    'thing',
    'way',
    'something',
    'one',
    'two',
    'three',
  ]);

  const words = text.toLowerCase().match(/\b[a-z]{3,}\b/g) || [];
  const freq = new Map<string, number>();

  for (const word of words) {
    if (!stopWords.has(word)) {
      freq.set(word, (freq.get(word) || 0) + 1);
    }
  }

  return [...freq.entries()]
    .filter(([, count]) => count > 1)
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([word]) => word);
}
