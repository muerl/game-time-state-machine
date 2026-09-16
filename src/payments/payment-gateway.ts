import type { FailureDetails } from '../domain/order.js';

export type AuthorizePaymentRequest = Readonly<{
  orderId: string;
  /** Stable for retries of the same logical authorization; never a fresh random key per retry. */
  idempotencyKey: string;
}>;

export type VoidPaymentRequest = Readonly<{
  orderId: string;
  authorizationId: string;
  /** Stable for retries of the same logical void, distinct from the authorization key. */
  idempotencyKey: string;
}>;

export type AuthorizePaymentResult =
  | Readonly<{ status: 'authorized'; authorizationId: string }>
  | Readonly<{ status: 'declined'; failure: Readonly<FailureDetails> }>
  // An error does not establish whether authorization occurred. Never map it to a decline.
  | Readonly<{ status: 'error'; failure: Readonly<FailureDetails> }>;

export type VoidPaymentResult =
  | Readonly<{ status: 'voided' }>
  // Cancellation is safe only after a confirmed voided result.
  | Readonly<{ status: 'error'; failure: Readonly<FailureDetails> }>;

/**
 * Prototype boundary for the order lifecycle; no database or order-state writes.
 * A real adapter must validate provider responses, map errors to sanitized details,
 * and honor the supplied idempotency keys. Expected provider/network errors are
 * results; invalid local arguments/programming errors may reject the promise.
 * Real checkout inputs (amount, currency, payment token) are a later contract extension.
 */
export interface PaymentGateway {
  authorize(request: AuthorizePaymentRequest): Promise<AuthorizePaymentResult>;
  voidAuthorization(request: VoidPaymentRequest): Promise<VoidPaymentResult>;
}
