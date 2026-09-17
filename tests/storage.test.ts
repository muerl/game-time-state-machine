import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { and, asc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { orders, orderTransitions } from '../src/db/schema.js';
import type { FailureDetails, OrderEvent, OrderState } from '../src/db/schema.js';

const client = new PGlite();
const db = drizzle(client);
before(async () => { await migrate(db, { migrationsFolder: './drizzle' }); });
beforeEach(async () => { await client.exec('TRUNCATE order_commands, order_transitions, orders'); });
after(async () => { await client.close(); });

function rejectsConstraint(name: string, code = '23514') {
  return (error: unknown): boolean => {
    assert.ok(typeof error === 'object' && error !== null);
    const detail = error as { cause?: unknown; code?: unknown; constraint?: unknown };
    if (detail.cause) return rejectsConstraint(name, code)(detail.cause);
    assert.equal(detail.code, code);
    assert.equal(detail.constraint, name);
    return true;
  };
}

async function createOrder() {
  return db.transaction(async (tx) => {
    const [order] = await tx.insert(orders).values({}).returning();
    assert.ok(order);
    await tx.insert(orderTransitions).values({
      orderId: order.id, requestId: 'create', fromState: null,
      toState: 'initialized', event: 'order_initialized', version: 0,
    });
    return order;
  });
}

function authorizationKey(orderId: string) { return `authorize:${orderId}`; }

// Fixture writes exercise the storage contract, not a production transition service.
async function recordFixture(
  orderId: string, fromState: OrderState, toState: OrderState, event: OrderEvent,
  version: number, failure: FailureDetails | null = null,
  recoveryFailure: FailureDetails | null = null,
) {
  await db.transaction(async (tx) => {
    const changed = await tx.update(orders).set({
      state: toState, version, updatedAt: new Date(),
      ...(toState === 'payment_authorizing' ? { authorizationIdempotencyKey: authorizationKey(orderId) } : {}),
      ...(toState === 'payment_voiding' ? { voidIdempotencyKey: `void:${orderId}` } : {}),
      ...(toState === 'payment_authorized' ? { paymentAuthorizationId: 'auth_test' } : {}),
    }).where(and(eq(orders.id, orderId), eq(orders.version, version - 1), eq(orders.state, fromState))).returning();
    assert.equal(changed.length, 1);
    await tx.insert(orderTransitions).values({
      orderId, requestId: `request-${version}`, fromState, toState, event,
      version, failure, recoveryFailure,
    });
  });
}

const completionFailure = { code: 'COMPLETION_FAILED', message: 'Ticket completion failed.' };
const voidFailure = { code: 'VOID_FAILED', message: 'Payment void failed.' };

test('initial migration is repeatable and creates defaults, history and attention index', async () => {
  await migrate(db, { migrationsFolder: './drizzle' });
  const order = await createOrder();
  assert.equal(order.state, 'initialized');
  assert.equal(order.version, 0);
  assert.equal(order.paymentAuthorizationId, null);
  assert.ok(order.createdAt instanceof Date);
  assert.ok(order.updatedAt instanceof Date);
  const [entry] = await db.select().from(orderTransitions);
  assert.ok(entry);
  assert.equal(entry.fromState, null);
  assert.equal(entry.version, 0);
  assert.equal(entry.failure, null);
  assert.equal(entry.recoveryFailure, null);
  assert.ok(entry.createdAt instanceof Date);
  const indexes = await client.query<{ indexdef: string }>(
    "SELECT indexdef FROM pg_indexes WHERE indexname = 'orders_state_updated_at_idx'",
  );
  assert.match(indexes.rows[0]?.indexdef ?? '', /\(state, updated_at\)/);
});

for (const scenario of [
  { state: 'complete', event: 'order_completed', failure: null, recovery: null },
  { state: 'rejected', event: 'payment_declined', failure: { code: 'DECLINED', message: 'Payment declined.' }, recovery: null },
  { state: 'cancelled', event: 'payment_voided', failure: completionFailure, recovery: null },
  { state: 'needs_attention', event: 'payment_void_failed', failure: completionFailure, recovery: voidFailure },
] as const) {
  test(`persists the ${scenario.state} path with ordered history and failure context`, async () => {
    const order = await createOrder();
    const authorized = scenario.state !== 'rejected';
    const needsVoid = scenario.state === 'cancelled' || scenario.state === 'needs_attention';
    await recordFixture(order.id, 'initialized', 'payment_authorizing', 'payment_authorization_started', 1);
    if (authorized) {
      await recordFixture(order.id, 'payment_authorizing', 'payment_authorized', 'payment_authorized', 2);
      await recordFixture(order.id, 'payment_authorized', 'completing', 'completion_started', 3);
    }
    if (needsVoid) {
      await recordFixture(order.id, 'completing', 'payment_voiding', 'payment_void_started', 4, completionFailure);
    }
    const finalVersion = needsVoid ? 5 : authorized ? 4 : 2;
    await recordFixture(order.id, needsVoid ? 'payment_voiding' : authorized ? 'completing' : 'payment_authorizing',
      scenario.state, scenario.event, finalVersion, scenario.failure, scenario.recovery);
    const [current] = await db.select().from(orders).where(eq(orders.id, order.id));
    assert.ok(current);
    assert.equal(current.state, scenario.state);
    assert.equal(current.version, finalVersion);
    assert.equal(current.paymentAuthorizationId, authorized ? 'auth_test' : null);
    assert.equal(current.authorizationIdempotencyKey, authorizationKey(order.id));
    assert.equal(current.voidIdempotencyKey, needsVoid ? `void:${order.id}` : null);
    const history = await db.select().from(orderTransitions)
      .where(eq(orderTransitions.orderId, order.id)).orderBy(asc(orderTransitions.version));
    assert.deepEqual(history.map((entry) => entry.toState), [
      'initialized', 'payment_authorizing',
      ...(authorized ? ['payment_authorized', 'completing'] : []),
      ...(needsVoid ? ['payment_voiding'] : []), scenario.state,
    ]);
    assert.deepEqual(history.map((entry) => entry.version), Array.from({ length: finalVersion + 1 }, (_, i) => i));
    assert.deepEqual(history.at(-1)?.failure, scenario.failure);
    assert.deepEqual(history.at(-1)?.recoveryFailure, scenario.recovery);
  });
}

test('database rejects invalid state/event values even through raw SQL', async () => {
  await assert.rejects(client.query("INSERT INTO orders (state, authorization_idempotency_key) VALUES ('unknown', 'test-key')"),
    rejectsConstraint('orders_state_valid'));
  const order = await createOrder();
  for (const [from, to, event, constraint] of [
    ['unknown', 'complete', 'order_completed', 'order_transitions_from_state_valid'],
    ['payment_authorized', 'unknown', 'order_completed', 'order_transitions_to_state_valid'],
    ['payment_authorized', 'complete', 'unknown', 'order_transitions_event_valid'],
  ]) {
    await assert.rejects(client.query(
      'INSERT INTO order_transitions (order_id, request_id, from_state, to_state, event, version) VALUES ($1, $2, $3, $4, $5, 1)',
      [order.id, randomUUID(), from, to, event],
    ), rejectsConstraint(constraint!));
  }
});

test('database rejects malformed initialization and invalid versions', async () => {
  const order = await createOrder();
  for (const [from, to, event, version] of [
    ['initialized', 'initialized', 'order_initialized', 0],
    [null, 'complete', 'order_initialized', 0],
    [null, 'initialized', 'order_completed', 0],
    [null, 'initialized', 'order_initialized', 1],
    [null, 'complete', 'order_completed', 1],
    ['payment_authorized', 'initialized', 'order_completed', 1],
    ['payment_authorized', 'complete', 'order_initialized', 1],
    ['payment_authorized', 'complete', 'order_completed', 0],
    ['payment_authorized', 'complete', 'order_completed', -1],
  ]) {
    await assert.rejects(client.query(
      'INSERT INTO order_transitions (order_id, request_id, from_state, to_state, event, version) VALUES ($1, $2, $3, $4, $5, $6)',
      [order.id, randomUUID(), from, to, event, version],
    ), rejectsConstraint('order_transitions_initialization_shape'));
  }
  await assert.rejects(db.update(orders).set({ version: -1 }).where(eq(orders.id, order.id)),
    rejectsConstraint('orders_version_nonnegative'));
});

test('database rejects empty request IDs and non-object failure values', async () => {
  const order = await createOrder();
  for (const requestId of ['', ' \t\n']) {
    await assert.rejects(db.insert(orderTransitions).values({
      orderId: order.id, requestId, fromState: 'initialized', toState: 'rejected',
      event: 'payment_declined', version: 1,
    }), rejectsConstraint('order_transitions_request_nonempty'));
  }
  for (const column of ['failure', 'recovery_failure'] as const) {
    for (const value of ['[]', '"text"', '42', 'true', 'null']) {
      // Column is a fixed test-owned identifier; values remain parameterized.
      await assert.rejects(client.query(
        `INSERT INTO order_transitions (order_id, request_id, from_state, to_state, event, version, ${column}) VALUES ($1, $2, 'initialized', 'rejected', 'payment_declined', 1, $3::jsonb)`,
        [order.id, randomUUID(), value],
      ), rejectsConstraint(`order_transitions_${column}_object`));
    }
  }
});

test('request IDs and versions are unique within each order, not across orders', async () => {
  const first = await createOrder();
  const second = await createOrder();
  const transition = {
    orderId: first.id, requestId: 'authorize', fromState: 'initialized',
    toState: 'payment_authorized', event: 'payment_authorized', version: 1,
  } as const;
  await db.insert(orderTransitions).values(transition);
  await assert.rejects(db.insert(orderTransitions).values({ ...transition, version: 2 }),
    rejectsConstraint('order_transitions_request_unique', '23505'));
  await assert.rejects(db.insert(orderTransitions).values({ ...transition, requestId: 'different' }),
    rejectsConstraint('order_transitions_version_unique', '23505'));
  await db.insert(orderTransitions).values({ ...transition, orderId: second.id });
});

test('history cannot be orphaned and prevents deleting its order', async () => {
  const order = await createOrder();
  await assert.rejects(db.insert(orderTransitions).values({
    orderId: randomUUID(), requestId: 'create', toState: 'initialized',
    event: 'order_initialized', version: 0,
  }), rejectsConstraint('order_transitions_order_id_orders_id_fk', '23503'));
  await assert.rejects(db.delete(orders).where(eq(orders.id, order.id)),
    rejectsConstraint('order_transitions_order_id_orders_id_fk', '23001'));
});

test('failed writes roll back both creation and subsequent state/history updates', async () => {
  await assert.rejects(db.transaction(async (tx) => {
    const [order] = await tx.insert(orders).values({}).returning();
    assert.ok(order);
    await tx.insert(orderTransitions).values({
      orderId: order.id, requestId: 'create', toState: 'initialized',
      event: 'order_initialized', version: 0,
    });
    throw new Error('Simulated failure');
  }), /Simulated failure/);
  assert.equal((await db.select().from(orders)).length, 0);
  assert.equal((await db.select().from(orderTransitions)).length, 0);

  const order = await createOrder();
  await assert.rejects(db.transaction(async (tx) => {
    await tx.update(orders).set({ state: 'payment_authorized', version: 1,
      paymentAuthorizationId: 'auth_test', authorizationIdempotencyKey: authorizationKey(order.id), updatedAt: new Date(),
    }).where(eq(orders.id, order.id));
    await tx.insert(orderTransitions).values({
      orderId: order.id, requestId: 'authorize', fromState: 'initialized',
      toState: 'payment_authorized', event: 'payment_authorized', version: 1,
    });
    throw new Error('Simulated failure');
  }), /Simulated failure/);
  assert.deepEqual((await db.select().from(orders))[0], order);
  assert.equal((await db.select().from(orderTransitions)).length, 1);
});

test('payment states require durable nonblank, distinct operation keys', async () => {
  for (const state of ['payment_authorizing', 'payment_authorized', 'completing', 'complete', 'rejected', 'payment_voiding', 'needs_attention'] as const) {
    await assert.rejects(db.insert(orders).values({ state }),
      rejectsConstraint('orders_authorization_key_required'));
  }
  for (const state of ['payment_voiding', 'needs_attention'] as const) {
    await assert.rejects(db.insert(orders).values({ state, authorizationIdempotencyKey: randomUUID() }),
      rejectsConstraint('orders_void_key_required'));
  }
  for (const value of ['', ' \t\n']) {
    await assert.rejects(db.insert(orders).values({ authorizationIdempotencyKey: value }),
      rejectsConstraint('orders_authorization_key_nonblank'));
    await assert.rejects(db.insert(orders).values({ voidIdempotencyKey: value }),
      rejectsConstraint('orders_void_key_nonblank'));
  }
  await assert.rejects(db.insert(orders).values({ authorizationIdempotencyKey: 'same', voidIdempotencyKey: 'same' }),
    rejectsConstraint('orders_operation_keys_distinct'));
});

test('operation keys cannot accidentally be shared by different orders', async () => {
  await db.insert(orders).values({ authorizationIdempotencyKey: 'authorize:one', voidIdempotencyKey: 'void:one' });
  await assert.rejects(db.insert(orders).values({ authorizationIdempotencyKey: 'authorize:one' }),
    rejectsConstraint('orders_authorization_key_unique', '23505'));
  await assert.rejects(db.insert(orders).values({ voidIdempotencyKey: 'void:one' }),
    rejectsConstraint('orders_void_key_unique', '23505'));
});

for (const stage of [
  { from: 'initialized', to: 'payment_authorizing', event: 'payment_authorization_started', version: 0 },
  { from: 'payment_authorized', to: 'completing', event: 'completion_started', version: 2 },
  { from: 'completing', to: 'payment_voiding', event: 'payment_void_started', version: 3 },
] as const) {
  test(`only one conditional claim can enter ${stage.to}; later requests preserve the pending claim`, async () => {
    const order = await createOrder();
    if (stage.version >= 2) {
      await recordFixture(order.id, 'initialized', 'payment_authorizing', 'payment_authorization_started', 1);
      await recordFixture(order.id, 'payment_authorizing', 'payment_authorized', 'payment_authorized', 2);
    }
    if (stage.version === 3) {
      await recordFixture(order.id, 'payment_authorized', 'completing', 'completion_started', 3);
    }
    // Competing callers both start with the same observed state/version. PGlite
    // serializes transactions; this proves the CAS predicate, not network concurrency.
    async function claim(caller: string) {
      return db.transaction(async (tx) => {
        const key = `${stage.to}:${order.id}:${caller}`;
        const [claimed] = await tx.update(orders).set({
          state: stage.to, version: stage.version + 1, updatedAt: new Date(),
          ...(stage.to === 'payment_authorizing' ? { authorizationIdempotencyKey: key } : {}),
          ...(stage.to === 'payment_voiding' ? { voidIdempotencyKey: key } : {}),
        }).where(and(eq(orders.id, order.id), eq(orders.state, stage.from), eq(orders.version, stage.version))).returning();
        if (!claimed) return undefined;
        await tx.insert(orderTransitions).values({
          orderId: order.id, requestId: `claim:${caller}`, fromState: stage.from,
          toState: stage.to, event: stage.event, version: claimed.version,
          failure: stage.to === 'payment_voiding' ? completionFailure : null,
        });
        return claimed;
      });
    }
    const results = await Promise.all([claim('first'), claim('second')]);
    const winners = results.filter((result) => result !== undefined);
    assert.equal(winners.length, 1);
    // No confirmed provider outcome yet: a third caller cannot reset or replace the key.
    assert.equal(await claim('retry'), undefined);
    assert.deepEqual((await db.select().from(orders).where(eq(orders.id, order.id)))[0], winners[0]);
    const entries = await db.select().from(orderTransitions).where(eq(orderTransitions.orderId, order.id));
    assert.equal(entries.length, stage.version + 2);
    assert.equal(entries.filter((entry) => entry.toState === stage.to).length, 1);
  });
}


test('initialized orders can be cancelled without payment fields', async () => {
  const order = await createOrder();
  await recordFixture(order.id, 'initialized', 'cancelled', 'order_cancelled', 1);
  const [cancelled] = await db.select().from(orders);
  assert.equal(cancelled?.state, 'cancelled');
  assert.equal(cancelled?.authorizationIdempotencyKey, null);
  assert.equal(cancelled?.voidIdempotencyKey, null);
  assert.equal(cancelled?.paymentAuthorizationId, null);
  const history = await db.select().from(orderTransitions).orderBy(asc(orderTransitions.version));
  assert.deepEqual(history.map(entry => entry.event), ['order_initialized', 'order_cancelled']);
});

test('authorized orders can cancel through voiding without a completion failure', async () => {
  const order = await createOrder();
  await recordFixture(order.id, 'initialized', 'payment_authorizing', 'payment_authorization_started', 1);
  await recordFixture(order.id, 'payment_authorizing', 'payment_authorized', 'payment_authorized', 2);
  await recordFixture(order.id, 'payment_authorized', 'payment_voiding', 'payment_void_started', 3);
  await recordFixture(order.id, 'payment_voiding', 'cancelled', 'payment_voided', 4);
  const [cancelled] = await db.select().from(orders);
  assert.equal(cancelled?.state, 'cancelled');
  assert.equal(cancelled?.paymentAuthorizationId, 'auth_test');
  assert.ok(cancelled?.voidIdempotencyKey);
  const history = await db.select().from(orderTransitions);
  assert.ok(history.every(entry => entry.failure === null && entry.recoveryFailure === null));
});

test('cancelled orders reject partial payment data that could hide an unvoided authorization', async () => {
  for (const payment of [
    { authorizationIdempotencyKey: 'authorize:one' },
    { voidIdempotencyKey: 'void:one' },
    { paymentAuthorizationId: 'auth_one' },
    { authorizationIdempotencyKey: 'authorize:one', paymentAuthorizationId: 'auth_one' },
    { authorizationIdempotencyKey: 'authorize:one', voidIdempotencyKey: 'void:one' },
  ]) {
    await assert.rejects(db.insert(orders).values({ state: 'cancelled', ...payment }),
      rejectsConstraint('orders_cancelled_payment_shape'));
  }
});
