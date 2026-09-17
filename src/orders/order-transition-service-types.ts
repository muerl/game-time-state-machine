import type { StoredOrder } from './order-store-types.js';

export type OrderClaim = Readonly<{ claimed: boolean; order: StoredOrder }>;

export type CompletionTransitionOutcome = Readonly<{
  order: StoredOrder;
  nextAction: 'return' | 'voidPayment';
}>;
