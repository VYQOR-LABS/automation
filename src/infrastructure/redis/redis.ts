import { Redis } from 'ioredis';
import { config } from '../../config.js';
import { logger } from '../../lib/logger.js';

export const redis = new Redis({
  host: config.redisHost,
  port: config.redisPort,
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
  lazyConnect: true,
});

redis.on('error', (error: unknown) => {
  logger.error({ error }, 'Redis connection error');
});
