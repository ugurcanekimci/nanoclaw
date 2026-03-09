/**
 * 5-layer scraping decision router.
 * Replaces Bright Data with a cascade of open-source tools.
 *
 * Decision tree:
 *   YouTube URL → YouTube transcript fetcher
 *   X/Twitter URL → X fetcher (Nitter → Crawl4AI → Apify)
 *   Public site → Crawl4AI direct (free)
 *   Protected site → Crawl4AI + residential proxy
 *   Heavy protection → Camoufox + proxy (future: when Python bridge is built)
 *   Structured platform → Apify Actor
 */

import { scrape, isAvailable as crawl4aiAvailable } from './crawl4ai-client.js';
import { getRotatingProxy, type ProxyEndpoint } from './proxy-pool.js';
import { config } from '../config.js';

export type ScrapeLayer = 'direct' | 'proxy' | 'camoufox' | 'apify' | 'failed';

export interface ScrapeDecision {
  layer: ScrapeLayer;
  url: string;
  markdown: string;
  tokenEstimate: number;
}

const YOUTUBE_RE = /(?:youtube\.com|youtu\.be)\//;
const X_RE = /(?:twitter\.com|x\.com)\//;

/**
 * Route a URL through the scraping cascade.
 */
export async function smartScrape(url: string): Promise<ScrapeDecision> {
  // YouTube and X have dedicated fetchers — don't scrape them here
  if (YOUTUBE_RE.test(url)) {
    return {
      layer: 'failed',
      url,
      markdown: '[Use fetch_transcript for YouTube URLs]',
      tokenEstimate: 10,
    };
  }
  if (X_RE.test(url)) {
    return {
      layer: 'failed',
      url,
      markdown: '[Use fetch_tweet for X/Twitter URLs]',
      tokenEstimate: 10,
    };
  }

  // Layer 1: Crawl4AI direct (free, fast)
  if (await crawl4aiAvailable()) {
    try {
      const result = await scrape(url);
      if (result.markdown && result.markdown.length > 100) {
        return {
          layer: 'direct',
          url: result.url,
          markdown: result.markdown,
          tokenEstimate: result.tokenEstimate,
        };
      }
    } catch {
      // Fall through to proxy layer
    }
  }

  // Layer 2: Crawl4AI + proxy (for light protection)
  const proxy = getRotatingProxy();
  if (proxy) {
    try {
      // Crawl4AI with proxy config
      const result = await scrapeWithProxy(url, proxy);
      if (result) {
        return {
          layer: 'proxy',
          url,
          markdown: result,
          tokenEstimate: Math.ceil(result.length / 3.5),
        };
      }
    } catch {
      // Fall through
    }
  }

  // Layer 3: Camoufox (for heavy protection)
  // TODO: Implement Python bridge to Camoufox
  // For now, skip to Apify

  // Layer 4: Apify (paid fallback)
  if (config.apifyToken) {
    try {
      const result = await scrapeViaApify(url);
      if (result) {
        return {
          layer: 'apify',
          url,
          markdown: result,
          tokenEstimate: Math.ceil(result.length / 3.5),
        };
      }
    } catch {
      // Fall through
    }
  }

  return {
    layer: 'failed',
    url,
    markdown: `[Failed to scrape ${url} — all layers exhausted]`,
    tokenEstimate: 15,
  };
}

async function scrapeWithProxy(
  url: string,
  proxy: ProxyEndpoint,
): Promise<string | null> {
  try {
    const response = await fetch(`${config.crawl4aiUrl}/scrape`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url,
        output_format: 'markdown',
        proxy: {
          server: proxy.server,
          username: proxy.username,
          password: proxy.password,
        },
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { markdown?: string };
    return data.markdown || null;
  } catch {
    return null;
  }
}

async function scrapeViaApify(url: string): Promise<string | null> {
  try {
    const response = await fetch(
      `https://api.apify.com/v2/acts/apify~website-content-crawler/run-sync-get-dataset-items?token=${config.apifyToken}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          startUrls: [{ url }],
          maxCrawlPages: 1,
          outputFormats: ['markdown'],
        }),
        signal: AbortSignal.timeout(60_000),
      },
    );
    if (!response.ok) return null;
    const results = (await response.json()) as Array<{
      markdown?: string;
      text?: string;
    }>;
    if (results.length === 0) return null;
    return results[0]!.markdown || results[0]!.text || null;
  } catch {
    return null;
  }
}
