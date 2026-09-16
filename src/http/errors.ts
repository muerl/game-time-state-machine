import type { Context } from 'hono';
import { OrderServiceError } from '../orders/order-service.js';
import type { OrderServiceErrorCode } from '../orders/order-types.js';

const serviceErrors = {
  ORDER_NOT_FOUND: { status: 404, message: 'Order not found.' },
  OPERATION_CONFLICT: { status: 409, message: 'A concurrent operation changed this order.' },
  INVALID_TRANSITION: { status: 409, message: 'This action is not allowed in the current order state.' },
  IDEMPOTENCY_CONFLICT: { status: 409, message: 'This idempotency key was already used for a different command.' },
  SERVICE_UNAVAILABLE: { status: 503, message: 'Order service is not available.' },
} as const satisfies Record<OrderServiceErrorCode, { status: 404 | 409 | 503; message: string }>;

export class RequestError extends Error {
  constructor(public readonly status: 400 | 415, public readonly code: string, message: string) {
    super(message);
  }
}

export function handleApiError(error: Error, context: Context) {
  if (error instanceof RequestError) {
    return context.json({ error: { code: error.code, message: error.message } }, error.status);
  }
  if (error instanceof OrderServiceError) {
    const mapped = serviceErrors[error.code];
    return context.json({ error: { code: error.code, message: mapped.message } }, mapped.status);
  }
  // Includes response-mapping errors: invalid service output is a server error,
  // not a client validation error. Do not expose input values or internal details.
  console.error('Unhandled order API error.');
  return context.json({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' } }, 500);
}
