/**
 * Watched sources configuration for scheduled ingestion.
 * Runtime config loaded from data/sources.json, with TypeScript defaults as fallback.
 */

import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";

export interface YouTubeSource {
  channelId: string;
  name: string;
  tags: string[];
  schedule: string; // cron expression
}

export interface XSource {
  handle: string;
  tags: string[];
  schedule: string;
}

export interface XSearchSource {
  query: string;
  schedule: string;
}

export interface RssSource {
  url: string;
  name: string;
  schedule: string;
}

export interface GithubSource {
  owner: string;
  repo: string;
  schedule: string;
}

export interface SubstackSource {
  publication: string;
  schedule: string;
}

export interface SourceConfig {
  youtube: YouTubeSource[];
  xAccounts: XSource[];
  xSearchTerms: XSearchSource[];
  rssFeeds: RssSource[];
  githubRepos: GithubSource[];
  substackNewsletters: SubstackSource[];
}

const DEFAULTS: SourceConfig = {
  youtube: [],
  xAccounts: [],
  xSearchTerms: [],
  rssFeeds: [],
  githubRepos: [],
  substackNewsletters: [],
};

const sourcesPath = path.join(config.dataDir, "sources.json");

/**
 * Load sources from data/sources.json, falling back to defaults.
 */
export function loadSources(): SourceConfig {
  try {
    if (fs.existsSync(sourcesPath)) {
      const raw = fs.readFileSync(sourcesPath, "utf-8");
      return { ...DEFAULTS, ...JSON.parse(raw) };
    }
  } catch (err) {
    console.error(`[sources] Failed to load ${sourcesPath}, using defaults:`, err);
  }
  return DEFAULTS;
}

/**
 * Save sources to data/sources.json.
 */
export function saveSources(sources: SourceConfig): void {
  fs.mkdirSync(path.dirname(sourcesPath), { recursive: true });
  fs.writeFileSync(sourcesPath, JSON.stringify(sources, null, 2));
}
