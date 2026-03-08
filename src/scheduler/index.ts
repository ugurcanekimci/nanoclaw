/**
 * Direct scheduler — runs ingestion jobs via node-cron.
 * No LLM, no container — calls ingest functions directly.
 */

import * as cron from "node-cron";
import { loadSources, type SourceConfig } from "../ingest/sources.js";
import { ingestUserTimeline, ingestSearchTweets } from "../ingest/x-twitter.js";
import { appendHistory, readHistory, type HistoryEntry } from "./history.js";

interface ScheduledJob {
  name: string;
  schedule: string;
  type: string;
  source: string;
  task: cron.ScheduledTask | null;
  runner: () => Promise<{ items: number; errors: string[] }>;
  lastRun: string | null;
  lastResult: { items: number; errors: string[] } | null;
}

const jobs: Map<string, ScheduledJob> = new Map();

function registerJob(
  name: string,
  schedule: string,
  type: string,
  source: string,
  runner: () => Promise<{ items: number; errors: string[] }>,
): void {
  // Validate cron expression
  if (!cron.validate(schedule)) {
    console.error(`[scheduler] Invalid cron "${schedule}" for job "${name}" — skipping`);
    return;
  }

  const task = cron.schedule(schedule, async () => {
    const start = Date.now();
    console.log(`[scheduler] Running: ${name}`);

    try {
      const result = await runner();
      const entry: HistoryEntry = {
        timestamp: new Date().toISOString(),
        jobName: name,
        source,
        type,
        itemsIngested: result.items,
        errors: result.errors,
        durationMs: Date.now() - start,
      };
      appendHistory(entry);

      const job = jobs.get(name);
      if (job) {
        job.lastRun = entry.timestamp;
        job.lastResult = result;
      }

      console.log(`[scheduler] Done: ${name} — ${result.items} items, ${result.errors.length} errors (${entry.durationMs}ms)`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[scheduler] Error in ${name}: ${msg}`);
      appendHistory({
        timestamp: new Date().toISOString(),
        jobName: name,
        source,
        type,
        itemsIngested: 0,
        errors: [msg],
        durationMs: Date.now() - start,
      });
    }
  });

  jobs.set(name, { name, schedule, type, source, task, runner, lastRun: null, lastResult: null });
}

/** Slugify a string for safe use in job names (replace non-alphanumeric with dash). */
function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function registerSourceJobs(sources: SourceConfig): void {
  // X/Twitter timeline — implemented
  for (const x of sources.xAccounts) {
    registerJob(
      `x-timeline:${x.handle}`,
      x.schedule,
      "x-timeline",
      `@${x.handle}`,
      async () => {
        const tweets = await ingestUserTimeline(x.handle, 10);
        return { items: tweets.length, errors: [] };
      },
    );
  }

  // X/Twitter search — implemented
  for (const x of sources.xSearchTerms) {
    registerJob(
      `x-search:${slugify(x.query)}`,
      x.schedule,
      "x-search",
      `search:"${x.query}"`,
      async () => {
        const tweets = await ingestSearchTweets(x.query, 10);
        return { items: tweets.length, errors: [] };
      },
    );
  }

  // TODO: add youtube: jobs here when YouTube channel polling is implemented
  // TODO: add rss: jobs here when RSS ingestion is implemented
  // TODO: add github: jobs here when GitHub ingestion is implemented
  // TODO: add substack: jobs here when Substack ingestion is implemented
  if (sources.youtube.length > 0) {
    console.log(`[scheduler] ${sources.youtube.length} YouTube source(s) configured but YouTube polling not yet implemented — skipping`);
  }
  if (sources.rssFeeds.length > 0) {
    console.log(`[scheduler] ${sources.rssFeeds.length} RSS source(s) configured but RSS ingestion not yet implemented — skipping`);
  }
  if (sources.githubRepos.length > 0) {
    console.log(`[scheduler] ${sources.githubRepos.length} GitHub source(s) configured but GitHub ingestion not yet implemented — skipping`);
  }
  if (sources.substackNewsletters.length > 0) {
    console.log(`[scheduler] ${sources.substackNewsletters.length} Substack source(s) configured but Substack ingestion not yet implemented — skipping`);
  }
}

export function startScheduler(): void {
  const sources = loadSources();
  const totalSources =
    sources.youtube.length +
    sources.xAccounts.length +
    sources.xSearchTerms.length +
    sources.rssFeeds.length +
    sources.githubRepos.length +
    sources.substackNewsletters.length;

  if (totalSources === 0) {
    console.log("[scheduler] No sources configured — scheduler idle. Edit data/sources.json to add sources.");
    return;
  }

  registerSourceJobs(sources);
  console.log(`[scheduler] Started with ${jobs.size} jobs from ${totalSources} sources`);
}

export function stopScheduler(): void {
  for (const job of jobs.values()) {
    job.task?.stop();
  }
  jobs.clear();
  console.log("[scheduler] Stopped all jobs");
}

export function getStatus(): Array<{
  name: string;
  schedule: string;
  type: string;
  source: string;
  lastRun: string | null;
  lastResult: { items: number; errors: string[] } | null;
}> {
  return Array.from(jobs.values()).map(({ task: _, ...rest }) => rest);
}

export async function triggerNow(jobName: string): Promise<{ items: number; errors: string[] } | null> {
  const job = jobs.get(jobName);
  if (!job) return null;

  const start = Date.now();
  console.log(`[scheduler] Manual trigger: ${jobName}`);

  try {
    const result = await job.runner();
    const entry: HistoryEntry = {
      timestamp: new Date().toISOString(),
      jobName,
      source: job.source,
      type: job.type,
      itemsIngested: result.items,
      errors: result.errors,
      durationMs: Date.now() - start,
    };
    appendHistory(entry);
    job.lastRun = entry.timestamp;
    job.lastResult = result;
    console.log(`[scheduler] Manual trigger done: ${jobName} — ${result.items} items (${entry.durationMs}ms)`);
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[scheduler] Manual trigger error in ${jobName}: ${msg}`);
    appendHistory({
      timestamp: new Date().toISOString(),
      jobName,
      source: job.source,
      type: job.type,
      itemsIngested: 0,
      errors: [msg],
      durationMs: Date.now() - start,
    });
    return { items: 0, errors: [msg] };
  }
}

export { readHistory };
