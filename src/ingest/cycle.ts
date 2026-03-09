/**
 * Ingestion cycle runners — called by the scheduler or manually via REST API.
 * Pure orchestration: loads sources, calls ingest functions, returns results.
 */

import { loadSources } from "./sources.js";
import { ingestUserTimeline, ingestSearchTweets } from "./x-twitter.js";
import { ingestYouTubeVideo, getChannelRecentVideos } from "./youtube.js";

export interface IngestionResult {
  source: string;
  type: "youtube" | "x-timeline" | "x-search" | "rss" | "github" | "substack";
  itemsIngested: number;
  errors: string[];
}

/**
 * Run a full ingestion cycle for all X/Twitter sources.
 */
export async function runXIngestionCycle(): Promise<IngestionResult[]> {
  const sources = loadSources();
  const results: IngestionResult[] = [];

  for (const account of sources.xAccounts) {
    try {
      const tweets = await ingestUserTimeline(account.handle, 10);
      results.push({
        source: `@${account.handle}`,
        type: "x-timeline",
        itemsIngested: tweets.length,
        errors: [],
      });
    } catch (err) {
      results.push({
        source: `@${account.handle}`,
        type: "x-timeline",
        itemsIngested: 0,
        errors: [err instanceof Error ? err.message : String(err)],
      });
    }
  }

  for (const term of sources.xSearchTerms) {
    try {
      const tweets = await ingestSearchTweets(term.query, 10);
      results.push({
        source: `search:"${term.query}"`,
        type: "x-search",
        itemsIngested: tweets.length,
        errors: [],
      });
    } catch (err) {
      results.push({
        source: `search:"${term.query}"`,
        type: "x-search",
        itemsIngested: 0,
        errors: [err instanceof Error ? err.message : String(err)],
      });
    }
  }

  return results;
}

/**
 * Run a full ingestion cycle for all configured YouTube channel sources.
 * Fetches recent video IDs via RSS, then ingests each transcript into the vault.
 */
export async function runYouTubeIngestionCycle(): Promise<IngestionResult[]> {
  const sources = loadSources();
  const results: IngestionResult[] = [];

  for (const ch of sources.youtube) {
    const errors: string[] = [];
    let itemsIngested = 0;

    try {
      const videoIds = await getChannelRecentVideos(ch.channelId);

      for (const id of videoIds) {
        try {
          await ingestYouTubeVideo(id, ch.language ?? "en", ch.tags);
          itemsIngested++;
        } catch (err) {
          errors.push(err instanceof Error ? err.message : String(err));
        }
      }
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }

    results.push({
      source: ch.name,
      type: "youtube",
      itemsIngested,
      errors,
    });
  }

  return results;
}
