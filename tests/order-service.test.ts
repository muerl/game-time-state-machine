import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { eq } from 'drizzle-orm';
import { createOrderStore } from '../src/db/order-store.js';
import { orders, orderCommands, orderTransitions } from '../src/db/schema.js';
import { createOrderService } from '../src/orders/create-order-service.js';
import { createStubOrderCompletion } from '../src/orders/stub-order-completion.js';
import type { OrderCompletion } from '../src/orders/order-completion.js';
import { InvalidTransitionError } from '../src/orders/invalid-transition-error.js';
import { OrderServiceError } from '../src/orders/order-service.js';
import type { OrderService } from '../src/orders/order-service.js';
import type { OrderStore } from '../src/orders/order-store.js';
import { createStubPaymentGateway } from '../src/payments/stub-payment-gateway.js';
import type { PaymentGateway } from '../src/payments/payment-gateway.js';
import { createOrderApi } from '../src/http/app.js';

const client = new PGlite();
const db = drizzle(client);
const store = createOrderStore(db);
before(async () => { await migrate(db, { migrationsFolder: './drizzle' }); });
beforeEach(async () => { await client.exec('TRUNCATE order_commands, order_transitions, orders'); });
after(async () => { await client.close(); });

function setup(options: { payments?: PaymentGateway; completion?: OrderCompletion; store?: OrderStore } = {}) {
  return createOrderService({ store, payments: createStubPaymentGateway(), completion: createStubOrderCompletion(), ...options });
}
function errorCode(code: string) {
  return (error: unknown) => error instanceof OrderServiceError && error.code === code;
}
async function initialized(service: OrderService) {
  return (await service.create({ requestId: 'create-1' })).order.id;
}
async function authorized(service: OrderService) {
  const orderId = await initialized(service);
  await service.authorizePayment({ orderId, requestId: 'authorize-1' });
  return orderId;
}
function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>(done => { resolve = done; });
  return { promise, resolve };
}

for (const scenario of [
  { authorization: 'authorized', completion: 'completed', void: 'voided', state: 'complete' },
  { authorization: 'declined', completion: 'completed', void: 'voided', state: 'rejected' },
  { authorization: 'authorized', completion: 'failed', void: 'voided', state: 'cancelled' },
  { authorization: 'authorized', completion: 'failed', void: 'error', state: 'needs_attention' },
] as const) {
  test(`service persists the ${scenario.state} path and stage-specific failure history`, async () => {
    let completions = 0;
    let voids = 0;
    const gateway = createStubPaymentGateway({ authorization: scenario.authorization, void: scenario.void });
    const service = setup({
      payments: { ...gateway, voidAuthorization: async request => { voids++; return gateway.voidAuthorization(request); } },
      completion: { complete: async () => { completions++; return { status: scenario.completion }; } },
    });
    const orderId = await initialized(service);
    let result = await service.authorizePayment({ orderId, requestId: 'authorize-1' });
    if (scenario.authorization === 'authorized') result = await service.completeOrder({ orderId, requestId: 'complete-1' });
    assert.equal(result.state, scenario.state);
    assert.equal(completions, scenario.authorization === 'declined' ? 0 : 1);
    assert.equal(voids, scenario.completion === 'failed' ? 1 : 0);
    assert.deepEqual(result.history.map(entry => entry.version), Array.from({ length: result.version + 1 }, (_, index) => index));
    assert.ok(result.history.every(entry => entry.createdAt instanceof Date));
    const outcome = result.history.at(-1)!;
    assert.equal(outcome.failure?.code ?? null,
      scenario.state === 'rejected' ? 'PAYMENT_DECLINED' : scenario.completion === 'failed' ? 'COMPLETION_FAILED' : null);
    assert.equal(outcome.recoveryFailure?.code ?? null, scenario.state === 'needs_attention' ? 'PAYMENT_VOID_UNCONFIRMED' : null);
    if (scenario.completion === 'failed') {
      const voidStart = result.history.find(entry => entry.event === 'payment_void_started');
      assert.equal(voidStart?.failure?.code, 'COMPLETION_FAILED');
    }
    assert.deepEqual(await service.get(orderId), result);
  });
}

test('creation deduplicates across service instances and concurrent requests', async () => {
  const results = await Promise.all([setup().create({ requestId: 'same' }), setup().create({ requestId: 'same' })]);
  assert.equal(results[0]!.order.id, results[1]!.order.id);
  assert.deepEqual(results.map(result => result.replayed).sort(), [false, true]);
  assert.equal((await db.select().from(orders)).length, 1);
  assert.equal((await db.select().from(orderTransitions)).length, 1);
});

test('slow authorization is claimed before calling the gateway and retries cannot start another attempt', async () => {
  const entered = deferred<void>();
  const response = deferred<Awaited<ReturnType<PaymentGateway['authorize']>>>();
  let calls = 0;
  let providerKey = '';
  const payments: PaymentGateway = { ...createStubPaymentGateway(), authorize: async request => {
    calls++; providerKey = request.idempotencyKey; entered.resolve(); return response.promise;
  } };
  const service = setup({ payments });
  const orderId = await initialized(service);
  const first = service.authorizePayment({ orderId, requestId: 'authorize-1' });
  await entered.promise;
  try {
    const pending = await setup({ payments }).authorizePayment({ orderId, requestId: 'authorize-1' });
    assert.equal(pending.state, 'payment_authorizing');
    assert.equal((await db.select().from(orders))[0]!.authorizationIdempotencyKey, providerKey);
    assert.equal((await db.select().from(orderCommands)).length, 1);
    await assert.rejects(service.authorizePayment({ orderId, requestId: 'authorize-2' }), errorCode('INVALID_TRANSITION'));
    await assert.rejects(service.cancelOrder({ orderId, requestId: 'cancel-1' }), errorCode('INVALID_TRANSITION'));
    assert.equal(calls, 1);
  } finally { response.resolve({ status: 'authorized', authorizationId: 'auth_one' }); }
  assert.equal((await first).state, 'payment_authorized');
  const replay = await setup({ payments }).authorizePayment({ orderId, requestId: 'authorize-1' });
  assert.equal(replay.state, 'payment_authorized');
  assert.equal(calls, 1);
});

test('same idempotency key cannot name different operations, but is scoped per order', async () => {
  const service = setup();
  const orderId = await authorized(service);
  await assert.rejects(service.completeOrder({ orderId, requestId: 'authorize-1' }), errorCode('IDEMPOTENCY_CONFLICT'));
  const second = (await service.create({ requestId: 'create-2' })).order.id;
  assert.equal((await service.authorizePayment({ orderId: second, requestId: 'authorize-1' })).state, 'payment_authorized');
});

test('invalid operations and missing orders produce no history, commands or external calls', async () => {
  let calls = 0;
  const service = setup({ completion: { complete: async () => { calls++; return { status: 'completed' }; } } });
  const orderId = await initialized(service);
  await assert.rejects(service.completeOrder({ orderId, requestId: 'complete-1' }), errorCode('INVALID_TRANSITION'));
  await assert.rejects(service.cancelOrder({ orderId: randomUUID(), requestId: 'cancel-1' }), errorCode('ORDER_NOT_FOUND'));
  assert.equal(await service.get(randomUUID()), null);
  assert.equal(calls, 0);
  assert.equal((await db.select().from(orderCommands)).length, 0);
  assert.equal((await service.get(orderId))!.history.length, 1);
});

for (const authorizedFirst of [false, true]) {
  test(`explicit cancellation ${authorizedFirst ? 'voids authorized payment' : 'needs no payment call before authorization'}`, async () => {
    let voids = 0;
    const payments = createStubPaymentGateway();
    const service = setup({ payments: { ...payments, voidAuthorization: async request => {
      voids++; return payments.voidAuthorization(request);
    } } });
    const orderId = await (authorizedFirst ? authorized(service) : initialized(service));
    const result = await service.cancelOrder({ orderId, requestId: 'cancel-1' });
    assert.equal(result.state, 'cancelled');
    assert.equal(voids, authorizedFirst ? 1 : 0);
    assert.ok(result.history.every(entry => entry.failure === null && entry.recoveryFailure === null));
    assert.deepEqual(await service.cancelOrder({ orderId, requestId: 'cancel-1' }), result);
    await assert.rejects(service.cancelOrder({ orderId, requestId: 'cancel-2' }), errorCode('INVALID_TRANSITION'));
    await assert.rejects(service.completeOrder({ orderId, requestId: 'complete-1' }), errorCode('INVALID_TRANSITION'));
  });
}

test('completion/cancellation race has one claimant and no duplicate side effects', async () => {
  const entered = deferred<void>();
  const response = deferred<Awaited<ReturnType<OrderCompletion['complete']>>>();
  let calls = 0;
  let voids = 0;
  const gateway = createStubPaymentGateway();
  const service = setup({
    payments: { ...gateway, voidAuthorization: async request => { voids++; return gateway.voidAuthorization(request); } },
    completion: { complete: async () => { calls++; entered.resolve(); return response.promise; } },
  });
  const orderId = await authorized(service);
  const first = service.completeOrder({ orderId, requestId: 'complete-1' });
  await entered.promise;
  try {
    assert.equal((await service.completeOrder({ orderId, requestId: 'complete-1' })).state, 'completing');
    await assert.rejects(service.cancelOrder({ orderId, requestId: 'cancel-1' }), errorCode('INVALID_TRANSITION'));
    await assert.rejects(service.completeOrder({ orderId, requestId: 'complete-2' }), errorCode('INVALID_TRANSITION'));
  } finally { response.resolve({ status: 'completed' }); }
  assert.equal((await first).state, 'complete');
  assert.equal(calls, 1); assert.equal(voids, 0);
});

for (const throws of [false, true]) {
  test(`unconfirmed authorization ${throws ? 'exception' : 'result'} requires attention with sanitized history`, async () => {
    let calls = 0;
    const service = setup({ payments: { ...createStubPaymentGateway(), authorize: async () => {
      calls++;
      if (throws) throw new Error('private-provider-password');
      return { status: 'error', failure: { code: 'secret-code', message: 'private-provider-password' } };
    } } });
    const orderId = await initialized(service);
    const result = await service.authorizePayment({ orderId, requestId: 'authorize-1' });
    assert.equal(result.state, 'needs_attention');
    assert.equal(result.history.at(-1)?.event, 'payment_authorization_unconfirmed');
    assert.equal(JSON.stringify(result).includes('private-provider'), false);
    await service.authorizePayment({ orderId, requestId: 'authorize-1' });
    assert.equal(calls, 1);
  });
  test(`unconfirmed completion ${throws ? 'exception' : 'result'} never triggers a void`, async () => {
    let voids = 0;
    const gateway = createStubPaymentGateway();
    const service = setup({
      payments: { ...gateway, voidAuthorization: async request => { voids++; return gateway.voidAuthorization(request); } },
      completion: { complete: async () => { if (throws) throw new Error('private'); return { status: 'unknown' }; } },
    });
    const orderId = await authorized(service);
    const result = await service.completeOrder({ orderId, requestId: 'complete-1' });
    assert.equal(result.state, 'needs_attention');
    assert.equal(result.history.at(-1)?.failure?.code, 'COMPLETION_UNCONFIRMED');
    assert.equal(result.history.at(-1)?.recoveryFailure, null);
    const stored = (await db.select().from(orders))[0]!;
    assert.equal(stored.voidIdempotencyKey, null);
    assert.ok(stored.authorizationIdempotencyKey);
    assert.deepEqual(await service.completeOrder({ orderId, requestId: 'complete-1' }), result);
    await assert.rejects(service.cancelOrder({ orderId, requestId: 'cancel-1' }), errorCode('INVALID_TRANSITION'));
    assert.equal(voids, 0);
  });
}

test('slow void persists completion failure first; retries and competing commands cannot void again', async () => {
  const entered = deferred<void>();
  const response = deferred<Awaited<ReturnType<PaymentGateway['voidAuthorization']>>>();
  let voids = 0;
  const service = setup({ completion: createStubOrderCompletion('failed'), payments: {
    ...createStubPaymentGateway(), voidAuthorization: async () => { voids++; entered.resolve(); return response.promise; },
  } });
  const orderId = await authorized(service);
  const first = service.completeOrder({ orderId, requestId: 'complete-1' });
  await entered.promise;
  try {
    const replay = await service.completeOrder({ orderId, requestId: 'complete-1' });
    assert.equal(replay.state, 'payment_voiding');
    assert.equal(replay.history.at(-1)?.failure?.code, 'COMPLETION_FAILED');
    await assert.rejects(service.cancelOrder({ orderId, requestId: 'cancel-1' }), errorCode('INVALID_TRANSITION'));
    assert.equal(voids, 1);
  } finally { response.resolve({ status: 'voided' }); }
  assert.equal((await first).state, 'cancelled');
});

test('void exception on explicit cancel surfaces needs_attention without a fictional completion failure', async () => {
  const service = setup({ payments: { ...createStubPaymentGateway(), voidAuthorization: async () => { throw new Error('private'); } } });
  const orderId = await authorized(service);
  const result = await service.cancelOrder({ orderId, requestId: 'cancel-1' });
  assert.equal(result.state, 'needs_attention');
  assert.equal(result.history.at(-1)?.failure, null);
  assert.equal(result.history.at(-1)?.recoveryFailure?.code, 'PAYMENT_VOID_UNCONFIRMED');
});

test('a failed claim rolls back command/state/history before any gateway call', async () => {
  let calls = 0;
  const service = setup({ payments: { ...createStubPaymentGateway(), authorize: async () => {
    calls++; return { status: 'authorized', authorizationId: 'auth_one' };
  } } });
  const orderId = await initialized(service);
  await db.update(orders).set({ version: 2147483647 }).where(eq(orders.id, orderId));
  await assert.rejects(service.authorizePayment({ orderId, requestId: 'authorize-1' }));
  assert.equal(calls, 0);
  assert.equal((await db.select().from(orderCommands)).length, 0);
  assert.equal((await db.select().from(orderTransitions)).length, 1);
  assert.equal((await service.get(orderId))!.state, 'initialized');
});

test('outcome persistence failure does not reinterpret authorization success or repeat payment on retry', async () => {
  let calls = 0;
  let transactions = 0;
  const failingStore: OrderStore = { ...store, transaction: (id, work) => {
    if (++transactions === 2) return Promise.reject(new Error('Simulated outcome write failure'));
    return store.transaction(id, work);
  } };
  const service = setup({ store: failingStore, payments: { ...createStubPaymentGateway(), authorize: async () => {
    calls++; return { status: 'authorized', authorizationId: 'auth_one' };
  } } });
  const orderId = await initialized(service);
  await assert.rejects(service.authorizePayment({ orderId, requestId: 'authorize-1' }), /outcome write failure/);
  const replay = await setup().authorizePayment({ orderId, requestId: 'authorize-1' });
  assert.equal(replay.state, 'payment_authorizing');
  assert.equal(calls, 1);
  assert.equal(replay.history.length, 2);
});

test('HTTP routes drive the real service and database through the full happy path', async () => {
  const app = createOrderApi(setup());
  const post = (key: string) => ({ method: 'POST', headers: {
    'Content-Type': 'application/json', 'Idempotency-Key': key,
  }, body: '{}' });
  const created = await app.request('/orders', post('create-1'));
  assert.equal(created.status, 201);
  const orderId = (await created.json()).order.id;
  const authorize = await app.request(`/orders/${orderId}/authorize-payment`, post('authorize-1'));
  assert.equal(authorize.status, 200);
  const complete = await app.request(`/orders/${orderId}/complete`, post('complete-1'));
  assert.equal(complete.status, 200);
  const result = await complete.json();
  assert.equal(result.order.state, 'complete');
  assert.equal(result.order.history.length, 5);
  assert.equal(JSON.stringify(result).includes('stub_auth_'), false);
  assert.deepEqual(await (await app.request(`/orders/${orderId}`)).json(), result);
});

test('stale external outcomes cannot overwrite a newer persisted version', async () => {
  const entered = deferred<void>();
  const response = deferred<Awaited<ReturnType<PaymentGateway['authorize']>>>();
  const service = setup({ payments: { ...createStubPaymentGateway(), authorize: async () => {
    entered.resolve(); return response.promise;
  } } });
  const orderId = await initialized(service);
  const first = service.authorizePayment({ orderId, requestId: 'authorize-1' });
  await entered.promise;
  // Simulate a separate reconciler recording new information while the original call is outstanding.
  await store.transaction(orderId, transaction => transaction.transition({
    state: 'payment_authorizing', event: 'payment_authorization_unconfirmed',
    failure: { code: 'RECONCILING', message: 'Reconciliation in progress.' },
  }));
  response.resolve({ status: 'authorized', authorizationId: 'stale_reference' });
  await assert.rejects(first, errorCode('OPERATION_CONFLICT'));
  const current = (await service.get(orderId))!;
  assert.equal(current.state, 'payment_authorizing');
  assert.equal(current.version, 2);
  assert.equal(current.history.at(-1)?.failure?.code, 'RECONCILING');
  assert.equal((await db.select().from(orders))[0]!.paymentAuthorizationId, null);
});

test('history-write failure rolls back the claimed state, payment key and command', async () => {
  let calls = 0;
  const service = setup({ payments: { ...createStubPaymentGateway(), authorize: async () => {
    calls++; return { status: 'authorized', authorizationId: 'auth_one' };
  } } });
  const orderId = await initialized(service);
  await client.exec("ALTER TABLE order_transitions ADD CONSTRAINT test_reject_claim_history CHECK (event <> 'payment_authorization_started')");
  try {
    await assert.rejects(service.authorizePayment({ orderId, requestId: 'authorize-1' }));
    const result = (await service.get(orderId))!;
    assert.equal(result.state, 'initialized');
    assert.equal(result.version, 0);
    assert.equal(result.history.length, 1);
    assert.equal((await db.select().from(orders))[0]!.authorizationIdempotencyKey, null);
    assert.equal((await db.select().from(orderCommands)).length, 0);
    assert.equal(calls, 0);
  } finally {
    await client.exec('ALTER TABLE order_transitions DROP CONSTRAINT test_reject_claim_history');
  }
});


test('invalid transitions identify the requested operation/outcome and current state through HTTP', async () => {
  const service = setup();
  const orderId = await initialized(service);
  const app = createOrderApi(service);
  for (const [operation, path, currentState, desiredState] of [
    ['completeOrder', 'complete', 'initialized', 'complete'],
    ['authorizePayment', 'authorize-payment', 'cancelled', 'payment_authorized'],
    ['cancelOrder', 'cancel', 'cancelled', 'cancelled'],
  ] as const) {
    if (currentState === 'cancelled' && (await service.get(orderId))!.state === 'initialized') {
      await service.cancelOrder({ orderId, requestId: 'cancel-1' });
    }
    await assert.rejects(service[operation]({ orderId, requestId: 'invalid' }), error => {
      assert.ok(error instanceof InvalidTransitionError);
      assert.equal(error.operation, operation);
      assert.equal(error.currentState, currentState);
      assert.equal(error.desiredState, desiredState);
      return true;
    });
    const response = await app.request(`/orders/${orderId}/${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'invalid' }, body: '{}',
    });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: {
      code: 'INVALID_TRANSITION', operation, currentState, desiredState,
      message: `Cannot ${operation} from ${currentState}; requested outcome is ${desiredState}.`,
    } });
  }
});
