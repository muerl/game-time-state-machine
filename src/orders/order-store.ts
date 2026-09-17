import type { CreateOrderResult, OrderSnapshot } from './order-types.js';
import type { OrderOperation, StoredOrder, Transition } from './order-store-types.js';

export interface OrderTransaction {
  readonly order: StoredOrder;
  findCommand(requestId: string): Promise<OrderOperation | null>;
  recordCommand(requestId: string, operation: OrderOperation): Promise<void>;
  transition(change: Transition): Promise<StoredOrder>;
}
/** Callbacks run under a per-order database lock. Never make external calls inside them. */
export interface OrderStore {
  create(requestId: string): Promise<CreateOrderResult>;
  get(orderId: string): Promise<OrderSnapshot | null>;
  transaction<Result>(orderId: string, work: (transaction: OrderTransaction) => Promise<Result>): Promise<Result>;
}
