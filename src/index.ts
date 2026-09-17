import { Hono } from 'hono';
import { createOrderApi } from './http/app.js';
import { createConfiguredOrderService } from './orders/configured-order-service.js';

// Native Hono entrypoint for Vercel; the local server lives separately.
const app = new Hono().route('/', createOrderApi(createConfiguredOrderService()));
export default app;
