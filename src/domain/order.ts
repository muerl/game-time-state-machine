export const orderStates = [
  'initialized', 'payment_authorizing', 'payment_authorized', 'completing',
  'payment_voiding', 'complete', 'rejected', 'cancelled', 'needs_attention',
] as const;

export const orderEvents = [
  'order_initialized', 'payment_authorization_started', 'payment_authorized', 'payment_declined',
  'completion_started', 'payment_void_started',
  'order_completed', 'payment_voided', 'payment_void_failed', 'order_cancelled',
  'payment_authorization_unconfirmed', 'completion_unconfirmed',
] as const;

export type OrderState = typeof orderStates[number];
export type OrderEvent = typeof orderEvents[number];

// Exhaustive classification: adding a state requires an explicit decision here.
const orderStateProgress = {
  initialized: 'settled',
  payment_authorizing: 'pending',
  payment_authorized: 'settled',
  completing: 'pending',
  payment_voiding: 'pending',
  complete: 'settled',
  rejected: 'settled',
  cancelled: 'settled',
  needs_attention: 'settled',
} as const satisfies Record<OrderState, 'pending' | 'settled'>;

export function isOrderPending(state: OrderState): boolean {
  return orderStateProgress[state] === 'pending';
}

// Persist only sanitized, application-controlled details, not provider responses.
export type FailureDetails = { code: string; message: string };
