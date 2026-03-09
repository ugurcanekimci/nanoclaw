import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { batchFetch } from "../core/batch.js";
import { writeResearch, readNote } from "../obsidian/vault.js";
import { listRecent, listByTag, type IndexEntry } from "../obsidian/index-manager.js";
import { searchVault } from "../obsidian/query.js";
import { truncateToTokenBudget } from "../context/truncator.js";
import { smartScrape } from "../scraping/router.js";
import { ingestYouTubeVideo } from "../ingest/youtube.js";
import { ingestTweet, ingestUserTimeline, ingestSearchTweets } from "../ingest/x-twitter.js";
import { planTask, getCostReport } from "../orchestrator/index.js";
import { config } from "../config.js";

export const transcriptMcpServer = createSdkMcpServer({
  name: "swarm-knowledge",
  version: "2.0.0",
  tools: [
    // === YouTube Tools ===

    tool(
      "fetch_transcript",
      "Fetch a YouTube video transcript, store in Obsidian vault, and return truncated content optimized for LLM context.",
      {
        url: z.string().describe("YouTube video URL or video ID"),
        language: z.string().default("en").describe("Language code"),
        tags: z.array(z.string()).default([]).describe("Tags for categorization"),
      },
      async (args) => {
        const entry = await ingestYouTubeVideo(args.url, args.language, args.tags);
        // Read transcript body from vault — avoids a redundant network round-trip
        const note = await readNote("youtube", `${entry.id}.md`);
        const transcriptSection = note
          ? note.slice(note.indexOf("## Transcript"))
          : entry.summary || "";

        const output = [
          `# ${entry.title || entry.id}`,
          `Video: ${entry.url}`,
          `Channel: ${entry.channel || "Unknown"} | Duration: ${entry.duration}s | Words: ${entry.wordCount}`,
          `Tags: ${entry.tags.join(", ")}`,
          `Stored: [[youtube/${entry.id}]]`,
          "",
          truncateToTokenBudget(transcriptSection, 3000, "use kb_read for full content"),
        ].join("\n");

        return { content: [{ type: "text" as const, text: output }] };
      },
    ),

    tool(
      "ingest_youtube",
      "Fetch a YouTube video transcript, summarize, and store in the Obsidian knowledge base. Use for on-demand ingest of a specific video.",
      {
        url: z.string().describe("YouTube video URL or video ID"),
        language: z.string().default("en").describe("Transcript language code"),
        tags: z.array(z.string()).default([]).describe("Tags for categorization"),
      },
      async (args) => {
        const entry = await ingestYouTubeVideo(args.url, args.language, args.tags);
        const text = [
          `Ingested: ${entry.title || entry.id}`,
          `Channel: ${entry.channel || "Unknown"} | Duration: ${entry.duration}s | Words: ${entry.wordCount}`,
          `Tags: ${entry.tags.join(", ")}`,
          `Stored: [[youtube/${entry.id}]]`,
        ].join("\n");
        return { content: [{ type: "text" as const, text }] };
      },
    ),

    tool(
      "batch_fetch_transcripts",
      "Fetch transcripts for multiple YouTube URLs. Stores all in Obsidian vault.",
      {
        urls: z.array(z.string()).min(1).max(50).describe("YouTube URLs or video IDs"),
        language: z.string().default("en"),
        tags: z.array(z.string()).default([]),
      },
      async (args) => {
        const results = await batchFetch(args.urls, args.language);
        const stored: string[] = [];
        const failed: string[] = [];

        for (const r of results) {
          if (r.status === "success" && r.transcript) {
            try {
              await ingestYouTubeVideo(r.videoId, args.language, args.tags);
              stored.push(`OK: ${r.videoId} (${r.transcript.wordCount} words)`);
            } catch {
              stored.push(`OK (not indexed): ${r.videoId}`);
            }
          } else {
            failed.push(`FAIL: ${r.url} — ${r.error}`);
          }
        }

        const text = `Batch: ${stored.length} stored, ${failed.length} failed\n\n${[...stored, ...failed].join("\n")}`;
        return { content: [{ type: "text" as const, text }] };
      },
    ),

    // === X/Twitter Tools ===

    tool(
      "fetch_tweet",
      "Fetch a tweet or thread from X/Twitter. Uses Nitter (free) → Crawl4AI → Apify cascade. Stores in Obsidian vault.",
      {
        url: z.string().describe("Tweet URL (x.com or twitter.com) or tweet ID"),
      },
      async (args) => {
        const tweet = await ingestTweet(args.url);

        const output = [
          `# @${tweet.author}`,
          `URL: ${tweet.url}`,
          `Thread: ${tweet.isThread ? `Yes (${tweet.tweetCount} posts)` : "No"}`,
          `Tags: ${tweet.tags.join(", ")}`,
          `Stored: [[x-posts/${tweet.tweetId}]]`,
          "",
          truncateToTokenBudget(tweet.content, 2000, "use kb_search for full content"),
        ].join("\n");

        return { content: [{ type: "text" as const, text: output }] };
      },
    ),

    tool(
      "fetch_user_timeline",
      "Fetch recent tweets from an X/Twitter user. Stores all in Obsidian vault.",
      {
        username: z.string().describe("X/Twitter username (without @)"),
        limit: z.number().min(1).max(50).default(10),
      },
      async (args) => {
        const tweets = await ingestUserTimeline(args.username, args.limit);

        const lines = tweets.map((t) =>
          `- [[x-posts/${t.tweetId}]] ${t.content.slice(0, 80)}...`,
        );
        const text = `Fetched ${tweets.length} tweets from @${args.username}\n\n${lines.join("\n")}`;
        return { content: [{ type: "text" as const, text }] };
      },
    ),

    tool(
      "search_tweets",
      "Search X/Twitter by keyword. Stores results in Obsidian vault.",
      {
        query: z.string().describe("Search term"),
        limit: z.number().min(1).max(50).default(10),
      },
      async (args) => {
        const tweets = await ingestSearchTweets(args.query, args.limit);

        const lines = tweets.map((t) =>
          `- @${t.author}: ${t.content.slice(0, 80)}... [[x-posts/${t.tweetId}]]`,
        );
        const text = `Found ${tweets.length} tweets for "${args.query}"\n\n${lines.join("\n")}`;
        return { content: [{ type: "text" as const, text }] };
      },
    ),

    // === Knowledge Base Tools ===

    tool(
      "kb_search",
      "Search Obsidian vault across all content types. Supports compound queries: type:youtube channel:\"Name\" tag:topic keyword",
      {
        query: z.string().describe("Search query — supports type:, tag:, channel:, author: prefixes"),
      },
      async (args) => {
        const results = await searchVault(args.query);
        if (results.length === 0) {
          return { content: [{ type: "text" as const, text: `No results for "${args.query}"` }] };
        }

        const text = results
          .map((r) => {
            const subdir = r.entry.type === "youtube-transcript" ? "youtube" : r.entry.type === "x-post" ? "x-posts" : "research";
            const filename = r.entry.filePath.replace(/\.md$/, "");
            const header = `## [[${subdir}/${filename}]] — ${r.entry.title}`;
            const matches = r.matchedLines.slice(0, 3).join("\n  ");
            return `${header}\nScore: ${r.score} | Tags: ${r.entry.tags.join(", ")}\n  ${matches}`;
          })
          .join("\n\n");

        return {
          content: [{ type: "text" as const, text: truncateToTokenBudget(`Found ${results.length} results:\n\n${text}`, 3000) }],
        };
      },
    ),

    tool(
      "kb_recent",
      "List most recent entries in the knowledge base.",
      {
        limit: z.number().min(1).max(50).default(15),
      },
      async (args) => {
        const entries = await listRecent(args.limit);
        if (entries.length === 0) {
          return { content: [{ type: "text" as const, text: "Knowledge base is empty." }] };
        }

        const text = entries.map(formatEntryLine).join("\n");
        return { content: [{ type: "text" as const, text: `${entries.length} recent entries:\n\n${text}` }] };
      },
    ),

    tool(
      "kb_by_tag",
      "List all knowledge base entries with a specific tag.",
      {
        tag: z.string().describe("Tag to filter by"),
      },
      async (args) => {
        const entries = await listByTag(args.tag);
        if (entries.length === 0) {
          return { content: [{ type: "text" as const, text: `No entries tagged "${args.tag}"` }] };
        }

        const text = entries.map(formatEntryLine).join("\n");
        return { content: [{ type: "text" as const, text: `${entries.length} entries tagged #${args.tag}:\n\n${text}` }] };
      },
    ),

    tool(
      "kb_write",
      "Write a research note to the Obsidian vault. Use for saving research findings, analysis, or any content that should persist in the knowledge base.",
      {
        slug: z.string().describe("URL-safe filename without extension (e.g. 'vitest-mocking-patterns')"),
        title: z.string().describe("Human-readable title"),
        content: z.string().describe("Markdown content body"),
        tags: z.array(z.string()).default([]).describe("Tags for categorization"),
        sources: z.array(z.string()).default([]).describe("Source URLs or references"),
      },
      async (args) => {
        const filePath = await writeResearch({
          slug: args.slug,
          title: args.title,
          content: args.content,
          sources: args.sources,
          tags: args.tags,
        });

        return {
          content: [{ type: "text" as const, text: `Saved: [[research/${args.slug}]] at ${filePath}` }],
        };
      },
    ),

    tool(
      "kb_read",
      "Read a specific note from the Obsidian vault by subdir and filename.",
      {
        subdir: z.enum(["youtube", "x-posts", "research"]).describe("Vault subdirectory"),
        filename: z.string().describe("Filename with .md extension"),
      },
      async (args) => {
        const content = await readNote(args.subdir, args.filename);
        if (!content) {
          return {
            content: [{ type: "text" as const, text: `Note not found: ${args.subdir}/${args.filename}` }],
            isError: true,
          };
        }

        return {
          content: [{ type: "text" as const, text: truncateToTokenBudget(content, config.maxToolResultTokens) }],
        };
      },
    ),

    // === Web Scraping Tools ===

    tool(
      "web_scrape",
      "Scrape a web page to clean markdown. Uses Crawl4AI (free) → proxy → Apify cascade. Output is token-budgeted.",
      {
        url: z.string().describe("URL to scrape"),
      },
      async (args) => {
        const result = await smartScrape(args.url);
        const output = [
          `Layer: ${result.layer}`,
          `URL: ${result.url}`,
          `Tokens: ~${result.tokenEstimate}`,
          "",
          result.markdown,
        ].join("\n");

        return {
          content: [{ type: "text" as const, text: truncateToTokenBudget(output, config.maxToolResultTokens) }],
        };
      },
    ),

    // === Orchestrator Tools ===

    tool(
      "plan_task",
      "Analyze a task and show which agent + model would handle it, without executing.",
      {
        task: z.string().describe("Task description"),
      },
      async (args) => {
        const plan = planTask(args.task);
        const text = plan
          .map((p, i) => [
            `Step ${i + 1}: ${p.agent} agent`,
            `  Complexity: ${p.complexity}`,
            `  Model: ${p.model.provider}:${p.model.model} (Tier ${p.model.tier})`,
            `  Est. cost/1k tokens: $${p.model.estimatedCost}`,
            `  Reason: ${p.reason}`,
            `  Confidence: ${(p.confidence * 100).toFixed(0)}%`,
          ].join("\n"))
          .join("\n\n");

        return { content: [{ type: "text" as const, text }] };
      },
    ),

    tool(
      "cost_report",
      "Show current session cost breakdown by agent and model tier.",
      {},
      async () => {
        const report = getCostReport();
        return { content: [{ type: "text" as const, text: report.summary }] };
      },
    ),
  ],
});

function formatEntryLine(e: IndexEntry): string {
  const subdir = e.type === "youtube-transcript" ? "youtube" : e.type === "x-post" ? "x-posts" : "research";
  const filename = e.filePath.replace(/\.md$/, "");
  const prefix = e.type === "youtube-transcript" ? "YT" : e.type === "x-post" ? "X" : "R";
  const meta = e.type === "youtube-transcript"
    ? `${e.channel || "?"} | ${e.wordCount || 0}w`
    : e.type === "x-post"
      ? `@${e.author || "?"} | ${e.tweetCount || 1} posts`
      : `${e.tags.slice(0, 3).join(", ")}`;
  return `- [${prefix}] [[${subdir}/${filename}]] — ${e.title} (${meta})`;
}
