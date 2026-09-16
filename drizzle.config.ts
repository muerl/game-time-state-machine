import { defineConfig } from 'drizzle-kit';
import './src/config/env.js';

const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  ...(url ? { dbCredentials: { url } } : {}),
});
