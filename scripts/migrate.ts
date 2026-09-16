import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { getDatabaseUrl } from '../src/config/env.js';
import { createDatabase } from '../src/db/index.js';

async function main() {
  const database = createDatabase(getDatabaseUrl(true));
  try {
    await migrate(database.db, { migrationsFolder: './drizzle' });
    console.log('Database migrations applied.');
  } finally {
    await database.close();
  }
}

main().catch(() => {
  console.error('Migration failed. Check DATABASE_URL, connectivity, and database permissions.');
  process.exitCode = 1;
});
