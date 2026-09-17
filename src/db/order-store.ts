import { randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import type { OrderStore } from '../orders/order-store.js';
import type { StoredOrder } from '../orders/order-store-types.js';
import { OrderServiceError } from '../orders/order-service.js';
import { orderCommands, orders, orderTransitions } from './schema.js';
import type { Order } from './schema.js';

// The same adapter runs with node-postgres in the app and PGlite in integration tests.
export function createOrderStore<Result extends PgQueryResultHKT, Schema extends Record<string, unknown>>(db: PgDatabase<Result, Schema>): OrderStore {
  type Connection = Pick<typeof db, 'select' | 'insert' | 'update'>;
  async function read(connection: Connection, order: Order): Promise<StoredOrder> {
    const entries = await connection.select().from(orderTransitions)
      .where(eq(orderTransitions.orderId, order.id)).orderBy(asc(orderTransitions.version));
    return {
      snapshot: {
        id: order.id, state: order.state, version: order.version,
        createdAt: order.createdAt, updatedAt: order.updatedAt,
        history: entries.map(entry => ({
          id: entry.id, fromState: entry.fromState, toState: entry.toState, event: entry.event,
          version: entry.version, createdAt: entry.createdAt,
          failure: entry.failure, recoveryFailure: entry.recoveryFailure,
        })),
      },
      authorizationIdempotencyKey: order.authorizationIdempotencyKey,
      authorizationId: order.paymentAuthorizationId,
      voidIdempotencyKey: order.voidIdempotencyKey,
    };
  }
  return {
    async create(requestId) {
      return db.transaction(async transaction => {
        const [created] = await transaction.insert(orders).values({ creationRequestId: requestId })
          .onConflictDoNothing({ target: orders.creationRequestId }).returning();
        if (created) {
          await transaction.insert(orderTransitions).values({
            orderId: created.id, requestId: randomUUID(), fromState: null,
            toState: 'initialized', event: 'order_initialized', version: 0,
          });
          return { order: (await read(transaction, created)).snapshot, replayed: false };
        }
        // Idempotent recovery: a retried creation returns the order already committed for this key.
        const [existing] = await transaction.select().from(orders)
          .where(eq(orders.creationRequestId, requestId)).for('share');
        if (!existing) throw new Error('Creation replay is missing its order.');
        return { order: (await read(transaction, existing)).snapshot, replayed: true };
      });
    },
    async get(orderId) {
      return db.transaction(async transaction => {
        // Hold a shared row lock across both reads for a consistent state/history snapshot.
        const [order] = await transaction.select().from(orders).where(eq(orders.id, orderId)).for('share');
        return order ? (await read(transaction, order)).snapshot : null;
      });
    },
    async transaction(orderId, work) {
      return db.transaction(async transaction => {
        let [row] = await transaction.select().from(orders).where(eq(orders.id, orderId)).for('update');
        if (!row) throw new OrderServiceError('ORDER_NOT_FOUND');
        const order = await read(transaction, row);
        return work({
          order,
          async findCommand(requestId) {
            const [command] = await transaction.select().from(orderCommands).where(and(
              eq(orderCommands.orderId, orderId), eq(orderCommands.requestId, requestId),
            ));
            return command?.operation ?? null;
          },
          async recordCommand(requestId, operation) {
            await transaction.insert(orderCommands).values({ orderId, requestId, operation });
          },
          async transition(change) {
            if (!row) throw new Error('Missing locked order.');
            const [updated] = await transaction.update(orders).set({
              state: change.state, version: row.version + 1, updatedAt: new Date(),
              ...(change.authorizationIdempotencyKey !== undefined ? { authorizationIdempotencyKey: change.authorizationIdempotencyKey } : {}),
              ...(change.authorizationId !== undefined ? { paymentAuthorizationId: change.authorizationId } : {}),
              ...(change.voidIdempotencyKey !== undefined ? { voidIdempotencyKey: change.voidIdempotencyKey } : {}),
            }).where(and(eq(orders.id, orderId), eq(orders.state, row.state), eq(orders.version, row.version))).returning();
            if (!updated) throw new OrderServiceError('OPERATION_CONFLICT');
            await transaction.insert(orderTransitions).values({
              orderId, requestId: randomUUID(), fromState: row.state,
              toState: updated.state, event: change.event, version: updated.version,
              createdAt: updated.updatedAt, failure: change.failure ?? null,
              recoveryFailure: change.recoveryFailure ?? null,
            });
            row = updated;
            return read(transaction, updated);
          },
        });
      });
    },
  };
}
