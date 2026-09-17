import type { FailureDetails, OrderEvent, OrderState } from '../domain/order.js';
import type { OrderSnapshot } from './order-types.js';

export type OrderOperation = 'authorizePayment' | 'completeOrder' | 'cancelOrder';
export type StoredOrder = Readonly<{
  snapshot: OrderSnapshot;
  authorizationIdempotencyKey: string | null;
  authorizationId: string | null;
  voidIdempotencyKey: string | null;
}>;
export type Transition = Readonly<{
  state: OrderState;
  event: OrderEvent;
  authorizationIdempotencyKey?: string;
  authorizationId?: string;
  voidIdempotencyKey?: string;
  failure?: FailureDetails;
  recoveryFailure?: FailureDetails;
}>;
