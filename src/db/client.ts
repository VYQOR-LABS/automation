import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { DefaultLogger } from 'drizzle-orm/logger';
import { config } from '../config.js';
import * as schema from './schema.js';

const sql = postgres(config.databaseUrl, {
  max: 10,
  ssl: config.nodeEnv === 'production' ? 'require' : false,
});

const defaultLogger = new DefaultLogger();
const developmentLogger = {
  logQuery(query: string, params: unknown[]) {
    defaultLogger.logQuery(
      query,
      /oauth_tokens/i.test(query) ? params.map(() => '[redacted]') : params,
    );
  },
};

export const db = drizzle(sql, {
  schema,
  logger: config.nodeEnv === 'development' ? developmentLogger : false,
});

export type Database = typeof db;
