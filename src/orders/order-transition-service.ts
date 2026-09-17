import type { AuthorizePaymentResult, VoidPaymentResult } from '../payments/payment-gateway.js';
import type { CompletionResult } from './order-completion-types.js';
import type { OrderOperationCommand } from './order-types.js';
import type { OrderOperation, StoredOrder } from './order-store-types.js';
import type { OrderClaim, CompletionTransitionOutcome } from './order-transition-service-types.js';

export interface OrderTransitionService {
  claim(command: OrderOperationCommand, operation: OrderOperation): Promise<OrderClaim>;
  /** A null payment result represents an exception with an unconfirmed outcome. */
  recordAuthorizationOutcome(expected: StoredOrder, result: AuthorizePaymentResult | null): Promise<StoredOrder>;
  recordCompletionOutcome(expected: StoredOrder, result: CompletionResult): Promise<CompletionTransitionOutcome>;
  recordVoidOutcome(expected: StoredOrder, result: VoidPaymentResult | null): Promise<StoredOrder>;
}
