# Order service

`createOrderService` implements the `OrderService` interface with injected `OrderStore`, `PaymentGateway`, and `OrderCompletion` dependencies. `createOrderTransitionService` centralizes lifecycle transition construction: start transitions, authorization/completion/void outcome mapping, sanitized failures, payment idempotency keys, claim/replay handling, and outcome version checks. Its typed outcome methods keep raw transition objects out of the order service, which coordinates external calls and follows the returned recovery action. Void outcomes retain the failure already persisted in the void-start history. HTTP handlers remain transport-only. The configured application uses PostgreSQL through Drizzle and explicitly simulated payment/completion adapters.

## Operations

| Operation | Allowed starting state | Processing and outcome |
| --- | --- | --- |
| Create | None | Atomically insert an initialized order and its initial history |
| Authorize payment | initialized | Claim payment_authorizing; payment_authorized on confirmation, rejected on decline, needs_attention on uncertainty |
| Complete order | payment_authorized | Claim completing; complete on success, void on confirmed failure, needs_attention on uncertainty |
| Cancel order | initialized | Record order_cancelled and become cancelled without payment calls |
| Cancel order | payment_authorized | Claim payment_voiding; cancelled on confirmed void, needs_attention otherwise |

A confirmed completion failure claims payment_voiding and records the completion failure before calling the payment gateway. A successful void produces cancelled; an error or thrown exception produces needs_attention, retaining both completion and void failure details. An explicit cancellation has no completion failure to record.

Unconfirmed authorization (including a thrown gateway exception) moves to needs_attention with a payment_authorization_unconfirmed history entry. Unconfirmed completion likewise moves to needs_attention with a completion_unconfirmed entry; it must not trigger a void. The original authorization idempotency key is preserved. No void key is required when no void was attempted. These transitions increment the version so history and current state stay consistent. The service writes fixed, sanitized failure codes/messages rather than persisting arbitrary adapter errors.

Fresh commands in pending or terminal states are rejected. Exact accepted-command replays are resolved first and return the **current** consistent order snapshot, which may include later operations. They do not return a frozen copy of the first HTTP response and never resume work or repeat an external call.

## Transaction boundaries and concurrency

1. Lock the order row with `SELECT ... FOR UPDATE` in a short transaction.
2. Look up the client command. If it was accepted earlier, return the current order; a different operation under that key conflicts.
3. Validate the current state, record the command, and update state/version plus history atomically. Persist authorization/void keys at this point.
4. Commit, then call the external dependency with the stored key. Completion uses `complete:<order-id>`: one logical completion per order.
5. Lock again and verify the original claim state/version before recording the outcome and its history atomically.

Concurrent commands serialize only during database work. A slow gateway does not hold a transaction open. Once an operation is claimed, a competing fresh command sees the pending state and cannot make another call. Conditional updates and outcome version checks protect against stale writes. A failed transaction rolls back its command, state and history changes together.

Reads hold a shared order-row lock while reading history to return a consistent snapshot. Creation uses a unique creation request ID and `INSERT ... ON CONFLICT DO NOTHING`; retries select the existing order. Creation keys are global. Other accepted command keys share a per-order namespace across authorization, completion and cancellation. Rejected commands are not recorded. Provider keys, client command keys and transition IDs remain separate.

## Persistence

The greenfield initial migration contains three tables:

- `orders`: current state/version, unique creation request ID, persisted payment reference/keys and timestamps.
- `order_transitions`: ordered, timestamped history and sanitized failure details.
- `order_commands`: accepted per-order command identities and operation names, unique by order ID and request ID.

`creation_request_id` is nullable for storage-level fixtures; service-created orders always supply it. The service owns the state graph and history writes. Database checks protect basic shapes and keys; direct SQL access can bypass the application graph. There are no upgrade migrations or automatic startup migrations.

## Crash and uncertainty boundaries

If a process stops after a claim, or an external operation succeeds but its outcome cannot be persisted, the durable order remains pending. A retry returns that pending snapshot without starting another attempt. This favors avoiding duplicate side effects over automatic progress.

There is no recovery worker, provider reconciliation endpoint, lease expiry, or manual-resolution API in this prototype. Pending orders and needs_attention outcomes require a future reconciliation path using the original keys. The schema preserves keys and failure context for that work. No background execution is implied by HTTP 202. External adapters must honor idempotency and validate provider responses.

## Operational visibility and transition typing

`needs_attention` records an outcome that needs investigation; it does not notify an operator. The existing GET endpoint exposes sanitized history for a known order ID. There is no API to list attention cases or overdue pending operations, no alerting, and no supported resolution command. The `(state, updated_at)` index supports future discovery of these orders, but no monitoring process currently uses it.

An operational interface should allow authorized staff to find cases, inspect history, reconcile provider outcomes, and record an audited resolution without direct database access. Resolution must preserve operation keys and check current state/version so it cannot race an outstanding result or repeat a side effect.

The current types constrain state and event names, while the transition service checks their valid relationships at runtime. A future refinement could encode allowed state/event/outcome combinations as discriminated unions or a typed transition table. That would catch more construction errors during development; database reads and external responses would still require runtime validation.

## Verification

`tests/order-service.test.ts` exercises the real Drizzle adapter against ephemeral PGlite: all four requested outcomes, explicit cancellation, slow dependency interleavings, replay across service instances, cross-operation key conflicts, sanitized uncertainty, transaction rollback, outcome-write failure, and a full HTTP-to-database flow.

PGlite serializes transactions in one embedded database. The tests demonstrate claim behavior and prevent calls while an operation is pending; they do not replace multi-session PostgreSQL stress tests. Local Docker PostgreSQL validation has also succeeded: the initial migration applied, all three tables were found, and an HTTP order lookup exercised the `pg` adapter and returned the expected missing-order response. This smoke check does not cover the full lifecycle or competing PostgreSQL sessions; those network-backed integration and concurrency tests remain outstanding.

## Next improvements

These follow-ups reflect the recoverability, typing, and operational priorities in [HUMAN.md](../HUMAN.md). Durable asynchronous processing would add deployment complexity and operating cost; it is not implemented by the current request/response flow.

- A reconciliation worker with provider outcome lookup, stable keys and explicit ownership/fencing. Moving work to a queue or accepting webhooks would also require durable delivery, retries, correlation and idempotent consumers. A transactional outbox could close the gap between committing a claim and publishing its work; asynchronous execution alone does not close that gap.
- Stronger types for valid transition combinations, while retaining runtime state checks.
- Alerts for attention outcomes and overdue pending operations, plus an authorized investigation and audited resolution interface that does not require direct SQL access.
- Real payment and ticket-completion adapters with timeouts, cancellation support and validated provider responses.
- Multi-session PostgreSQL race tests and fault injection around commit uncertainty.
- Authentication/authorization and operational metrics. Private networking alone would not supply caller identity or per-order access control.
- Vercel pool lifecycle integration and deployment configuration when preparing a hosted deployment.
