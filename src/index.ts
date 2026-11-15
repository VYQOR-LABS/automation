import { buildApp } from './app.js';
import { config } from './config.js';
import { logger } from './lib/logger.js';
import { startWorkers } from './workers/index.js';

const app = await buildApp();

try {
  startWorkers();
  await app.listen({
    host: '0.0.0.0',
    port: config.port,
  });

  logger.info({ port: config.port, app: config.appName }, 'Vico AI backend started');
} catch (error) {
  logger.error(error, 'Failed to start Vico AI backend');
  process.exit(1);
}
