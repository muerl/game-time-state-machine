# Order REST API

This phase implements HTTP routes and an injectable `OrderService` interface only. State-machine execution, persistence, payment calls, durable command deduplication, and recovery are not wired in. The default application returns `503 SERVICE_UNAVAILABLE` for valid order requests; `/health` returns `200`. Tests inject test-only service implementations.

## Run locally

```sh
npm run dev
# Or compile and run:
npm run build
npm start
```

The server listens on `http://127.0.0.1:3000`. Set `PORT` and optionally `HOST` to change it. No database credentials are needed for this HTTP-only slice. `/health` is a liveness check, not a database/service readiness check. Authentication is not implemented in this prototype.

## Routes

| Method | Path | Input | Successful response |
| --- | --- | --- | --- |
| GET | `/health` | None | `200 { "status": "ok" }` |
| POST | `/orders` | Empty JSON object, `Idempotency-Key` header | `201` new order; `200` on service-reported replay |
| GET | `/orders/:id` | Order UUID | `200` current state and history |
| POST | `/orders/:id/authorize-payment` | Empty JSON object; `Idempotency-Key` header | `200` settled outcome; `202` pending state |
| POST | `/orders/:id/complete` | Empty JSON object; `Idempotency-Key` header | `200` settled outcome; `202` pending state |
| POST | `/orders/:id/cancel` | Empty JSON object; `Idempotency-Key` header | `200` settled outcome; `202` pending state |

Writes require `Content-Type: application/json` and at most 16 KiB. Additional fields are rejected; clients cannot directly assign state, provider references, or payment keys. `Idempotency-Key` is 1–128 characters using letters, digits, `.`, `_`, `:`, or `-`.

`authorize-payment` calls `OrderService.authorizePayment` for an initialized order; `complete` calls `OrderService.completeOrder` for an authorized order. `cancel` calls `OrderService.cancelOrder`: initialized orders cancel immediately; authorized orders must void their authorization before becoming cancelled. Fresh cancellation commands on pending or terminal states are rejected. The endpoint identifies the operation; an `action` body field is rejected. Clients supply no expected state or version; those fields are rejected. The service owns state validation, atomic claims, and recovery. `complete` means attempting completion and performing stage-appropriate recovery if needed; there is no public void endpoint.

```sh
curl -i http://127.0.0.1:3000/health

curl -i -X POST http://127.0.0.1:3000/orders \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: create-order-1' \
  -d '{}'

curl -i -X POST http://127.0.0.1:3000/orders/11111111-1111-4111-8111-111111111111/authorize-payment \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: authorize-order-1' \
  -d '{}'

curl -i -X POST http://127.0.0.1:3000/orders/11111111-1111-4111-8111-111111111111/complete \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: complete-order-1' \
  -d '{}'

# Alternatively, cancel instead of completing:
curl -i -X POST http://127.0.0.1:3000/orders/11111111-1111-4111-8111-111111111111/cancel \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: cancel-order-1' \
  -d '{}'

curl -i http://127.0.0.1:3000/orders/11111111-1111-4111-8111-111111111111
```

Order examples currently return `503` until a service implementation is injected.

## Responses

Order routes return `{ "order": ... }`. The order contains `id`, `state`, `version`, ISO-8601 UTC `createdAt`/`updatedAt`, and `history` sorted by version. Each entry exposes `id`, `fromState`, `toState`, `event`, `version`, `createdAt`, `failure`, and `recoveryFailure`. Failure objects contain only `code` and `message`; the service must sanitize those values.

Provider references, operation keys, history request IDs, and extra service fields are excluded by explicit projection. All responses use `Cache-Control: no-store`.

Creation includes `Location: /orders/:id`. Authorization, completion, and cancellation responses for `payment_authorizing`, `completing`, or `payment_voiding` use `202` with `Location`. No polling interval is prescribed. Poll using GET; polling does not initiate or resume work. A pending snapshot may require reconciliation and does not promise a background worker is running.

Settled outcomes, including `rejected`, `cancelled`, and `needs_attention`, use `200` with the actual state and failure history. HTTP success means the command outcome was returned, not that checkout succeeded. Clients must inspect state.

Errors use `{ "error": { "code": "...", "message": "..." } }`:

| Status | Meaning |
| --- | --- |
| 400 | Invalid UUID, idempotency header, JSON, or command body |
| 404 | Unknown route or missing order |
| 405 | Unsupported method on a known route; includes `Allow` |
| 409 | Concurrent operation conflict, invalid transition, or conflicting key reuse |
| 413 | Body exceeds 16 KiB |
| 415 | Unsupported content type |
| 503 | Order service unavailable or not wired in |
| 500 | Unexpected failure; internal details excluded |

## Service wiring and next phase

Implement the `OrderService` interface from `src/orders/order-service.ts` and pass it to `createOrderApi(service)` in `src/http/app.ts`. Replace the explicit unavailable service in `src/index.ts` when orchestration is ready. HTTP handlers do not access database/payment adapters directly.

The HTTP layer forwards `Idempotency-Key` as `requestId`; it does not deduplicate. The service must durably deduplicate creation commands globally and authorization/completion/cancellation commands in a shared per-order namespace, reject a different operation or changed payload under an existing key, and resolve exact replays before checking whether the operation is allowed. Client command IDs are separate from provider keys and individual history entry IDs. Clients retry the same endpoint using the same key and identical body. Reusing an authorization command key for completion or cancellation must produce `IDEMPOTENCY_CONFLICT`; use a new command key for each distinct operation.

The service must return consistent state/history snapshots, read state/version internally and perform conditional claims before external calls, and map expected errors to `OrderServiceError`. Those are future implementation requirements, not behavior already implemented here.

The Hono default export in `src/index.ts` follows [Vercel's native Hono convention](https://vercel.com/docs/frameworks/backend/hono). The local Node adapter runs separately in `src/dev-server.ts`. No deployment or hosted resources were created.

## HTTP code structure

- `src/http/app.ts` registers routes and delegates typed commands to the service. Hono variables use the full name `context`.
- `src/http/models.ts` defines strict Zod request schemas with inferred input types and separate, ordinary TypeScript response DTOs. The named order ID schema uses Zod GUID validation to preserve version-agnostic UUID acceptance and normalize case.
- `src/http/requests.ts` handles HTTP input extraction and schema parsing; `src/http/errors.ts` maps request/service errors without exposing input values or provider details.
- `src/http/order-mapper.ts` explicitly maps typed service snapshots into public DTOs, converts dates to ISO strings, sorts a copied history array, and selects only public fields (including failure details). It does not use Zod or runtime response schemas. Mapping exceptions are server errors; response shape correctness is checked by TypeScript.
- `src/http/routes.ts` owns typed route metadata. An exhaustive pending-state classification lives in `src/domain/order.ts`; HTTP handlers do not duplicate those lists.

The generic `advance` endpoint has been removed. All three explicit operations share validated command fields (`orderId`, `requestId`) but have separate service methods. No public void operation is exposed; voiding belongs to completion recovery or explicit cancellation.
