/**
 * Nitter instance pool for free X/Twitter scraping.
 * Nitter is an open-source Twitter frontend that exposes RSS feeds.
 * No authentication needed.
 *
 * Instance availability changes frequently — the pool self-heals via health checks.
 */

const NITTER_INSTANCES = [
  'https://nitter.net',
  'https://nitter.privacydev.net',
  'https://nitter.poast.org',
  'https://nitter.cz',
  'https://nitter.1d4.us',
];

interface NitterTweet {
  id: string;
  author: string;
  authorName: string;
  text: string;
  date: string;
  url: string;
  isReply: boolean;
}

const healthyInstances = new Set<string>(NITTER_INSTANCES);
const failedInstances = new Set<string>();

async function tryFetch(
  url: string,
  timeoutMs = 10_000,
): Promise<Response | null> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; SwarmBot/1.0)',
      },
    });
    if (response.ok) return response;
    return null;
  } catch {
    return null;
  }
}

/**
 * Health-check a Nitter instance.
 */
async function checkInstance(instance: string): Promise<boolean> {
  const response = await tryFetch(`${instance}/jack`, 5_000);
  if (response) {
    healthyInstances.add(instance);
    failedInstances.delete(instance);
    return true;
  }
  healthyInstances.delete(instance);
  failedInstances.add(instance);
  return false;
}

/**
 * Get a healthy Nitter instance. Round-robins through healthy pool.
 */
function getNextInstance(): string | null {
  const healthy = [...healthyInstances];
  if (healthy.length === 0) return null;
  // Simple round-robin via random selection
  return healthy[Math.floor(Math.random() * healthy.length)]!;
}

/**
 * Fetch a user's recent tweets via Nitter RSS.
 */
export async function fetchUserTimeline(
  username: string,
  limit = 20,
): Promise<NitterTweet[]> {
  const instance = getNextInstance();
  if (!instance) return [];

  const response = await tryFetch(`${instance}/${username}/rss`);
  if (!response) {
    failedInstances.add(instance);
    healthyInstances.delete(instance);
    return [];
  }

  const xml = await response.text();
  return parseRssTweets(xml, username).slice(0, limit);
}

/**
 * Fetch a single tweet page from Nitter.
 */
export async function fetchTweetPage(
  username: string,
  tweetId: string,
): Promise<string | null> {
  const instance = getNextInstance();
  if (!instance) return null;

  const response = await tryFetch(`${instance}/${username}/status/${tweetId}`);
  if (!response) {
    failedInstances.add(instance);
    healthyInstances.delete(instance);
    return null;
  }

  return response.text();
}

/**
 * Search tweets via Nitter.
 */
export async function searchNitter(
  query: string,
  limit = 20,
): Promise<NitterTweet[]> {
  const instance = getNextInstance();
  if (!instance) return [];

  const response = await tryFetch(
    `${instance}/search/rss?f=tweets&q=${encodeURIComponent(query)}`,
  );
  if (!response) return [];

  const xml = await response.text();
  return parseRssTweets(xml).slice(0, limit);
}

/**
 * Run health checks on all instances.
 */
export async function refreshInstancePool(): Promise<number> {
  const checks = NITTER_INSTANCES.map(checkInstance);
  const results = await Promise.allSettled(checks);
  return results.filter((r) => r.status === 'fulfilled' && r.value).length;
}

/**
 * Parse Nitter RSS XML into tweet objects.
 */
function parseRssTweets(xml: string, defaultAuthor = ''): NitterTweet[] {
  const tweets: NitterTweet[] = [];

  // Simple XML parsing — Nitter RSS is well-structured
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let itemMatch: RegExpExecArray | null;

  while ((itemMatch = itemRe.exec(xml)) !== null) {
    const item = itemMatch[1]!;

    const title = extractXmlTag(item, 'title') || '';
    const link = extractXmlTag(item, 'link') || '';
    const description = extractXmlTag(item, 'description') || '';
    const pubDate = extractXmlTag(item, 'pubDate') || '';
    const creator = extractXmlTag(item, 'dc:creator') || defaultAuthor;

    // Extract tweet ID from link
    const idMatch = link.match(/status\/(\d+)/);
    if (!idMatch?.[1]) continue;

    // Clean HTML from description
    const text = description
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .trim();

    tweets.push({
      id: idMatch[1],
      author: creator.replace('@', ''),
      authorName: creator.replace('@', ''),
      text,
      date: pubDate,
      url: link.replace(/nitter\.\w+/, 'x.com'),
      isReply: title.startsWith('R to'),
    });
  }

  return tweets;
}

function extractXmlTag(xml: string, tag: string): string | null {
  const re = new RegExp(
    `<${tag}[^>]*>(?:<!\\[CDATA\\[)?(.*?)(?:\\]\\]>)?<\\/${tag}>`,
    's',
  );
  const match = xml.match(re);
  return match?.[1] ?? null;
}

export function getInstanceStatus(): { healthy: string[]; failed: string[] } {
  return {
    healthy: [...healthyInstances],
    failed: [...failedInstances],
  };
}
