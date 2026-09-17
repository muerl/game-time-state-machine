import { getDb } from '../db/index.js';
import { createOrderStore } from '../db/order-store.js';
import { createStubPaymentGateway } from '../payments/stub-payment-gateway.js';
import { createOrderService } from './create-order-service.js';
import { createStubOrderCompletion } from './stub-order-completion.js';
import { OrderServiceError } from './order-service.js';
import type { OrderService } from './order-service.js';

/** Prototype composition: real persistence, simulated payment and completion. Lazy for builds. */
export function createConfiguredOrderService(): OrderService {
  let service: OrderService | undefined;
  function getService(): OrderService {
    if (!process.env.DATABASE_URL) throw new OrderServiceError('SERVICE_UNAVAILABLE');
    service ??= createOrderService({
      store: createOrderStore(getDb()),
      payments: createStubPaymentGateway(),
      completion: createStubOrderCompletion(),
    });
    return service;
  }
  return {
    create: command => getService().create(command),
    get: orderId => getService().get(orderId),
    authorizePayment: command => getService().authorizePayment(command),
    completeOrder: command => getService().completeOrder(command),
    cancelOrder: command => getService().cancelOrder(command),
  };
}
