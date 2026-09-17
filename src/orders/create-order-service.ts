import type { PaymentGateway, AuthorizePaymentResult, VoidPaymentResult } from '../payments/payment-gateway.js';
import type { OrderCompletion } from './order-completion.js';
import type { CompletionResult } from './order-completion-types.js';
import { createOrderTransitionService } from './create-order-transition-service.js';
import type { OrderService } from './order-service.js';
import type { OrderStore } from './order-store.js';
import type { StoredOrder } from './order-store-types.js';
import type { OrderSnapshot } from './order-types.js';

type Dependencies = Readonly<{ store: OrderStore; payments: PaymentGateway; completion: OrderCompletion }>;

/** No external call occurs until its durable claim transaction has committed. */
export function createOrderService({ store, payments, completion }: Dependencies): OrderService {
  const transitions = createOrderTransitionService(store);

  async function voidPayment(order: StoredOrder): Promise<OrderSnapshot> {
    if (!order.authorizationId || !order.voidIdempotencyKey) throw new Error('Void claim is missing payment references.');
    let result: VoidPaymentResult | null;
    try {
      result = await payments.voidAuthorization({
        orderId: order.snapshot.id, authorizationId: order.authorizationId, idempotencyKey: order.voidIdempotencyKey,
      });
    } catch {
      result = null;
    }
    return (await transitions.recordVoidOutcome(order, result)).snapshot;
  }

  return {
    create: command => store.create(command.requestId),
    get: orderId => store.get(orderId),
    async authorizePayment(command) {
      const { claimed, order } = await transitions.claim(command, 'authorizePayment');
      if (!claimed) return order.snapshot;
      if (!order.authorizationIdempotencyKey) throw new Error('Authorization claim is missing its key.');
      let result: AuthorizePaymentResult | null;
      try {
        result = await payments.authorize({ orderId: command.orderId, idempotencyKey: order.authorizationIdempotencyKey });
      } catch {
        result = null;
      }
      return (await transitions.recordAuthorizationOutcome(order, result)).snapshot;
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
      const outcome = await transitions.recordCompletionOutcome(order, result);
      return outcome.nextAction === 'voidPayment' ? voidPayment(outcome.order) : outcome.order.snapshot;
    },
    async cancelOrder(command) {
      const { claimed, order } = await transitions.claim(command, 'cancelOrder');
      if (!claimed || order.snapshot.state === 'cancelled') return order.snapshot;
      return voidPayment(order);
    },
  };
}
