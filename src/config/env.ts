import { config } from 'dotenv';

// Existing process variables take priority over local files.
config({ path: ['.env.local', '.env'], quiet: true });

export function getDatabaseUrl(migration = false): string {
  const value = (migration ? process.env.DATABASE_URL_UNPOOLED : undefined)
    || process.env.DATABASE_URL;
  if (!value) {
    throw new Error('Set DATABASE_URL in .env.local or the process environment. See .env.example.');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('DATABASE_URL must be a valid PostgreSQL connection URL.');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname) {
    throw new Error('DATABASE_URL must be a valid PostgreSQL connection URL.');
  }
  return value;
}
