import { z } from 'zod';
import type { OrderEvent, OrderState } from '../domain/order.js';

// Preserve the API's version-agnostic UUID shape validation and normalization.
export const orderIdSchema = z.guid().toLowerCase();
export const idempotencyKeySchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);
export const createOrderBodySchema = z.strictObject({});
export const orderOperationBodySchema = z.strictObject({});

export type CreateOrderBody = z.infer<typeof createOrderBodySchema>;
export type OrderOperationBody = z.infer<typeof orderOperationBodySchema>;

// Public response contracts are TypeScript types, independent of input validation.
export type FailureDto = Readonly<{ code: string; message: string }>;
export type OrderHistoryDto = Readonly<{
  id: string;
  fromState: OrderState | null;
  toState: OrderState;
  event: OrderEvent;
  version: number;
  createdAt: string;
  failure: FailureDto | null;
  recoveryFailure: FailureDto | null;
}>;
export type OrderDto = Readonly<{
  id: string;
  state: OrderState;
  version: number;
  createdAt: string;
  updatedAt: string;
  history: readonly OrderHistoryDto[];
}>;
