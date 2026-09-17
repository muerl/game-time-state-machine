import { randomUUID } from 'node:crypto';
import { OrderServiceError } from './order-service.js';
import { InvalidTransitionError } from './invalid-transition-error.js';
import type { OrderStore } from './order-store.js';
import type { OrderOperation, StoredOrder, Transition } from './order-store-types.js';
import type { OrderOperationCommand } from './order-types.js';
import type { OrderClaim } from './order-transition-service-types.js';
import type { OrderTransitionService } from './order-transition-service.js';

/** Owns transactional claims, replay resolution and outcome version checks. */
export function createOrderTransitionService(store: OrderStore): OrderTransitionService {
  function startTransition(order: StoredOrder, operation: OrderOperation): Transition {
    const state = order.snapshot.state;
    switch (operation) {
      case 'authorizePayment':
        if (state === 'initialized') return {
          state: 'payment_authorizing', event: 'payment_authorization_started', authorizationIdempotencyKey: `authorize:${randomUUID()}`,
        };
        break;
      case 'completeOrder':
        if (state === 'payment_authorized') return { state: 'completing', event: 'completion_started' };
        break;
      case 'cancelOrder':
        if (state === 'initialized') return { state: 'cancelled', event: 'order_cancelled' };
        if (state === 'payment_authorized') return {
          state: 'payment_voiding', event: 'payment_void_started', voidIdempotencyKey: `void:${randomUUID()}`,
        };
    }
    throw new InvalidTransitionError(operation, state);
  }

  async function claim(command: OrderOperationCommand, operation: OrderOperation): Promise<OrderClaim> {
    return store.transaction(command.orderId, async transaction => {
      const previous = await transaction.findCommand(command.requestId);
      if (previous) {
        if (previous !== operation) throw new OrderServiceError('IDEMPOTENCY_CONFLICT');
        return { claimed: false, order: transaction.order };
      }
      const change = startTransition(transaction.order, operation);
      await transaction.recordCommand(command.requestId, operation);
      return { claimed: true, order: await transaction.transition(change) };
    });
  }

  // Only the original claimant can write its outcome; a stale result cannot overwrite newer state.
  async function finish(expected: StoredOrder, change: Transition): Promise<StoredOrder> {
    return store.transaction(expected.snapshot.id, async transaction => {
      if (transaction.order.snapshot.version !== expected.snapshot.version
        || transaction.order.snapshot.state !== expected.snapshot.state) {
        throw new OrderServiceError('OPERATION_CONFLICT');
      }
      return transaction.transition(change);
    });
  }

  return { claim, finish };
}
