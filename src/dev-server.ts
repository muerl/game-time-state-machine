import { serve } from '@hono/node-server';
import './config/env.js';
import app from './index.js';

const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535.');
}
const hostname = process.env.HOST ?? '127.0.0.1';
const server = serve({ fetch: app.fetch, port, hostname }, () => {
  console.log(`Order API listening on http://${hostname}:${port}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    const deadline = setTimeout(() => process.exit(1), 10_000);
    deadline.unref();
    server.close((error) => {
      clearTimeout(deadline);
      process.exitCode = error ? 1 : 0;
    });
  });
}
