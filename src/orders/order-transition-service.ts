import type { OrderOperationCommand } from './order-types.js';
import type { OrderOperation, StoredOrder, Transition } from './order-store-types.js';
import type { OrderClaim } from './order-transition-service-types.js';

export interface OrderTransitionService {
  claim(command: OrderOperationCommand, operation: OrderOperation): Promise<OrderClaim>;
  finish(expected: StoredOrder, change: Transition): Promise<StoredOrder>;
}
