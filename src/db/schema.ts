import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { orderEvents, orderStates } from '../domain/order.js';
import type { FailureDetails } from '../domain/order.js';

export { orderEvents, orderStates } from '../domain/order.js';
export type { FailureDetails, OrderEvent, OrderState } from '../domain/order.js';

// DDL needs SQL literals, not bound parameters. Inputs are code-owned constants.
function literals(values: readonly string[]) {
  return sql.raw(values.map((value) => `'${value.replaceAll("'", "''")}'`).join(', '));
}

export const orders = pgTable('orders', {
  id: uuid('id').defaultRandom().primaryKey(),
  state: text('state', { enum: orderStates }).default('initialized').notNull(),
  version: integer('version').default(0).notNull(),
  paymentAuthorizationId: text('payment_authorization_id'),
  authorizationIdempotencyKey: text('authorization_idempotency_key'),
  voidIdempotencyKey: text('void_idempotency_key'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check('orders_state_valid', sql`${table.state} in (${literals(orderStates)})`),
  check('orders_version_nonnegative', sql`${table.version} >= 0`),
  check('orders_authorization_key_nonblank', sql`${table.authorizationIdempotencyKey} is null or ${table.authorizationIdempotencyKey} ~ '[^[:space:]]'`),
  check('orders_void_key_nonblank', sql`${table.voidIdempotencyKey} is null or ${table.voidIdempotencyKey} ~ '[^[:space:]]'`),
  check('orders_authorization_key_required', sql`${table.state} in ('initialized', 'cancelled') or ${table.authorizationIdempotencyKey} is not null`),
  check('orders_void_key_required', sql`${table.state} not in ('payment_voiding', 'needs_attention') or ${table.voidIdempotencyKey} is not null`),
  check('orders_cancelled_payment_shape', sql`${table.state} <> 'cancelled' or (
    (${table.authorizationIdempotencyKey} is null and ${table.voidIdempotencyKey} is null and ${table.paymentAuthorizationId} is null)
    or (${table.authorizationIdempotencyKey} is not null and ${table.voidIdempotencyKey} is not null and ${table.paymentAuthorizationId} is not null)
  )`),
  check('orders_operation_keys_distinct', sql`${table.authorizationIdempotencyKey} is null or ${table.voidIdempotencyKey} is null or ${table.authorizationIdempotencyKey} <> ${table.voidIdempotencyKey}`),
  uniqueIndex('orders_authorization_key_unique').on(table.authorizationIdempotencyKey),
  uniqueIndex('orders_void_key_unique').on(table.voidIdempotencyKey),
  index('orders_state_updated_at_idx').on(table.state, table.updatedAt),
]);

export const orderTransitions = pgTable('order_transitions', {
  id: uuid('id').defaultRandom().primaryKey(),
  orderId: uuid('order_id').notNull().references(() => orders.id, { onDelete: 'restrict' }),
  requestId: text('request_id').notNull(),
  fromState: text('from_state', { enum: orderStates }),
  toState: text('to_state', { enum: orderStates }).notNull(),
  event: text('event', { enum: orderEvents }).notNull(),
  version: integer('version').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  failure: jsonb('failure').$type<FailureDetails>(),
  recoveryFailure: jsonb('recovery_failure').$type<FailureDetails>(),
}, (table) => [
  uniqueIndex('order_transitions_request_unique').on(table.orderId, table.requestId),
  uniqueIndex('order_transitions_version_unique').on(table.orderId, table.version),
  check('order_transitions_request_nonempty', sql`${table.requestId} ~ '[^[:space:]]'`),
  check('order_transitions_from_state_valid', sql`${table.fromState} is null or ${table.fromState} in (${literals(orderStates)})`),
  check('order_transitions_to_state_valid', sql`${table.toState} in (${literals(orderStates)})`),
  check('order_transitions_event_valid', sql`${table.event} in (${literals(orderEvents)})`),
  check('order_transitions_initialization_shape', sql`(
    (${table.version} = 0 and ${table.fromState} is null
      and ${table.toState} = 'initialized' and ${table.event} = 'order_initialized')
    or (${table.version} > 0 and ${table.fromState} is not null
      and ${table.toState} <> 'initialized' and ${table.event} <> 'order_initialized')
  )`),
  check('order_transitions_failure_object', sql`${table.failure} is null or jsonb_typeof(${table.failure}) = 'object'`),
  check('order_transitions_recovery_failure_object', sql`${table.recoveryFailure} is null or jsonb_typeof(${table.recoveryFailure}) = 'object'`),
]);

export type Order = typeof orders.$inferSelect;
export type NewOrder = typeof orders.$inferInsert;
export type OrderTransition = typeof orderTransitions.$inferSelect;
export type NewOrderTransition = typeof orderTransitions.$inferInsert;
