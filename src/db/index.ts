import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { getDatabaseUrl } from '../config/env.js';
import * as schema from './schema.js';

export function createDatabase(connectionString = getDatabaseUrl()) {
  const pool = new Pool({
    connectionString,
    max: 5,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 10_000,
    allowExitOnIdle: true,
  });
  pool.on('error', () => {
    // Avoid logging connection strings or potentially sensitive query details.
    console.error('An idle PostgreSQL connection failed.');
  });
  return { db: drizzle(pool, { schema }), close: () => pool.end() };
}

// Lazy creation keeps builds and schema generation independent of credentials.
let database: ReturnType<typeof createDatabase> | undefined;
export function getDb() {
  database ??= createDatabase();
  return database.db;
}

export async function closeDb() {
  const current = database;
  database = undefined;
  await current?.close();
}
