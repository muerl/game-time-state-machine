import type { FailureDetails, OrderEvent, OrderState } from '../domain/order.js';

export type OrderHistoryEntry = Readonly<{
  id: string;
  fromState: OrderState | null;
  toState: OrderState;
  event: OrderEvent;
  version: number;
  createdAt: Date;
  failure: Readonly<FailureDetails> | null;
  recoveryFailure: Readonly<FailureDetails> | null;
}>;

/** A consistent current-state/history snapshot; excludes internal payment keys. */
export type OrderSnapshot = Readonly<{
  id: string;
  state: OrderState;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  history: readonly OrderHistoryEntry[];
}>;

export type CreateOrderCommand = Readonly<{ requestId: string }>;
export type OrderOperationCommand = Readonly<{
  orderId: string;
  requestId: string;
}>;

export type AuthorizePaymentCommand = OrderOperationCommand;
export type CompleteOrderCommand = OrderOperationCommand;
export type CancelOrderCommand = OrderOperationCommand;

export type OrderServiceErrorCode =
  | 'ORDER_NOT_FOUND' | 'OPERATION_CONFLICT' | 'INVALID_TRANSITION'
  | 'IDEMPOTENCY_CONFLICT' | 'SERVICE_UNAVAILABLE';

export type CreateOrderResult = Readonly<{ order: OrderSnapshot; replayed: boolean }>;
