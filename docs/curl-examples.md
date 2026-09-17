# Order API curl examples

These examples use the current REST endpoints with the default payment and completion simulations. Run the sections in order in the same shell. Each cancellation example creates its own order, so it does not try to cancel the completed order from the happy path.

## Start the API

Use Node.js 24, npm, curl, and a configured PostgreSQL database. For local PostgreSQL, start Docker Desktop first. From the project root:

```sh
npm ci
if [ ! -f .env.local ]; then cp .env.example .env.local; fi
npm run db:up
npm run db:migrate
npm run dev
```

If using an existing compatible database, set its `DATABASE_URL` in `.env.local` and skip `db:up`. Migrations are explicit; starting the API does not apply them.

These shell examples target macOS or Linux with a POSIX-compatible shell (such as bash or zsh). In a second terminal, initialize the example variables:

```sh
BASE_URL='http://127.0.0.1:3000'
RUN_ID=$(node -e 'console.log(require("node:crypto").randomUUID())')
```

`RUN_ID` gives this walkthrough fresh command keys. Keep it unchanged when retrying a request. Generate a new value to run a separate walkthrough.

Every POST below sends an empty JSON object and an `Idempotency-Key`. Do not send `state`, `expectedState`, `expectedVersion`, or `action`; the service chooses and validates transitions internally. Keys allow 1–128 letters, digits, dots, underscores, colons, or hyphens.

## 1. Check health

```sh
curl -sS -i "$BASE_URL/health"
```

Expected: `200 OK` with `{"status":"ok"}`. This is a process liveness check, not a database readiness check.

## 2. Create an order

Capture the JSON body and extract the generated ID with Node. `-D /dev/stderr` displays response headers without putting them into the captured JSON.

```sh
CREATE_JSON=$(curl -fsS -D /dev/stderr -X POST "$BASE_URL/orders" \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $RUN_ID:create" \
  -d '{}')
ORDER_ID=$(printf '%s' "$CREATE_JSON" | node -e \
  'let body=""; process.stdin.on("data", chunk => body += chunk); process.stdin.on("end", () => console.log(JSON.parse(body).order.id));')
printf 'Order: %s\n' "$ORDER_ID"
printf '%s\n' "$CREATE_JSON"
```

Expected: `201 Created`, `Location: /orders/<id>`, state `initialized`, version `0`, and one `order_initialized` history entry. Keep `ORDER_ID` for the following calls.

## 3. Read state and history

```sh
curl -sS -i "$BASE_URL/orders/$ORDER_ID"
```

Expected: `200 OK` with an `order` object containing `id`, `state`, `version`, ISO timestamps and history ordered by version. Provider references and idempotency keys are not returned.

## 4. Authorize payment

```sh
curl -sS -i -X POST "$BASE_URL/orders/$ORDER_ID/authorize-payment" \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $RUN_ID:authorize" \
  -d '{}'
```

With the default stub, expect `200 OK`, state `payment_authorized`, version `2`. History records entry into `payment_authorizing` before the authorization outcome.

## 5. Complete the order

```sh
curl -sS -i -X POST "$BASE_URL/orders/$ORDER_ID/complete" \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $RUN_ID:complete" \
  -d '{}'
```

With the default stub, expect `200 OK`, state `complete`, version `4`. The history now contains initialization, authorization start/outcome, and completion start/outcome.

## 6. Retry safely

Repeat the same operation with the same key and body:

```sh
curl -sS -i -X POST "$BASE_URL/orders/$ORDER_ID/complete" \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $RUN_ID:complete" \
  -d '{}'
```

Expected: `200 OK`, still `complete`, with no new transition or external call. Accepted-command replays return the **current** order snapshot, which can include later operations.

Creation is also idempotent:

```sh
curl -sS -i -X POST "$BASE_URL/orders" \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $RUN_ID:create" \
  -d '{}'
```

Expected: `200 OK` rather than `201`, the same order ID, and its current `complete` state. A new creation key creates another order.

## 7. Cancel before authorization

Create a separate order:

```sh
CANCEL_JSON=$(curl -fsS -X POST "$BASE_URL/orders" \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $RUN_ID:create-cancel" \
  -d '{}')
CANCEL_ID=$(printf '%s' "$CANCEL_JSON" | node -e \
  'let body=""; process.stdin.on("data", chunk => body += chunk); process.stdin.on("end", () => console.log(JSON.parse(body).order.id));')

curl -sS -i -X POST "$BASE_URL/orders/$CANCEL_ID/cancel" \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $RUN_ID:cancel-initialized" \
  -d '{}'
```

Expected: `200 OK`, state `cancelled`, version `1`. No payment call occurs; history records `order_cancelled`.

## 8. Cancel after authorization

Create and authorize another order, then cancel it:

```sh
VOID_JSON=$(curl -fsS -X POST "$BASE_URL/orders" \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $RUN_ID:create-void" \
  -d '{}')
VOID_ID=$(printf '%s' "$VOID_JSON" | node -e \
  'let body=""; process.stdin.on("data", chunk => body += chunk); process.stdin.on("end", () => console.log(JSON.parse(body).order.id));')

curl -sS -i -X POST "$BASE_URL/orders/$VOID_ID/authorize-payment" \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $RUN_ID:authorize-void" \
  -d '{}'

curl -sS -i -X POST "$BASE_URL/orders/$VOID_ID/cancel" \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $RUN_ID:cancel-authorized" \
  -d '{}'
```

With the default stub, expect `200 OK`, state `cancelled`, version `4`. The service records `payment_void_started`, calls the gateway, then records `payment_voided`. Explicit cancellation does not fabricate a completion failure.

## 9. Inspect error responses

These examples deliberately omit curl's `-f` option so HTTP error bodies remain visible.

### Invalid transition: cancel a completed order

Using `ORDER_ID` from the happy path:

```sh
curl -sS -i -X POST "$BASE_URL/orders/$ORDER_ID/cancel" \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $RUN_ID:cancel-completed" \
  -d '{}'
```

Expected: `409 Conflict`:

```json
{
  "error": {
    "code": "INVALID_TRANSITION",
    "message": "Cannot cancelOrder from complete; requested outcome is cancelled.",
    "operation": "cancelOrder",
    "currentState": "complete",
    "desiredState": "cancelled"
  }
}
```

### Reuse a key for a different operation

This deliberately uses the accepted authorization key for completion:

```sh
curl -sS -i -X POST "$BASE_URL/orders/$ORDER_ID/complete" \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $RUN_ID:authorize" \
  -d '{}'
```

Expected: `409 IDEMPOTENCY_CONFLICT`. Operation keys share a namespace within each order. Use a different key for each distinct operation, and reuse that operation's key for retries.

### Missing idempotency key

```sh
curl -sS -i -X POST "$BASE_URL/orders" \
  -H 'Content-Type: application/json' \
  -d '{}'
```

Expected: `400 INVALID_IDEMPOTENCY_KEY`.

### Unexpected body fields

```sh
curl -sS -i -X POST "$BASE_URL/orders/$ORDER_ID/complete" \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $RUN_ID:invalid-body" \
  -d '{"expectedVersion":4}'
```

Expected: `400 INVALID_BODY`. No command or transition is recorded.

### Wrong content type

```sh
curl -sS -i -X POST "$BASE_URL/orders" \
  -H 'Content-Type: text/plain' \
  -H "Idempotency-Key: $RUN_ID:wrong-type" \
  -d '{}'
```

Expected: `415 UNSUPPORTED_MEDIA_TYPE`.

### Invalid or missing order

```sh
curl -sS -i "$BASE_URL/orders/not-a-uuid"

MISSING_ID=$(node -e 'console.log(require("node:crypto").randomUUID())')
curl -sS -i "$BASE_URL/orders/$MISSING_ID"
```

Expected: `400 INVALID_ORDER_ID` for malformed IDs, and `404 ORDER_NOT_FOUND` for a valid UUID that does not exist.

### Unsupported method

```sh
curl -sS -i -X DELETE "$BASE_URL/orders/$ORDER_ID"
```

Expected: `405 METHOD_NOT_ALLOWED` and `Allow: GET, HEAD`. There is no delete endpoint.

## Pending and failure outcomes

All order responses use `{"order": ...}`. Inspect the state even when HTTP returns `200`:

| State | Meaning |
| --- | --- |
| `payment_authorized` | Authorization confirmed; completion or cancellation is allowed |
| `complete` | Completion confirmed |
| `rejected` | Payment declined |
| `cancelled` | Cancelled before authorization or after a confirmed void |
| `needs_attention` | Authorization/completion is unconfirmed, or void recovery requires attention; inspect history failures |
| `payment_authorizing`, `completing`, `payment_voiding` | An operation is pending |

An operation response with a pending state uses `202 Accepted` and `Location: /orders/<id>`. Read its current status with `GET /orders/:id`; do not create another command key to try to restart it. GET does not initiate work, and a pending state does not imply a background worker is running. No `Retry-After` interval is specified.

A `needs_attention` state does not trigger an alert. You can inspect history for a known order using the GET example above, but there is no endpoint to list attention cases or resolve them. Operational tooling for that workflow remains future work.

The default stubs complete immediately and successfully. There is **no HTTP body field or query parameter to force a decline, slow response, or failure**. Those scenarios are exercised by injected adapters in `tests/order-service.test.ts`. Missing `DATABASE_URL` produces `503 SERVICE_UNAVAILABLE`; a database connection/query failure is currently a sanitized `500 INTERNAL_ERROR`.

See [the REST contract](rest-api.md) for all status codes and [the service design](order-service.md) for transaction boundaries and reconciliation limitations.
