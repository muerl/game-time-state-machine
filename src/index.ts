import { Hono } from 'hono';
import { createOrderApi } from './http/app.js';
import { OrderServiceError } from './orders/order-service.js';
import type { OrderService } from './orders/order-service.js';

// Explicit placeholder: the application service is the next slice. Never fake success.
const unavailable = async (): Promise<never> => { throw new OrderServiceError('SERVICE_UNAVAILABLE'); };
const service: OrderService = { create: unavailable, get: unavailable, authorizePayment: unavailable, completeOrder: unavailable, cancelOrder: unavailable };

// Native Hono entrypoint for Vercel; the local server lives separately.
const app = new Hono().route('/', createOrderApi(service));
export default app;
