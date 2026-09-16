import { sql } from 'drizzle-orm';
import { createDatabase } from '../src/db/index.js';

async function main() {
  const database = createDatabase();
  try {
    await database.db.execute(sql`select 1`);
    await database.db.execute(sql`select id from orders limit 0`);
    await database.db.execute(sql`select id from order_transitions limit 0`);
    console.log('Database connected; orders and order_transitions tables are available.');
  } finally {
    await database.close();
  }
}

main().catch(() => {
  console.error('Database check failed. Configure DATABASE_URL, start/connect Postgres, and run npm run db:migrate.');
  process.exitCode = 1;
});
