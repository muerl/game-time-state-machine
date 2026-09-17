import { randomUUID } from 'node:crypto';
import type { FailureDetails } from '../domain/order.js';
import type { PaymentGateway, AuthorizePaymentResult, VoidPaymentResult } from '../payments/payment-gateway.js';
import type { OrderCompletion } from './order-completion.js';
import type { CompletionResult } from './order-completion-types.js';
import { OrderServiceError } from './order-service.js';
import type { OrderService } from './order-service.js';
import type { OrderStore } from './order-store.js';
import type { OrderOperation, StoredOrder, Transition } from './order-store-types.js';
import type { OrderOperationCommand, OrderSnapshot } from './order-types.js';

const failures = {
  declined: { code: 'PAYMENT_DECLINED', message: 'Payment authorization was declined.' },
  authorizationUnknown: { code: 'AUTHORIZATION_UNCONFIRMED', message: 'Payment authorization requires reconciliation.' },
  completionFailed: { code: 'COMPLETION_FAILED', message: 'Order completion failed.' },
  completionUnknown: { code: 'COMPLETION_UNCONFIRMED', message: 'Order completion requires reconciliation.' },
  voidFailed: { code: 'PAYMENT_VOID_UNCONFIRMED', message: 'Payment void requires manual attention.' },
} as const satisfies Record<string, FailureDetails>;

type Claim = Readonly<{ claimed: boolean; order: StoredOrder }>;
type Dependencies = Readonly<{ store: OrderStore; payments: PaymentGateway; completion: OrderCompletion }>;

/** No external call occurs until its durable claim transaction has committed. */
export function createOrderService({ store, payments, completion }: Dependencies): OrderService {
  function startTransition(order: StoredOrder, operation: OrderOperation): Transition {
    const state = order.snapshot.state;
    switch (operation) {
      case 'authorizePayment':
        if (state === 'initialized') return {
          state: 'payment_authorizing', event: 'payment_authorization_started', authorizationKey: `authorize:${randomUUID()}`,
        };
        break;
      case 'completeOrder':
        if (state === 'payment_authorized') return { state: 'completing', event: 'completion_started' };
        break;
      case 'cancelOrder':
        if (state === 'initialized') return { state: 'cancelled', event: 'order_cancelled' };
        if (state === 'payment_authorized') return {
          state: 'payment_voiding', event: 'payment_void_started', voidKey: `void:${randomUUID()}`,
        };
    }
    throw new OrderServiceError('INVALID_TRANSITION');
  }

  async function claim(command: OrderOperationCommand, operation: OrderOperation): Promise<Claim> {
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

  async function voidPayment(order: StoredOrder, failure?: FailureDetails): Promise<OrderSnapshot> {
    if (!order.authorizationId || !order.voidKey) throw new Error('Void claim is missing payment references.');
    let result: VoidPaymentResult;
    try {
      result = await payments.voidAuthorization({
        orderId: order.snapshot.id, authorizationId: order.authorizationId, idempotencyKey: order.voidKey,
      });
    } catch {
      result = { status: 'error', failure: failures.voidFailed };
    }
    const change: Transition = result.status === 'voided'
      ? { state: 'cancelled', event: 'payment_voided' }
      : { state: 'needs_attention', event: 'payment_void_failed', recoveryFailure: failures.voidFailed };
    return (await finish(order, { ...change, ...(failure ? { failure } : {}) })).snapshot;
  }

  return {
    create: command => store.create(command.requestId),
    get: orderId => store.get(orderId),
    async authorizePayment(command) {
      const { claimed, order } = await claim(command, 'authorizePayment');
      if (!claimed) return order.snapshot;
      if (!order.authorizationKey) throw new Error('Authorization claim is missing its key.');
      let result: AuthorizePaymentResult;
      try {
        result = await payments.authorize({ orderId: command.orderId, idempotencyKey: order.authorizationKey });
      } catch {
        result = { status: 'error', failure: failures.authorizationUnknown };
      }
      let change: Transition;
      if (result.status === 'authorized' && result.authorizationId.trim().length > 0) {
        change = { state: 'payment_authorized', event: 'payment_authorized', authorizationId: result.authorizationId };
      } else if (result.status === 'declined') {
        change = { state: 'rejected', event: 'payment_declined', failure: failures.declined };
      } else {
        change = { state: 'payment_authorizing', event: 'payment_authorization_unconfirmed', failure: failures.authorizationUnknown };
      }
      return (await finish(order, change)).snapshot;
    },
    async completeOrder(command) {
      const { claimed, order } = await claim(command, 'completeOrder');
      if (!claimed) return order.snapshot;
      let result: CompletionResult;
      try {
        // One logical completion per order. This key remains stable across any future reconciliation.
        result = await completion.complete({ orderId: command.orderId, idempotencyKey: `complete:${command.orderId}` });
      } catch {
        result = { status: 'unknown' };
      }
      if (result.status === 'completed') {
        return (await finish(order, { state: 'complete', event: 'order_completed' })).snapshot;
      }
      if (result.status !== 'failed') {
        return (await finish(order, {
          state: 'completing', event: 'completion_unconfirmed', failure: failures.completionUnknown,
        })).snapshot;
      }
      const voiding = await finish(order, {
        state: 'payment_voiding', event: 'payment_void_started', voidKey: `void:${randomUUID()}`,
        failure: failures.completionFailed,
      });
      return voidPayment(voiding, failures.completionFailed);
    },
    async cancelOrder(command) {
      const { claimed, order } = await claim(command, 'cancelOrder');
      if (!claimed || order.snapshot.state === 'cancelled') return order.snapshot;
      return voidPayment(order);
    },
  };
}
