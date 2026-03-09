import { config } from '../config.js';

/**
 * Approximate token count. English text averages ~4 chars per token.
 * This is deliberately conservative (overestimates) to stay within budget.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

/**
 * Truncate text to stay within a token budget.
 * Cuts at paragraph boundaries when possible.
 */
export function truncateToTokenBudget(
  text: string,
  maxTokens = config.maxToolResultTokens,
  hint?: string,
): string {
  const estimated = estimateTokens(text);
  if (estimated <= maxTokens) return text;

  const maxChars = Math.floor(maxTokens * 3.5);
  const truncated = text.slice(0, maxChars);

  // Try to cut at a paragraph boundary
  const lastPara = truncated.lastIndexOf('\n\n');
  const cutPoint =
    lastPara > maxChars * 0.7 ? lastPara : truncated.lastIndexOf('\n');
  const final =
    cutPoint > maxChars * 0.5 ? truncated.slice(0, cutPoint) : truncated;

  const suffix = hint
    ? `\n\n[... truncated at ${maxTokens} tokens — ${hint}]`
    : `\n\n[... truncated at ${maxTokens} tokens]`;

  return final + suffix;
}

/**
 * Truncate an array of search results to fit within budget.
 * Returns as many full results as possible, then truncates the last one.
 */
export function truncateResults<T extends { text: string }>(
  results: T[],
  maxTokens = config.maxToolResultTokens,
): T[] {
  let remaining = maxTokens;
  const output: T[] = [];

  for (const result of results) {
    const tokens = estimateTokens(result.text);
    if (tokens <= remaining) {
      output.push(result);
      remaining -= tokens;
    } else if (remaining > 200) {
      output.push({
        ...result,
        text: truncateToTokenBudget(result.text, remaining),
      });
      break;
    } else {
      break;
    }
  }

  return output;
}
