import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOrderApi } from '../src/http/app.js';
import { OrderServiceError } from '../src/orders/order-service.js';
import type { OrderService } from '../src/orders/order-service.js';
import type { OrderSnapshot } from '../src/orders/order-types.js';
import defaultApp from '../src/index.js';

const id = '11111111-1111-4111-8111-111111111111';
const operations = [
  ['authorize-payment', 'authorizePayment'],
  ['complete', 'completeOrder'],
  ['cancel', 'cancelOrder'],
] as const;
const instant = new Date('2026-09-16T00:00:00.000Z');
const snapshot: OrderSnapshot = {
  id, state: 'initialized', version: 0, createdAt: instant, updatedAt: instant,
  history: [{ id: '22222222-2222-4222-8222-222222222222', fromState: null,
    toState: 'initialized', event: 'order_initialized', version: 0, createdAt: instant,
    failure: null, recoveryFailure: null }],
};
function service(overrides: Partial<OrderService> = {}): OrderService {
  return {
    create: async () => ({ order: snapshot, replayed: false }),
    get: async () => snapshot,
    authorizePayment: async () => snapshot,
    completeOrder: async () => snapshot,
    cancelOrder: async () => snapshot,
    ...overrides,
  };
}
function post(body: unknown, key = 'command-1'): RequestInit {
  return { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify(body) };
}

test('creation delegates validated command, returns 201 and Location; replays return 200', async () => {
  for (const replayed of [false, true]) {
    const app = createOrderApi(service({ create: async (command) => {
      assert.deepEqual(command, { requestId: 'create-1' });
      return { order: snapshot, replayed };
    } }));
    const response = await app.request('/orders', post({}, 'create-1'));
    assert.equal(response.status, replayed ? 200 : 201);
    assert.equal(response.headers.get('Location'), `/orders/${id}`);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    const result = await response.json();
    assert.equal(result.order.id, id);
    assert.equal(result.order.createdAt, instant.toISOString());
    assert.equal(result.order.history[0].createdAt, instant.toISOString());
  }
});

test('read returns ordered public history, without internal provider fields', async () => {
  const detail = {
    ...snapshot, state: 'needs_attention' as const, version: 2,
    authorizationIdempotencyKey: 'private-key', paymentAuthorizationId: 'private-provider-ref',
    history: [{ ...snapshot.history[0]!, id: '33333333-3333-4333-8333-333333333333', version: 2,
      fromState: 'payment_voiding' as const, toState: 'needs_attention' as const, event: 'payment_void_failed' as const,
      failure: { code: 'COMPLETION_FAILED', message: 'Completion failed.', raw: 'private-provider-body' },
      recoveryFailure: { code: 'VOID_FAILED', message: 'Void failed.' }, requestId: 'private-command-id',
    }, snapshot.history[0]!],
  };
  const app = createOrderApi(service({ get: async (orderId) => { assert.equal(orderId, id); return detail; } }));
  const response = await app.request(`/orders/${id}`);
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.equal(body.includes('private-'), false);
  const result = JSON.parse(body);
  assert.deepEqual(result.order.history.map((entry: { version: number }) => entry.version), [0, 2]);
  assert.equal(result.order.history[1].failure.code, 'COMPLETION_FAILED');
  assert.equal(result.order.history[1].recoveryFailure.code, 'VOID_FAILED');
  assert.equal(detail.history[0]?.version, 2, 'serialization must not mutate the service snapshot');
});

test('explicit operations delegate only to their corresponding service method; pending states return 202', async () => {
  for (const [path, method] of operations) {
    for (const state of ['payment_authorizing', 'completing', 'payment_voiding', 'payment_authorized', 'complete', 'rejected', 'cancelled', 'needs_attention'] as const) {
      let calls = 0;
      const app = createOrderApi(service({
        authorizePayment: async () => { throw new Error('Wrong operation'); },
        completeOrder: async () => { throw new Error('Wrong operation'); },
        cancelOrder: async () => { throw new Error('Wrong operation'); },
        [method]: async (command: Parameters<OrderService[typeof method]>[0]) => {
          calls++;
          assert.deepEqual(command, { orderId: id, requestId: 'operation-1' });
          return { ...snapshot, state, version: 3 };
        },
      }));
      const response = await app.request(`/orders/${id}/${path}`, post({}, 'operation-1'));
      assert.equal(calls, 1);
      const pending = ['payment_authorizing', 'completing', 'payment_voiding'].includes(state);
      assert.equal(response.status, pending ? 202 : 200);
      assert.equal(response.headers.get('Retry-After'), null);
      assert.equal(response.headers.get('Location'), pending ? `/orders/${id}` : null);
    }
  }
});

test('invalid write payloads are rejected without invoking the service', async () => {
  let calls = 0;
  const app = createOrderApi(service({
    create: async () => { calls++; return { order: snapshot, replayed: false }; },
    authorizePayment: async () => { calls++; return snapshot; },
    completeOrder: async () => { calls++; return snapshot; },
    cancelOrder: async () => { calls++; return snapshot; },
  }));
  for (const body of [null, [], 'text', { state: 'complete' }]) {
    assert.equal((await app.request('/orders', post(body))).status, 400);
  }
  for (const [path] of operations) {
    for (const body of [null, [], 'text', { action: 'authorize' },
      { action: 'complete' }, { expectedVersion: 0 }, { expectedState: 'initialized' },
      { state: 'complete' }]) {
      assert.equal((await app.request(`/orders/${id}/${path}`, post(body))).status, 400);
    }
  }
  assert.equal(calls, 0);
});

test('invalid UUIDs and idempotency headers do not reach the service', async () => {
  let calls = 0;
  const app = createOrderApi(service({
    create: async () => { calls++; return { order: snapshot, replayed: false }; },
    get: async () => { calls++; return snapshot; },
    authorizePayment: async () => { calls++; return snapshot; },
    completeOrder: async () => { calls++; return snapshot; },
    cancelOrder: async () => { calls++; return snapshot; },
  }));
  for (const badId of ['not-a-uuid', '123', '11111111-1111-1111-1111-11111111111z']) {
    assert.equal((await app.request(`/orders/${badId}`)).status, 400);
    for (const [path] of operations) {
      assert.equal((await app.request(`/orders/${badId}/${path}`, post({}))).status, 400);
    }
  }
  for (const key of ['', 'white space', 'x'.repeat(129)]) {
    assert.equal((await app.request('/orders', post({}, key))).status, 400);
    for (const [path] of operations) {
      assert.equal((await app.request(`/orders/${id}/${path}`, post({}, key))).status, 400);
    }
  }
  assert.equal((await app.request('/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 400);
  assert.equal(calls, 0);
});

test('malformed JSON, media type and body size have consistent errors', async () => {
  const app = createOrderApi(service());
  for (const [body, type, status] of [
    ['{', 'application/json', 400], ['', 'application/json', 400],
    ['{}', 'text/plain', 415], [JSON.stringify({ extra: 'x'.repeat(17000) }), 'application/json', 413],
  ] as const) {
    const response = await app.request('/orders', { method: 'POST',
      headers: { 'Content-Type': type, 'Idempotency-Key': 'test' }, body });
    assert.equal(response.status, status);
    assert.equal(typeof (await response.json()).error.code, 'string');
  }
});

test('missing orders and application errors map to stable HTTP codes', async () => {
  assert.equal((await createOrderApi(service({ get: async () => null })).request(`/orders/${id}`)).status, 404);
  for (const [code, status] of [
    ['ORDER_NOT_FOUND', 404], ['OPERATION_CONFLICT', 409], ['INVALID_TRANSITION', 409],
    ['IDEMPOTENCY_CONFLICT', 409], ['SERVICE_UNAVAILABLE', 503],
  ] as const) {
    for (const [path, method] of operations) {
      const app = createOrderApi(service({ [method]: async () => { throw new OrderServiceError(code); } }));
      const response = await app.request(`/orders/${id}/${path}`, post({}));
      assert.equal(response.status, status);
      assert.equal((await response.json()).error.code, code);
    }
  }
});

test('unexpected failures do not expose internal error messages', async () => {
  const app = createOrderApi(service({ get: async () => { throw new Error('postgres://secret-password@host'); } }));
  const response = await app.request(`/orders/${id}`);
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' } });
});

test('health, unknown routes and unsupported methods return JSON', async () => {
  const app = createOrderApi(service());
  assert.deepEqual(await (await app.request('/health')).json(), { status: 'ok' });
  assert.equal((await app.request('/unknown')).status, 404);
  assert.equal((await app.request(`/orders/${id}/advance`, post({ action: 'authorize', expectedVersion: 0 }))).status, 404);
  for (const [path] of operations) {
    const response = await app.request(`/orders/${id}/${path}`);
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('Allow'), 'POST');
  }
  const response = await app.request(`/orders/${id}`, { method: 'DELETE' });
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('Allow'), 'GET, HEAD');
  assert.equal((await app.request(`/orders/${id}`, { method: 'HEAD' })).status, 200);
});

test('default app is importable without database credentials and explicitly unwired', async () => {
  assert.equal((await defaultApp.request('/health')).status, 200);
  for (const response of [
    await defaultApp.request('/orders', post({})),
    await defaultApp.request(`/orders/${id}`),
    await defaultApp.request(`/orders/${id}/authorize-payment`, post({})),
    await defaultApp.request(`/orders/${id}/complete`, post({})),
    await defaultApp.request(`/orders/${id}/cancel`, post({})),
  ]) {
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, 'SERVICE_UNAVAILABLE');
  }
});

test('UUID schema normalizes uppercase IDs while preserving version-agnostic input support', async () => {
  const uppercaseId = 'ABCDEFAB-1234-0000-0000-123456789ABC';
  const app = createOrderApi(service({ get: async (orderId) => {
    assert.equal(orderId, uppercaseId.toLowerCase());
    return { ...snapshot, id: orderId };
  } }));
  const response = await app.request(`/orders/${uppercaseId}`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).order.id, uppercaseId.toLowerCase());
});

test('date serialization failure is a sanitized server error, not a client validation error', async () => {
  const app = createOrderApi(service({ get: async () => ({ ...snapshot, updatedAt: new Date('invalid') }) }));
  const response = await app.request(`/orders/${id}`);
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), {
    error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' },
  });
});
