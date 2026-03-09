import { serve } from '@hono/node-server';

import { config } from './config.js';
import { api } from './api/routes.js';
import { startScheduler } from './scheduler/index.js';
import { logger } from './logger.js';

export function startSwarmApi(): ReturnType<typeof serve> {
  const server = serve({ fetch: api.fetch, port: config.port }, (info) => {
    logger.info({ port: info.port }, 'Swarm API listening');
    startScheduler();
  });
  return server;
}
