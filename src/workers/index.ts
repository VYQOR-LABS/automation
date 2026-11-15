import { pathToFileURL } from 'node:url';
import { logger } from '../lib/logger.js';
import { startAiWorker } from './ai-worker.js';
import { startMessageWorker } from './message-worker.js';

export function startWorkers() {
  const aiWorker = startAiWorker();
  const messageWorker = startMessageWorker();

  logger.info('Background workers started');

  return { aiWorker, messageWorker };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startWorkers();
}
