/**
 * TypeScript client for self-hosted Crawl4AI instance.
 * Crawl4AI outputs clean markdown — 30-50% fewer tokens than raw HTML.
 */

import { config } from '../config.js';
import { truncateToTokenBudget } from '../context/truncator.js';

export interface ScrapeResult {
  url: string;
  markdown: string;
  title: string;
  tokenEstimate: number;
  truncated: boolean;
}

export interface CrawlResult {
  pages: ScrapeResult[];
  totalPages: number;
}

/**
 * Scrape a single page → clean markdown.
 */
export async function scrape(url: string): Promise<ScrapeResult> {
  const response = await fetch(`${config.crawl4aiUrl}/scrape`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url,
      output_format: 'markdown',
      remove_selectors: [
        'nav',
        'footer',
        'header',
        '.sidebar',
        '.cookie-banner',
      ],
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    throw new Error(
      `Crawl4AI scrape failed: ${response.status} ${response.statusText}`,
    );
  }

  const data = (await response.json()) as {
    markdown?: string;
    title?: string;
    url?: string;
  };

  const rawMarkdown = data.markdown || '';
  const tokenEstimate = Math.ceil(rawMarkdown.length / 3.5);
  const needsTruncation = tokenEstimate > config.maxToolResultTokens;

  const markdown = needsTruncation
    ? truncateToTokenBudget(
        rawMarkdown,
        config.maxToolResultTokens,
        `full content at ${url}`,
      )
    : rawMarkdown;

  return {
    url: data.url || url,
    markdown,
    title: data.title || '',
    tokenEstimate: needsTruncation ? config.maxToolResultTokens : tokenEstimate,
    truncated: needsTruncation,
  };
}

/**
 * Multi-page BFS crawl → array of markdown pages.
 */
export async function crawl(
  startUrl: string,
  maxPages = 5,
): Promise<CrawlResult> {
  const response = await fetch(`${config.crawl4aiUrl}/crawl`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: startUrl,
      max_pages: maxPages,
      output_format: 'markdown',
      remove_selectors: ['nav', 'footer', 'header', '.sidebar'],
    }),
    signal: AbortSignal.timeout(120_000),
  });

  if (!response.ok) {
    throw new Error(
      `Crawl4AI crawl failed: ${response.status} ${response.statusText}`,
    );
  }

  const data = (await response.json()) as {
    pages?: Array<{ url: string; markdown: string; title: string }>;
  };

  const pages = (data.pages || []).map((page) => {
    const tokenEstimate = Math.ceil(page.markdown.length / 3.5);
    const needsTruncation = tokenEstimate > config.maxToolResultTokens;
    return {
      url: page.url,
      markdown: needsTruncation
        ? truncateToTokenBudget(
            page.markdown,
            config.maxToolResultTokens,
            `full at ${page.url}`,
          )
        : page.markdown,
      title: page.title,
      tokenEstimate: needsTruncation
        ? config.maxToolResultTokens
        : tokenEstimate,
      truncated: needsTruncation,
    };
  });

  return { pages, totalPages: pages.length };
}

/**
 * Check if Crawl4AI is available.
 */
export async function isAvailable(): Promise<boolean> {
  try {
    const response = await fetch(`${config.crawl4aiUrl}/health`, {
      signal: AbortSignal.timeout(5_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}
