import type { Context } from 'hono';
import type { z } from 'zod';
import type { OrderOperationCommand, CreateOrderCommand } from '../orders/order-types.js';
import { RequestError } from './errors.js';
import { orderOperationBodySchema, createOrderBodySchema, idempotencyKeySchema, orderIdSchema } from './models.js';

function parseInput<Schema extends z.ZodType>(schema: Schema, value: unknown, code: string, message: string): z.output<Schema> {
  const result = schema.safeParse(value);
  if (!result.success) throw new RequestError(400, code, message);
  return result.data;
}

function readRequestId(context: Context): string {
  return parseInput(idempotencyKeySchema, context.req.header('Idempotency-Key'), 'INVALID_IDEMPOTENCY_KEY',
    'Idempotency-Key must contain 1–128 letters, digits, dots, underscores, colons, or hyphens.');
}

export function readOrderId(context: Context): string {
  return parseInput(orderIdSchema, context.req.param('id'), 'INVALID_ORDER_ID', 'Order ID must be a UUID.');
}

async function readJson(context: Context): Promise<unknown> {
  if (context.req.header('Content-Type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
    throw new RequestError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Use Content-Type: application/json.');
  }
  try { return await context.req.json<unknown>(); } catch {
    throw new RequestError(400, 'INVALID_JSON', 'Request body must contain valid JSON.');
  }
}

export async function readCreateOrderCommand(context: Context): Promise<CreateOrderCommand> {
  const requestId = readRequestId(context);
  parseInput(createOrderBodySchema, await readJson(context), 'INVALID_BODY',
    'Order creation accepts an empty JSON object.');
  return { requestId };
}

export async function readOrderOperationCommand(context: Context): Promise<OrderOperationCommand> {
  const orderId = readOrderId(context);
  const requestId = readRequestId(context);
  parseInput(orderOperationBodySchema, await readJson(context), 'INVALID_BODY',
    'Order operations accept an empty JSON object.');
  return { orderId, requestId };
}
