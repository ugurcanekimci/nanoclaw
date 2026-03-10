import * as net from 'node:net';
import { serve } from '@hono/node-server';

import { config } from './config.js';
import { api } from './api/routes.js';
import { startScheduler } from './scheduler/index.js';
import { logger } from './logger.js';

export interface SwarmApiHandle {
  close(): void;
}

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const tester = net
      .createServer()
      .once('error', () => resolve(false))
      .once('listening', () => {
        tester.close(() => resolve(true));
      })
      .listen(port);
  });
}

export async function startSwarmApi(): Promise<SwarmApiHandle> {
  const port = config.port;

  const available = await isPortAvailable(port);
  if (!available) {
    logger.warn(
      { port },
      'Swarm API port already in use; continuing without embedded API',
    );
    return { close() {} };
  }

  let isListening = false;
  const server = serve({ fetch: api.fetch, port }, (info) => {
    isListening = true;
    logger.info({ port: info.port }, 'Swarm API listening');
    startScheduler();
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    logger.error({ err, port }, 'Swarm API server error');
  });

  return {
    close(): void {
      if (isListening) {
        server.close();
      }
    },
  };
}
