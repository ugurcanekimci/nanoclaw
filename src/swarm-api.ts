import { serve } from '@hono/node-server';

import { config } from './config.js';
import { api } from './api/routes.js';
import { startScheduler } from './scheduler/index.js';
import { logger } from './logger.js';

export interface SwarmApiHandle {
  close(): void;
}

export function startSwarmApi(): SwarmApiHandle {
  let isListening = false;
  const server = serve({ fetch: api.fetch, port: config.port }, (info) => {
    isListening = true;
    logger.info({ port: info.port }, 'Swarm API listening');
    startScheduler();
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      logger.warn(
        { port: config.port },
        'Swarm API port already in use; continuing without embedded API',
      );
      return;
    }

    logger.error({ err, port: config.port }, 'Swarm API server error');
    throw err;
  });

  return {
    close(): void {
      if (isListening) {
        server.close();
      }
    },
  };
}
