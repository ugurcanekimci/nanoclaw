/**
 * Shared Langfuse client wrapper for NanoClaw host runtime.
 *
 * Provides a singleton client with no-op fallback when disabled or misconfigured.
 * Call sites never need to check if Langfuse is enabled — the no-op proxy
 * swallows all method calls silently.
 */

import { Langfuse } from 'langfuse';

import {
  LANGFUSE_BASEURL,
  LANGFUSE_ENABLED,
  LANGFUSE_PUBLIC_KEY,
  LANGFUSE_SAMPLE_RATE,
  LANGFUSE_SECRET_KEY,
} from '../config.js';
import { logger } from '../logger.js';

let client: Langfuse | null = null;

/**
 * No-op proxy that swallows all method calls and property access.
 * Returns itself for chained calls (e.g. `getLangfuse().trace().span()`).
 */
const NOOP_PROXY: Langfuse = new Proxy({} as Langfuse, {
  get(_target, prop) {
    // Allow typeof checks and JSON serialization to work
    if (prop === Symbol.toPrimitive || prop === 'toJSON') return undefined;
    if (prop === 'then') return undefined; // prevent Promise coercion
    // Return a function that returns the proxy for chaining
    return (..._args: unknown[]) => NOOP_PROXY;
  },
});

export function initLangfuse(): Langfuse | null {
  if (!LANGFUSE_ENABLED) {
    logger.info('Langfuse disabled (LANGFUSE_ENABLED=false or unset)');
    return null;
  }

  if (!LANGFUSE_PUBLIC_KEY || !LANGFUSE_SECRET_KEY) {
    logger.warn(
      'Langfuse enabled but missing LANGFUSE_PUBLIC_KEY or LANGFUSE_SECRET_KEY — running in no-op mode',
    );
    return null;
  }

  try {
    client = new Langfuse({
      publicKey: LANGFUSE_PUBLIC_KEY,
      secretKey: LANGFUSE_SECRET_KEY,
      baseUrl: LANGFUSE_BASEURL,
      release: process.env.npm_package_version,
    });

    logger.info(
      { baseUrl: LANGFUSE_BASEURL, sampleRate: LANGFUSE_SAMPLE_RATE },
      'Langfuse initialized',
    );

    return client;
  } catch (err) {
    logger.error(
      { err },
      'Failed to initialize Langfuse — running in no-op mode',
    );
    client = null;
    return null;
  }
}

/**
 * Returns the Langfuse client or a no-op proxy.
 * Safe to call at any time — never returns null.
 */
export function getLangfuse(): Langfuse {
  return client ?? NOOP_PROXY;
}

/**
 * Returns true if a real Langfuse client is active (not no-op).
 */
export function isLangfuseActive(): boolean {
  return client !== null;
}

/**
 * Returns true if this trace should be sampled based on LANGFUSE_SAMPLE_RATE.
 * Called once per trace creation to ensure complete-or-absent traces.
 */
export function shouldSample(): boolean {
  if (!client) return false;
  if (LANGFUSE_SAMPLE_RATE >= 1.0) return true;
  if (LANGFUSE_SAMPLE_RATE <= 0.0) return false;
  return Math.random() < LANGFUSE_SAMPLE_RATE;
}

/**
 * Flush pending events and shut down the Langfuse client.
 * Safe to call multiple times or when client is null.
 */
export async function shutdownLangfuse(): Promise<void> {
  if (!client) return;
  try {
    await client.shutdownAsync();
    logger.info('Langfuse shut down');
  } catch (err) {
    logger.error({ err }, 'Error during Langfuse shutdown');
  } finally {
    client = null;
  }
}
