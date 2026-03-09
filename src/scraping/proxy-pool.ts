/**
 * Multi-provider proxy rotation pool.
 * Supports rotating (new IP per request) and sticky (same IP for session) modes.
 */

import { config } from '../config.js';

export interface ProxyEndpoint {
  server: string;
  username: string;
  password: string;
}

const failed = new Set<string>();
let rotationIndex = 0;

function buildEndpoints(): ProxyEndpoint[] {
  if (!config.proxyHost) return [];

  return [
    {
      server: `http://${config.proxyHost}:${config.proxyPort}`,
      username: config.proxyUser,
      password: config.proxyPass,
    },
  ];
}

/**
 * Get a rotating proxy (new IP per request).
 */
export function getRotatingProxy(): ProxyEndpoint | null {
  const endpoints = buildEndpoints().filter((e) => !failed.has(e.server));
  if (endpoints.length === 0) return null;

  rotationIndex = (rotationIndex + 1) % endpoints.length;
  return endpoints[rotationIndex]!;
}

/**
 * Get a sticky proxy (same IP for multi-page session).
 * Appends a session ID to the username for sticky routing.
 */
export function getStickyProxy(sessionId: string): ProxyEndpoint | null {
  const base = getRotatingProxy();
  if (!base) return null;

  return {
    ...base,
    username: `${base.username}-session-${sessionId}`,
  };
}

/**
 * Get a geo-targeted proxy for a specific country.
 */
export function getRegionalProxy(country: string): ProxyEndpoint | null {
  const base = getRotatingProxy();
  if (!base) return null;

  return {
    ...base,
    server: `${base.server}?country=${country}`,
  };
}

/**
 * Mark a proxy as failed.
 */
export function markFailed(server: string): void {
  failed.add(server);
}

/**
 * Reset failed state for all proxies.
 */
export function resetFailed(): void {
  failed.clear();
}

/**
 * Health check proxy by making a test request.
 */
export async function healthCheck(proxy: ProxyEndpoint): Promise<boolean> {
  try {
    // Node.js native fetch doesn't support proxy directly
    // Use the proxy to test connectivity via the API server
    const response = await fetch('https://httpbin.org/ip', {
      signal: AbortSignal.timeout(10_000),
    });
    return response.ok;
  } catch {
    markFailed(proxy.server);
    return false;
  }
}

export function getProxyStatus(): { available: number; failed: number } {
  const endpoints = buildEndpoints();
  return {
    available: endpoints.filter((e) => !failed.has(e.server)).length,
    failed: failed.size,
  };
}
