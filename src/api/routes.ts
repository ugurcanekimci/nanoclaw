import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { TranscriptRequestSchema, BatchRequestSchema } from '../types.js';
import type { ApiError } from '../types.js';
import { getTranscript } from '../core/transcript.js';
import { batchFetch } from '../core/batch.js';
import { ingestYouTubeVideo } from '../ingest/youtube.js';
import {
  ingestTweet,
  ingestUserTimeline,
  ingestSearchTweets,
} from '../ingest/x-twitter.js';
import { searchVault } from '../obsidian/query.js';
import { listRecent, listByTag } from '../obsidian/index-manager.js';
import { smartScrape } from '../scraping/router.js';
import { planTask, getCostReport } from '../orchestrator/index.js';
import { getStatus, triggerNow, readHistory } from '../scheduler/index.js';
import {
  loadSources,
  saveSources,
  type SourceConfig,
} from '../ingest/sources.js';
import { z } from 'zod';

export const api = new Hono();

api.get('/health', (c) => c.json({ status: 'ok', version: '2.0.0' }));

// Map youtube-transcript-plus errors to HTTP responses
function mapError(err: unknown): {
  status: ContentfulStatusCode;
  body: ApiError;
} {
  if (!(err instanceof Error)) {
    return {
      status: 500,
      body: { error: 'internal_error', message: String(err) },
    };
  }

  const name = err.name;
  const videoId =
    'videoId' in err
      ? String((err as Record<string, unknown>).videoId)
      : undefined;

  switch (name) {
    case 'YoutubeTranscriptInvalidVideoIdError':
      return {
        status: 400,
        body: { error: 'invalid_video_id', message: err.message },
      };
    case 'YoutubeTranscriptDisabledError':
      return {
        status: 403,
        body: { error: 'transcript_disabled', message: err.message, videoId },
      };
    case 'YoutubeTranscriptVideoUnavailableError':
      return {
        status: 404,
        body: { error: 'video_unavailable', message: err.message, videoId },
      };
    case 'YoutubeTranscriptNotAvailableError':
      return {
        status: 404,
        body: {
          error: 'transcript_not_available',
          message: err.message,
          videoId,
        },
      };
    case 'YoutubeTranscriptNotAvailableLanguageError': {
      const langs =
        'availableLangs' in err
          ? ((err as Record<string, unknown>).availableLangs as string[])
          : undefined;
      return {
        status: 404,
        body: {
          error: 'language_not_available',
          message: err.message,
          videoId,
          availableLanguages: langs,
        },
      };
    }
    case 'YoutubeTranscriptTooManyRequestError':
      return {
        status: 429,
        body: { error: 'rate_limited', message: err.message },
      };
    default:
      return {
        status: 500,
        body: { error: 'internal_error', message: err.message },
      };
  }
}

// === YouTube Endpoints ===

// POST /api/transcript — fetch + store in both legacy KB and Obsidian
api.post('/api/transcript', async (c) => {
  const body = await c.req.json();
  const parsed = TranscriptRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: 'validation_error', message: parsed.error.message },
      400 as ContentfulStatusCode,
    );
  }

  try {
    if (parsed.data.store) {
      const entry = await ingestYouTubeVideo(
        parsed.data.url,
        parsed.data.language,
      );
      const transcript = await getTranscript(
        parsed.data.url,
        parsed.data.language,
      );
      return c.json({ ...transcript, stored: entry.id });
    }
    const transcript = await getTranscript(
      parsed.data.url,
      parsed.data.language,
    );
    return c.json(transcript);
  } catch (err) {
    const { status, body: errBody } = mapError(err);
    return c.json(errBody, status);
  }
});

// POST /api/transcript/batch
api.post('/api/transcript/batch', async (c) => {
  const body = await c.req.json();
  const parsed = BatchRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: 'validation_error', message: parsed.error.message },
      400 as ContentfulStatusCode,
    );
  }

  const results = await batchFetch(
    parsed.data.urls,
    parsed.data.language,
    parsed.data.concurrency,
  );

  if (parsed.data.store) {
    for (const r of results) {
      if (r.status === 'success' && r.transcript) {
        try {
          await ingestYouTubeVideo(r.videoId, parsed.data.language);
        } catch {
          /* non-fatal */
        }
      }
    }
  }

  return c.json({
    total: results.length,
    succeeded: results.filter((r) => r.status === 'success').length,
    failed: results.filter((r) => r.status === 'error').length,
    results,
  });
});

// === X/Twitter Endpoints ===

// POST /api/x/tweet — fetch a tweet or thread
api.post('/api/x/tweet', async (c) => {
  const body = await c.req.json();
  const parsed = z.object({ url: z.string() }).safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: 'validation_error', message: parsed.error.message },
      400 as ContentfulStatusCode,
    );
  }

  try {
    const tweet = await ingestTweet(parsed.data.url);
    return c.json(tweet);
  } catch (err) {
    return c.json(
      {
        error: 'fetch_error',
        message: err instanceof Error ? err.message : String(err),
      },
      500 as ContentfulStatusCode,
    );
  }
});

// POST /api/x/timeline — fetch user timeline
api.post('/api/x/timeline', async (c) => {
  const body = await c.req.json();
  const parsed = z
    .object({
      username: z.string(),
      limit: z.number().min(1).max(50).default(10),
    })
    .safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: 'validation_error', message: parsed.error.message },
      400 as ContentfulStatusCode,
    );
  }

  try {
    const tweets = await ingestUserTimeline(
      parsed.data.username,
      parsed.data.limit,
    );
    return c.json({ count: tweets.length, tweets });
  } catch (err) {
    return c.json(
      {
        error: 'fetch_error',
        message: err instanceof Error ? err.message : String(err),
      },
      500 as ContentfulStatusCode,
    );
  }
});

// POST /api/x/search — search tweets
api.post('/api/x/search', async (c) => {
  const body = await c.req.json();
  const parsed = z
    .object({
      query: z.string(),
      limit: z.number().min(1).max(50).default(10),
    })
    .safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: 'validation_error', message: parsed.error.message },
      400 as ContentfulStatusCode,
    );
  }

  try {
    const tweets = await ingestSearchTweets(
      parsed.data.query,
      parsed.data.limit,
    );
    return c.json({ count: tweets.length, tweets });
  } catch (err) {
    return c.json(
      {
        error: 'fetch_error',
        message: err instanceof Error ? err.message : String(err),
      },
      500 as ContentfulStatusCode,
    );
  }
});

// === Web Scraping Endpoints ===

// POST /api/scrape — scrape a URL through the cascade
api.post('/api/scrape', async (c) => {
  const body = await c.req.json();
  const parsed = z.object({ url: z.string() }).safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: 'validation_error', message: parsed.error.message },
      400 as ContentfulStatusCode,
    );
  }

  try {
    const result = await smartScrape(parsed.data.url);
    return c.json(result);
  } catch (err) {
    return c.json(
      {
        error: 'scrape_error',
        message: err instanceof Error ? err.message : String(err),
      },
      500 as ContentfulStatusCode,
    );
  }
});

// === Obsidian Knowledge Base Endpoints ===

// GET /api/kb — list entries (supports ?type= and ?tag= filters)
api.get('/api/kb', async (c) => {
  const tag = c.req.query('tag');
  if (tag) {
    const entries = await listByTag(tag);
    return c.json({ count: entries.length, entries });
  }
  const entries = await listRecent(50);
  return c.json({ count: entries.length, entries });
});

// GET /api/kb/search?q=term — compound search
api.get('/api/kb/search', async (c) => {
  const q = c.req.query('q');
  if (!q) {
    return c.json(
      { error: 'validation_error', message: "Query parameter 'q' is required" },
      400 as ContentfulStatusCode,
    );
  }
  const results = await searchVault(q);
  return c.json({ count: results.length, results });
});

// === Orchestrator Endpoints ===

// POST /api/plan — plan task routing without executing
api.post('/api/plan', async (c) => {
  const body = await c.req.json();
  const parsed = z.object({ task: z.string() }).safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: 'validation_error', message: parsed.error.message },
      400 as ContentfulStatusCode,
    );
  }
  const plan = planTask(parsed.data.task);
  return c.json({ plan });
});

// GET /api/cost — cost report
api.get('/api/cost', (c) => {
  return c.json(getCostReport());
});

// === Scheduler Endpoints ===

// GET /api/scheduler/status — current job states
api.get('/api/scheduler/status', (c) => {
  return c.json({ jobs: getStatus() });
});

// POST /api/scheduler/trigger/:jobName — manually trigger a job
api.post('/api/scheduler/trigger/:jobName', async (c) => {
  const jobName = c.req.param('jobName');
  const result = await triggerNow(jobName);
  if (result === null) {
    return c.json(
      { error: 'not_found', message: `Job "${jobName}" not found` },
      404 as ContentfulStatusCode,
    );
  }
  return c.json({ triggered: jobName, result });
});

// GET /api/scheduler/history — recent ingestion results
api.get('/api/scheduler/history', (c) => {
  const limit = parseInt(c.req.query('limit') || '50', 10);
  return c.json({ history: readHistory(limit) });
});

// GET /api/sources — current source config
api.get('/api/sources', (c) => {
  return c.json(loadSources());
});

// PUT /api/sources — update source config
api.put('/api/sources', async (c) => {
  const body = (await c.req.json()) as SourceConfig;
  saveSources(body);
  return c.json({
    status: 'updated',
    message: 'Restart the server to apply new schedules.',
  });
});
