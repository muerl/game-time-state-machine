import type { FailureDetails, OrderEvent, OrderState } from '../domain/order.js';
import type { OrderSnapshot } from './order-types.js';

export type OrderOperation = 'authorizePayment' | 'completeOrder' | 'cancelOrder';
export type StoredOrder = Readonly<{
  snapshot: OrderSnapshot;
  authorizationKey: string | null;
  authorizationId: string | null;
  voidKey: string | null;
}>;
export type Transition = Readonly<{
  state: OrderState;
  event: OrderEvent;
  authorizationKey?: string;
  authorizationId?: string;
  voidKey?: string;
  failure?: FailureDetails;
  recoveryFailure?: FailureDetails;
}>;
