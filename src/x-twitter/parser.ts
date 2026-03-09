/**
 * Clean and convert X/Twitter content to Obsidian-compatible markdown.
 */

// t.co shortened URLs → we can't resolve without HTTP, but mark them
const TCO_RE = /https?:\/\/t\.co\/\w+/g;

// @mention → clickable link
const MENTION_RE = /@(\w{1,15})/g;

// #hashtag → Obsidian tag
const HASHTAG_RE = /#(\w+)/g;

// "Replying to @user" noise
const REPLY_NOISE_RE = /^Replying to @\w+\s*/gm;

// Multiple newlines
const MULTI_NEWLINE_RE = /\n{3,}/g;

/**
 * Clean a single tweet's text content.
 */
export function cleanTweetText(text: string): string {
  let cleaned = text;

  // Remove "Replying to" noise
  cleaned = cleaned.replace(REPLY_NOISE_RE, '');

  // Convert @mentions to markdown links
  cleaned = cleaned.replace(MENTION_RE, '[@$1](https://x.com/$1)');

  // Convert #hashtags to Obsidian tags (keep the # for Obsidian)
  // Only convert if not already inside a link
  cleaned = cleaned.replace(HASHTAG_RE, (match, tag: string) => `#${tag}`);

  // Collapse multiple newlines
  cleaned = cleaned.replace(MULTI_NEWLINE_RE, '\n\n');

  return cleaned.trim();
}

/**
 * Format a thread (array of tweet texts) into a single markdown document.
 */
export function formatThread(tweets: string[]): string {
  if (tweets.length === 1) {
    return cleanTweetText(tweets[0]!);
  }

  return tweets
    .map((text, i) => {
      const cleaned = cleanTweetText(text);
      return `**${i + 1}/${tweets.length}:**\n${cleaned}`;
    })
    .join('\n\n---\n\n');
}

/**
 * Extract metadata from tweet content.
 */
export function extractTweetMeta(text: string): {
  mentions: string[];
  hashtags: string[];
  urls: string[];
  hasMedia: boolean;
} {
  const mentions = [...text.matchAll(/@(\w{1,15})/g)].map((m) => m[1]!);
  const hashtags = [...text.matchAll(/#(\w+)/g)].map((m) => m[1]!);
  const urls = [...text.matchAll(/https?:\/\/[^\s)]+/g)].map((m) => m[0]);
  const hasMedia =
    /(?:pic\.twitter\.com|pbs\.twimg\.com|video\.twimg\.com)/.test(text);

  return {
    mentions: [...new Set(mentions)],
    hashtags: [...new Set(hashtags)],
    urls,
    hasMedia,
  };
}

/**
 * Extract tweet ID from various X/Twitter URL formats.
 */
export function extractTweetId(urlOrId: string): string {
  // Already a numeric ID
  if (/^\d+$/.test(urlOrId)) return urlOrId;

  // x.com or twitter.com status URL
  const match = urlOrId.match(/(?:twitter\.com|x\.com)\/\w+\/status\/(\d+)/);
  if (match?.[1]) return match[1];

  throw new Error(`Cannot extract tweet ID from: ${urlOrId}`);
}
