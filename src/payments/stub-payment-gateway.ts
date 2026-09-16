import { createHash } from 'node:crypto';
import type { PaymentGateway } from './payment-gateway.js';

export type StubPaymentOptions = Readonly<{
  authorization?: 'authorized' | 'declined' | 'error';
  void?: 'voided' | 'error';
}>;

function requireText(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${name} must be a nonblank string.`);
  }
}

/** Deterministic simulation only: no network, storage, payment ledger, or order mutations. */
export function createStubPaymentGateway(options: StubPaymentOptions = {}): PaymentGateway {
  // Copy configuration so callers cannot change outcomes by mutating their options object.
  const authorization = options.authorization ?? 'authorized';
  const voidOutcome = options.void ?? 'voided';
  if (!['authorized', 'declined', 'error'].includes(authorization)
    || !['voided', 'error'].includes(voidOutcome)) {
    throw new TypeError('Unsupported stub payment outcome.');
  }

  return {
    async authorize(request) {
      requireText(request.orderId, 'orderId');
      requireText(request.idempotencyKey, 'idempotencyKey');

      if (authorization === 'declined') {
        return { status: 'declined', failure: {
          code: 'PAYMENT_DECLINED', message: 'Payment authorization was declined.',
        } };
      }
      if (authorization === 'error') {
        return { status: 'error', failure: {
          code: 'AUTHORIZATION_UNCONFIRMED', message: 'Payment authorization could not be confirmed.',
        } };
      }

      const reference = createHash('sha256')
        .update(JSON.stringify([request.orderId, request.idempotencyKey])).digest('hex');
      return { status: 'authorized', authorizationId: `stub_auth_${reference}` };
    },

    async voidAuthorization(request) {
      requireText(request.orderId, 'orderId');
      requireText(request.authorizationId, 'authorizationId');
      requireText(request.idempotencyKey, 'idempotencyKey');

      if (voidOutcome === 'error') {
        return { status: 'error', failure: {
          code: 'PAYMENT_VOID_UNCONFIRMED', message: 'Payment void could not be confirmed.',
        } };
      }
      return { status: 'voided' };
    },
  };
}
