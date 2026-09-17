import type { OrderState } from '../domain/order.js';
import { OrderServiceError } from './order-service.js';
import type { OrderOperation } from './order-store-types.js';

const desiredStates = {
  authorizePayment: 'payment_authorized',
  completeOrder: 'complete',
  cancelOrder: 'cancelled',
} as const satisfies Record<OrderOperation, OrderState>;

export class InvalidTransitionError extends OrderServiceError {
  readonly desiredState: OrderState;

  constructor(public readonly operation: OrderOperation, public readonly currentState: OrderState) {
    super('INVALID_TRANSITION');
    this.name = 'InvalidTransitionError';
    this.desiredState = desiredStates[operation];
    this.message = `Cannot ${operation} from ${currentState}; requested outcome is ${this.desiredState}.`;
  }
}
