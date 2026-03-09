/**
 * X/Twitter content fetcher with fallback cascade:
 *   Nitter RSS (free) → Crawl4AI+Camoufox (proxy cost) → Apify (credits)
 */

import { config } from '../config.js';
import {
  extractTweetId,
  extractTweetMeta,
  formatThread,
  cleanTweetText,
} from './parser.js';
import {
  fetchTweetPage,
  fetchUserTimeline as fetchNitterTimeline,
  searchNitter,
} from './nitter.js';
import { extractTopics } from '../context/summarizer.js';

export interface FetchedTweet {
  tweetId: string;
  author: string;
  authorName: string;
  url: string;
  content: string;
  isThread: boolean;
  tweetCount: number;
  fetchedAt: string;
  tags: string[];
}

/**
 * Fetch a single tweet or thread by URL.
 * Cascade: Nitter → Crawl4AI → Apify
 */
export async function fetchTweet(urlOrId: string): Promise<FetchedTweet> {
  const tweetId = extractTweetId(urlOrId);
  const url = `https://x.com/i/status/${tweetId}`;

  // Try Nitter first — extract username from URL if available
  const usernameMatch = urlOrId.match(/(?:twitter\.com|x\.com)\/(\w+)\/status/);
  const username = usernameMatch?.[1] || 'i';

  let rawContent: string | null = null;

  // Layer 1: Nitter
  const nitterHtml = await fetchTweetPage(username, tweetId);
  if (nitterHtml) {
    rawContent = extractTextFromNitterHtml(nitterHtml);
  }

  // Layer 2: Crawl4AI (if configured)
  if (!rawContent && config.crawl4aiUrl) {
    rawContent = await fetchViaCrawl4AI(url);
  }

  // Layer 3: Apify fallback
  if (!rawContent && config.apifyToken) {
    rawContent = await fetchViaApify(tweetId);
  }

  if (!rawContent) {
    throw new Error(`Failed to fetch tweet ${tweetId} — all sources exhausted`);
  }

  const cleaned = cleanTweetText(rawContent);
  const meta = extractTweetMeta(rawContent);
  const topics = extractTopics(cleaned);
  const tags = [...new Set([...meta.hashtags, ...topics.slice(0, 5)])];

  const result: FetchedTweet = {
    tweetId,
    author: username !== 'i' ? username : meta.mentions[0] || 'unknown',
    authorName: username !== 'i' ? username : meta.mentions[0] || 'unknown',
    url: `https://x.com/${username}/status/${tweetId}`,
    content: cleaned,
    isThread: cleaned.includes('---'), // Simple thread detection
    tweetCount: (cleaned.match(/\*\*\d+\/\d+:\*\*/g) || []).length || 1,
    fetchedAt: new Date().toISOString(),
    tags,
  };

  return result;
}

/**
 * Fetch recent tweets from a user (pure data, no storage).
 */
export async function fetchUserTimelineRaw(
  username: string,
  limit = 20,
): Promise<FetchedTweet[]> {
  const nitterTweets = await fetchNitterTimeline(username, limit);

  return nitterTweets.map((tweet) => {
    const cleaned = cleanTweetText(tweet.text);
    const meta = extractTweetMeta(tweet.text);
    const topics = extractTopics(cleaned);

    return {
      tweetId: tweet.id,
      author: tweet.author,
      authorName: tweet.authorName,
      url: tweet.url,
      content: cleaned,
      isThread: false,
      tweetCount: 1,
      fetchedAt: new Date().toISOString(),
      tags: [...new Set([...meta.hashtags, ...topics.slice(0, 5)])],
    };
  });
}

/**
 * Search X by keyword (pure data, no storage).
 */
export async function searchTweetsRaw(
  query: string,
  limit = 20,
): Promise<FetchedTweet[]> {
  const nitterResults = await searchNitter(query, limit);

  return nitterResults.map((tweet) => {
    const cleaned = cleanTweetText(tweet.text);
    const meta = extractTweetMeta(tweet.text);

    return {
      tweetId: tweet.id,
      author: tweet.author,
      authorName: tweet.authorName,
      url: tweet.url,
      content: cleaned,
      isThread: false,
      tweetCount: 1,
      fetchedAt: new Date().toISOString(),
      tags: [
        ...new Set([...meta.hashtags, ...extractTopics(cleaned).slice(0, 5)]),
      ],
    };
  });
}

// --- Internal helpers ---

function extractTextFromNitterHtml(html: string): string | null {
  // Nitter renders tweet content in .tweet-content divs
  const contentRe = /<div class="tweet-content[^"]*"[^>]*>([\s\S]*?)<\/div>/g;
  const matches: string[] = [];
  let m: RegExpExecArray | null;

  while ((m = contentRe.exec(html)) !== null) {
    const text = m[1]!
      .replace(/<br\s*\/?>/g, '\n')
      .replace(/<a[^>]*href="([^"]*)"[^>]*>[^<]*<\/a>/g, '$1')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .trim();
    if (text) matches.push(text);
  }

  return matches.length > 0 ? formatThread(matches) : null;
}

async function fetchViaCrawl4AI(url: string): Promise<string | null> {
  try {
    const response = await fetch(`${config.crawl4aiUrl}/scrape`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, output_format: 'markdown' }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { markdown?: string };
    return data.markdown || null;
  } catch {
    return null;
  }
}

async function fetchViaApify(tweetId: string): Promise<string | null> {
  if (!config.apifyToken) return null;

  try {
    const response = await fetch(
      `https://api.apify.com/v2/acts/apify~twitter-scraper/run-sync-get-dataset-items?token=${config.apifyToken}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tweetIDs: [tweetId],
          maxItems: 1,
        }),
        signal: AbortSignal.timeout(60_000),
      },
    );
    if (!response.ok) return null;
    const results = (await response.json()) as Array<{
      full_text?: string;
      text?: string;
    }>;
    if (results.length === 0) return null;
    return results[0]!.full_text || results[0]!.text || null;
  } catch {
    return null;
  }
}
