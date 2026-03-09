/**
 * X/Twitter ingestion — fetch tweets and store in Obsidian vault.
 */

import {
  fetchTweet,
  fetchUserTimelineRaw,
  searchTweetsRaw,
  type FetchedTweet,
} from '../x-twitter/fetcher.js';
import { writeXPost } from '../obsidian/vault.js';
import { upsertEntry, type IndexEntry } from '../obsidian/index-manager.js';
import { frontmatterSummary } from '../context/summarizer.js';
import { generateMOC } from '../obsidian/moc.js';

function tweetToEntry(tweet: FetchedTweet): IndexEntry {
  return {
    id: tweet.tweetId,
    type: 'x-post',
    title:
      tweet.content.slice(0, 100) + (tweet.content.length > 100 ? '...' : ''),
    url: tweet.url,
    summary: frontmatterSummary(tweet.content),
    tags: tweet.tags,
    fetchedAt: tweet.fetchedAt,
    filePath: `${tweet.tweetId}.md`,
    author: tweet.author,
    tweetCount: tweet.tweetCount,
  };
}

async function storeTweet(tweet: FetchedTweet): Promise<void> {
  await writeXPost({
    tweetId: tweet.tweetId,
    author: tweet.author,
    authorName: tweet.authorName,
    url: tweet.url,
    isThread: tweet.isThread,
    tweetCount: tweet.tweetCount,
    content: tweet.content,
    summary: frontmatterSummary(tweet.content),
    tags: tweet.tags,
  });
  await upsertEntry(tweetToEntry(tweet));
}

/**
 * Fetch and store a single tweet or thread.
 * Pass emitMoc=false when calling in a batch loop — call generateMOC() once after the loop instead.
 */
export async function ingestTweet(
  urlOrId: string,
  emitMoc = true,
): Promise<FetchedTweet> {
  const tweet = await fetchTweet(urlOrId);
  await storeTweet(tweet);
  if (emitMoc) {
    await generateMOC();
  }
  return tweet;
}

/**
 * Fetch and store recent tweets from a user.
 */
export async function ingestUserTimeline(
  username: string,
  limit = 20,
): Promise<FetchedTweet[]> {
  const tweets = await fetchUserTimelineRaw(username, limit);

  for (const tweet of tweets) {
    await storeTweet(tweet);
  }

  if (tweets.length > 0) {
    await generateMOC();
  }

  return tweets;
}

/**
 * Search X and store results.
 */
export async function ingestSearchTweets(
  query: string,
  limit = 20,
): Promise<FetchedTweet[]> {
  const tweets = await searchTweetsRaw(query, limit);

  for (const tweet of tweets) {
    await storeTweet(tweet);
  }

  if (tweets.length > 0) {
    await generateMOC();
  }

  return tweets;
}
