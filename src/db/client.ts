import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { config } from '../config.js';
import * as schema from './schema.js';

const sql = postgres(config.databaseUrl, {
  max: 10,
  ssl: config.nodeEnv === 'production' ? 'require' : false,
});

export const db = drizzle(sql, { schema, logger: config.nodeEnv === 'development' });

export type Database = typeof db;
