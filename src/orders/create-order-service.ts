import { randomUUID } from 'node:crypto';
import type { FailureDetails } from '../domain/order.js';
import type { PaymentGateway, AuthorizePaymentResult, VoidPaymentResult } from '../payments/payment-gateway.js';
import type { OrderCompletion } from './order-completion.js';
import type { CompletionResult } from './order-completion-types.js';
import { createOrderTransitionService } from './create-order-transition-service.js';
import type { OrderService } from './order-service.js';
import type { OrderStore } from './order-store.js';
import type { StoredOrder, Transition } from './order-store-types.js';
import type { OrderSnapshot } from './order-types.js';

const failures = {
  declined: { code: 'PAYMENT_DECLINED', message: 'Payment authorization was declined.' },
  authorizationUnknown: { code: 'AUTHORIZATION_UNCONFIRMED', message: 'Payment authorization requires reconciliation.' },
  completionFailed: { code: 'COMPLETION_FAILED', message: 'Order completion failed.' },
  completionUnknown: { code: 'COMPLETION_UNCONFIRMED', message: 'Order completion requires reconciliation.' },
  voidFailed: { code: 'PAYMENT_VOID_UNCONFIRMED', message: 'Payment void requires manual attention.' },
} as const satisfies Record<string, FailureDetails>;

type Dependencies = Readonly<{ store: OrderStore; payments: PaymentGateway; completion: OrderCompletion }>;

/** No external call occurs until its durable claim transaction has committed. */
export function createOrderService({ store, payments, completion }: Dependencies): OrderService {
  const transitions = createOrderTransitionService(store);

  async function voidPayment(order: StoredOrder, failure?: FailureDetails): Promise<OrderSnapshot> {
    if (!order.authorizationId || !order.voidIdempotencyKey) throw new Error('Void claim is missing payment references.');
    let result: VoidPaymentResult;
    try {
      result = await payments.voidAuthorization({
        orderId: order.snapshot.id, authorizationId: order.authorizationId, idempotencyKey: order.voidIdempotencyKey,
      });
    } catch {
      result = { status: 'error', failure: failures.voidFailed };
    }
    const change: Transition = result.status === 'voided'
      ? { state: 'cancelled', event: 'payment_voided' }
      : { state: 'needs_attention', event: 'payment_void_failed', recoveryFailure: failures.voidFailed };
    return (await transitions.finish(order, { ...change, ...(failure ? { failure } : {}) })).snapshot;
  }

  return {
    create: command => store.create(command.requestId),
    get: orderId => store.get(orderId),
    async authorizePayment(command) {
      const { claimed, order } = await transitions.claim(command, 'authorizePayment');
      if (!claimed) return order.snapshot;
      if (!order.authorizationIdempotencyKey) throw new Error('Authorization claim is missing its key.');
      let result: AuthorizePaymentResult;
      try {
        result = await payments.authorize({ orderId: command.orderId, idempotencyKey: order.authorizationIdempotencyKey });
      } catch {
        result = { status: 'error', failure: failures.authorizationUnknown };
      }
      let change: Transition;
      if (result.status === 'authorized' && result.authorizationId.trim().length > 0) {
        change = { state: 'payment_authorized', event: 'payment_authorized', authorizationId: result.authorizationId };
      } else if (result.status === 'declined') {
        change = { state: 'rejected', event: 'payment_declined', failure: failures.declined };
      } else {
        change = { state: 'needs_attention', event: 'payment_authorization_unconfirmed', failure: failures.authorizationUnknown };
      }
      return (await transitions.finish(order, change)).snapshot;
    },
    async completeOrder(command) {
      const { claimed, order } = await transitions.claim(command, 'completeOrder');
      if (!claimed) return order.snapshot;
      let result: CompletionResult;
      try {
        // One logical completion per order. This key remains stable across any future reconciliation.
        result = await completion.complete({ orderId: command.orderId, idempotencyKey: `complete:${command.orderId}` });
      } catch {
        result = { status: 'unknown' };
      }
      if (result.status === 'completed') {
        return (await transitions.finish(order, { state: 'complete', event: 'order_completed' })).snapshot;
      }
      if (result.status !== 'failed') {
        return (await transitions.finish(order, {
          state: 'needs_attention', event: 'completion_unconfirmed', failure: failures.completionUnknown,
        })).snapshot;
      }
      const voiding = await transitions.finish(order, {
        state: 'payment_voiding', event: 'payment_void_started', voidIdempotencyKey: `void:${randomUUID()}`,
        failure: failures.completionFailed,
      });
      return voidPayment(voiding, failures.completionFailed);
    },
    async cancelOrder(command) {
      const { claimed, order } = await transitions.claim(command, 'cancelOrder');
      if (!claimed || order.snapshot.state === 'cancelled') return order.snapshot;
      return voidPayment(order);
    },
  };
}
