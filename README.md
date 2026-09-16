# Gametime

TypeScript infrastructure for an order state machine proof of concept. Storage is ordinary PostgreSQL accessed through Drizzle and `pg`; Neon is the intended hosted provider, but any compatible managed Postgres can be used. A Hono REST layer and injectable order-service interface are implemented. State-machine orchestration and its storage/payment wiring are not implemented yet.

## REST API

Run `npm run dev` at `http://127.0.0.1:3000`, or use `npm run build` followed by `npm start`. Routes are `POST /orders`, `GET /orders/:id`, `POST /orders/:id/authorize-payment`, `POST /orders/:id/complete`, `POST /orders/:id/cancel`, and `GET /health`.

This is the HTTP slice only: valid order requests return `503 SERVICE_UNAVAILABLE` until the order service is wired in. HTTP tests inject test-only services. See the [REST API contract and examples](docs/rest-api.md) for validation, responses, and service responsibilities.

## Install and verify

Use Node.js 24 (`nvm use`) and npm:

```sh
npm ci
npm run check
```

`check` runs ESLint, strict TypeScript checks, HTTP route tests, payment contract/stub tests, migration/constraint/rollback tests against an ephemeral PGlite database, and compiles `src/` into `dist/`. Tests need neither Docker nor a cloud account. PGlite tests do not verify network connectivity, hosted configuration, or concurrent sessions.

Run `npm run lint` for linting alone or `npm run lint:fix` to apply automatic fixes. ESLint uses the recommended JavaScript and TypeScript rules and excludes generated output and vendored skills. TypeScript is pinned to the 6.0 minor release series supported by typescript-eslint.

## Local Postgres

Start Docker Desktop, then:

```sh
cp .env.example .env.local
npm run db:up
npm run db:migrate
npm run db:check
```

Docker binds Postgres to `127.0.0.1:5433` to avoid the usual local Postgres port. The example credentials are only for this local container. `npm run db:down` stops it while preserving the named data volume.

## Schema changes

Edit `src/db/schema.ts`, run `npm run db:generate`, review the SQL in `drizzle/`, and commit the SQL plus migration metadata. Apply reviewed migrations with `npm run db:migrate`. Generation and builds do not require database credentials. Migrations are explicit and never run on application startup or in the build script.

Use `npm run db:studio` to inspect a configured database locally.

This is a greenfield model with one initial migration, `drizzle/0000_order_lifecycle.sql`. There are no upgrade migrations, backfills, or legacy-data checks.

## Order lifecycle model

`orders` stores the current state, nonnegative version (initially `0`), nullable payment authorization reference, persisted authorization/void idempotency keys, and creation/update timestamps. Authorization references remain available after completion or cancellation. An index on `(state, updated_at)` supports finding orders requiring attention. There are no customer, ticket, pricing, inventory, or generic metadata fields.

`order_transitions` stores each recorded state change, including initialization, with its order ID, request ID, source/destination states, event, resulting version, timestamp, and optional failure details. Read history ordered by `version`, not timestamps. All timestamps use PostgreSQL `timestamptz`.

| From | To | Event |
| --- | --- | --- |
| None | `initialized` | `order_initialized` |
| `initialized` | `cancelled` | `order_cancelled` |
| `payment_authorized` | `payment_voiding` | `payment_void_started` |
| `initialized` | `payment_authorizing` | `payment_authorization_started` |
| `payment_authorizing` | `payment_authorized` | `payment_authorized` |
| `payment_authorizing` | `rejected` | `payment_declined` |
| `payment_authorized` | `completing` | `completion_started` |
| `completing` | `complete` | `order_completed` |
| `completing` | `payment_voiding` | `payment_void_started` |
| `payment_voiding` | `cancelled` | `payment_voided` |
| `payment_voiding` | `needs_attention` | `payment_void_failed` |

`complete`, `rejected`, `cancelled`, and `needs_attention` have no outgoing transitions in this prototype. The table specifies the future service contract; this phase implements storage, not transition execution.

`failure` and `recovery_failure` are nullable JSON objects with the TypeScript shape `{ code: string; message: string }`. Rejection records an authorization failure. During completion recovery, the void-start entry records the completion failure before calling the gateway, and cancellation retains it after a successful void; `needs_attention` retains the completion failure in `failure` and the void failure in `recovery_failure`. The future service must validate and sanitize external errors before storing them: no credentials, raw provider responses, or stack traces.

State/event constants and their TypeScript literal unions live in `src/domain/order.ts` and are re-exported by the schema alongside inferred select/insert types. PostgreSQL checks independently enforce those allowed values, initialization shape, valid version ranges, nonblank request IDs, and JSON-object shape. The database does not validate the fields inside failure objects or their relationship to a particular outcome; that belongs to the future service.

### Future write contract

1. Create an order and its initialization history in one transaction. The initial entry has null `from_state`, `to_state = initialized`, `event = order_initialized`, and version `0`.
2. Before calling an external operation, claim its in-progress state with a conditional update matching the order ID and the state/version read internally by the service. Clients do not supply these preconditions. Increment the version and update `updated_at`. Persist the authorization or void key in this same transaction and insert the start-event history. For `completing -> payment_voiding`, also record the completion failure at this point so a crash during voiding cannot lose it.
3. Only a caller whose update returns one row may start the operation, and only after the claim transaction commits. A zero-row result must not append history or call the gateway; re-read the order and report processing/conflict as appropriate. Existing pending states must not trigger another fresh attempt.
4. Call the provider outside the transaction, using the stored key. The authorization key is required after an authorization attempt, including rejection; the void key is required for `payment_voiding`, `needs_attention`, and cancellation after authorization. A directly cancelled initialized order has no payment reference or operation keys. A cancelled authorized order retains its authorization reference and both operation keys. Keys must be nonblank, unique per operation column across orders, and different from each other on an order. Use operation-prefixed keys (for example `authorize:<uuid>` and `void:<uuid>`) to avoid cross-operation provider namespace collisions.
5. Persist a confirmed outcome with another state/version-checked update and history insert in a short transaction. Keep the original keys; a new key is a new provider operation. Use distinct history request IDs for start and outcome entries: a history request ID identifies a recorded transition, while a payment idempotency key identifies an external operation across retries.
6. An authorization timeout remains `payment_authorizing` with the same key; do not reset it to `initialized` or mark it rejected. An unconfirmed void may remain `payment_voiding` pending reconciliation or be explicitly surfaced as `needs_attention`, retaining its key and error. Neither outcome permits cancellation without confirmed void success. A completion timeout likewise must not automatically be interpreted as confirmed failure and trigger a void.

This phase provides schema and tests of the conditional claim pattern, not a claim service or automatic recovery worker. Recovery after crashes/timeouts requires provider reconciliation or a controlled retry using the same persisted key. The schema does not enforce key immutability or worker ownership; future service code must preserve keys and control retries. PGlite serializes test transactions, so these tests are not multi-session network concurrency tests.

Unique `(order_id, request_id)` and `(order_id, version)` constraints prevent duplicate operation IDs and duplicate history versions within an order. The foreign key prevents orphaned history and restricts deleting orders with history. These constraints support idempotency but do not implement retry responses or creation-request deduplication.

Explicit cancellation is allowed from `initialized` (directly to `cancelled`, event `order_cancelled`) or `payment_authorized` (claim `payment_voiding`, then confirm the void). Pending and terminal states reject fresh cancellation commands; exact command replays are resolved first. Explicit cancellation is not a completion failure, so successful cancellation has no failure details. A confirmed void failure uses `needs_attention` with `recoveryFailure` and no fabricated completion failure; an unknown void outcome stays pending for reconciliation. These are future service responsibilities.

History is append-only through the future application interface. No triggers or stored transition functions enforce the graph, history immutability, gap-free versions, or agreement between the current row and latest history. Manual resolution and durable retries are deferred. Tests exercise transactions and constraints directly with fixtures; they do not constitute a transition service.

## External payment interface

`src/payments/payment-gateway.ts` defines the provider-neutral `PaymentGateway` interface:

- `authorize({ orderId, idempotencyKey })` returns `authorized` with an authorization reference, `declined` with sanitized failure details, or `error` when the authorization outcome cannot be confirmed.
- `voidAuthorization({ orderId, authorizationId, idempotencyKey })` returns `voided` or `error` with sanitized failure details.

The result unions require the future service to distinguish a known decline from an unconfirmed authorization. Only a decline maps to rejection; an authorization error must not be treated as proof that no authorization occurred. Recovery/reconciliation for that case belongs to a later service phase. After completion fails, only a confirmed void permits cancellation; a void error must remain visible for manual attention. Neither method performs order/database writes or captures/refunds payments.

Use one stable idempotency key per logical operation, reuse it on retries, and use a different key for authorization versus voiding. A real provider adapter must honor those keys, validate provider responses, and translate expected provider/network failures to sanitized result objects. Invalid local arguments and programming errors may reject the promise; callers must not silently swallow those exceptions.

The prototype contract carries only order correlation and authorization references. Real checkout integration will require amount, currency, and a tokenized payment-method reference as a later contract extension; this is not a production payment adapter.

`src/payments/stub-payment-gateway.ts` provides a configurable simulation:

```ts
import { createStubPaymentGateway } from './src/payments/stub-payment-gateway.js';

const payments = createStubPaymentGateway({
  authorization: 'authorized', // 'authorized' (default), 'declined', or 'error'
  void: 'error', // 'voided' (default) or 'error'
});

const result = await payments.authorize({
  orderId: 'order-1',
  idempotencyKey: 'order-1:authorize:1',
});

if (result.status === 'authorized') {
  // Invoke only if a later completion step fails.
  const recovery = await payments.voidAuthorization({
    orderId: 'order-1',
    authorizationId: result.authorizationId,
    idempotencyKey: 'order-1:void:1',
  });
  // This scenario returns recovery.status === 'error'.
}
```

Authorization references are deterministic for the same order/key, including across stub instances. Outcomes are fixed by configuration; the stub has no network calls, credentials, ledger, or persistent state. It does not verify that a void reference exists or belongs to the order, deduplicate real side effects, or simulate durable retry/reconciliation behavior. Inject the interface into the later order service rather than depending on the stub directly.

## Hosted Postgres / Neon (later)

No hosted resources are provisioned by these scripts. When ready, connect Neon through the Vercel Marketplace to the intended project, choose a region close to its functions, and pull development environment variables into `.env.local`. Use separate development/preview and production databases or branches.

Set `DATABASE_URL` to the provider's pooled connection string, retaining its SSL settings. Optionally set `DATABASE_URL_UNPOOLED` for migrations. Existing process environment variables take precedence over local files. Connection strings are server-only and ignored by Git.

The lazy `getDb()` client supports interactive transactions. Serverless lifecycle/pool integration should be added when the order service is wired into the Hono entrypoint. The current HTTP layer does not open database connections.

## Dependency audit

The initial install has no production dependency advisories. Drizzle Kit 0.31.10 pulls an older esbuild through its legacy loader, producing four moderate development-dependency reports for GHSA-67mh-4wv8-2f99. The reported automatic fix downgrades Drizzle Kit across incompatible versions, so it was not applied. Track the upstream tooling fix; do not expose development tooling publicly.
