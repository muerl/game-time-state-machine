import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AuthorizePaymentRequest, PaymentGateway, VoidPaymentRequest } from '../src/payments/payment-gateway.js';
import { createStubPaymentGateway } from '../src/payments/stub-payment-gateway.js';
import type { StubPaymentOptions } from '../src/payments/stub-payment-gateway.js';

const authorization: AuthorizePaymentRequest = { orderId: 'order-1', idempotencyKey: 'authorize-1' };
const voidRequest: VoidPaymentRequest = {
  orderId: 'order-1', authorizationId: 'stub-reference', idempotencyKey: 'void-1',
};

test('gateway authorizes, returns a usable reference, and voids', async () => {
  const gateway: PaymentGateway = createStubPaymentGateway();
  const result = await gateway.authorize(authorization);
  assert.equal(result.status, 'authorized');
  if (result.status !== 'authorized') assert.fail('Expected authorization');
  assert.match(result.authorizationId, /^stub_auth_[a-f0-9]{64}$/);
  assert.deepEqual(await gateway.voidAuthorization({ ...voidRequest, authorizationId: result.authorizationId }),
    { status: 'voided' });
});

test('authorization retries are deterministic and scoped to order and key', async () => {
  const gateway = createStubPaymentGateway();
  const result = await gateway.authorize(authorization);
  assert.deepEqual(await gateway.authorize(authorization), result);
  assert.deepEqual(await createStubPaymentGateway().authorize(authorization), result);
  assert.notDeepEqual(await gateway.authorize({ ...authorization, orderId: 'order-2' }), result);
  assert.notDeepEqual(await gateway.authorize({ ...authorization, idempotencyKey: 'authorize-2' }), result);
});

test('a decline and an unconfirmed authorization have distinct results', async () => {
  assert.deepEqual(await createStubPaymentGateway({ authorization: 'declined' }).authorize(authorization), {
    status: 'declined', failure: { code: 'PAYMENT_DECLINED', message: 'Payment authorization was declined.' },
  });
  assert.deepEqual(await createStubPaymentGateway({ authorization: 'error' }).authorize(authorization), {
    status: 'error', failure: { code: 'AUTHORIZATION_UNCONFIRMED', message: 'Payment authorization could not be confirmed.' },
  });
});

test('void failure remains explicit and repeated void calls have stable outcomes', async () => {
  for (const outcome of ['voided', 'error'] as const) {
    const gateway = createStubPaymentGateway({ void: outcome });
    const result = await gateway.voidAuthorization(voidRequest);
    assert.equal(result.status, outcome);
    if (result.status === 'error') assert.equal(result.failure.code, 'PAYMENT_VOID_UNCONFIRMED');
    assert.deepEqual(await gateway.voidAuthorization(voidRequest), result);
  }
});

test('stub rejects malformed arguments instead of simulating payment success', async () => {
  const gateway = createStubPaymentGateway();
  for (const value of ['', ' \t\n', null, 42]) {
    for (const field of ['orderId', 'idempotencyKey'] as const) {
      const request = { ...authorization, [field]: value } as AuthorizePaymentRequest;
      await assert.rejects(gateway.authorize(request), { name: 'TypeError', message: `${field} must be a nonblank string.` });
    }
    for (const field of ['orderId', 'authorizationId', 'idempotencyKey'] as const) {
      const request = { ...voidRequest, [field]: value } as VoidPaymentRequest;
      await assert.rejects(gateway.voidAuthorization(request), { name: 'TypeError', message: `${field} must be a nonblank string.` });
    }
  }
  assert.throws(() => createStubPaymentGateway({ authorization: 'unknown' } as unknown as StubPaymentOptions), TypeError);
});

test('stub configuration and results do not leak mutable state between calls', async () => {
  const options: { authorization: 'declined' | 'authorized' } = { authorization: 'declined' };
  const gateway = createStubPaymentGateway(options);
  options.authorization = 'authorized';
  const result = await gateway.authorize(authorization);
  assert.equal(result.status, 'declined');
  if (result.status !== 'declined') assert.fail('Expected decline');
  Reflect.set(result.failure, 'code', 'MODIFIED');
  const next = await gateway.authorize(authorization);
  assert.equal(next.status, 'declined');
  if (next.status !== 'declined') assert.fail('Expected decline');
  assert.equal(next.failure.code, 'PAYMENT_DECLINED');
});
