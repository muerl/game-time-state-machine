# Phase 1: Order lifecycle database model

Status: Implemented for the database-modeling phase. `npm run check` passes lint, type-checks, storage and payment tests, and the build. Drizzle reports no schema drift. No persistent or hosted database was modified; transition-service behavior and concurrent network-session validation remain deferred as specified below.

## Summary

Design the database from a clean slate using PostgreSQL, Drizzle, and TypeScript. Use two tables: `orders` for current state and `order_transitions` for timestamped history.

Deliver the schema, TypeScript types, one initial migration, database tests, and modeling documentation. No existing system or data needs migration or preservation. Any current scaffold is disposable setup, not a compatibility requirement.

## Database model

### Orders

Define:

- `id`: UUID primary key.
- `state`: constrained state, defaulting to `initialized`.
- `version`: nonnegative integer, defaulting to `0`.
- `payment_authorization_id`: nullable provider/stub reference, retained after completion or cancellation.
- `authorization_idempotency_key`: nonblank key required after initialization and preserved for retries.
- `void_idempotency_key`: nonblank key required for voiding/cancelled/needs-attention states and preserved for retries. Keys are unique per operation across orders and distinct within an order.
- `created_at` and `updated_at`: timezone-aware timestamps.

Supported states: `initialized`, `payment_authorizing`, `payment_authorized`, `completing`, `payment_voiding`, `complete`, `rejected`, `cancelled`, and `needs_attention`.

Index `(state, updated_at)` for finding orders requiring attention. Omit generic metadata, customers, tickets, pricing, and inventory from this phase.

### Order transitions

Define:

- `id`: UUID primary key.
- `order_id`: required foreign key to the order.
- `request_id`: required nonempty string identifying the operation.
- `from_state`: nullable only for initialization.
- `to_state` and `event`: constrained values.
- `version`: the resulting order version.
- `created_at`: timezone-aware timestamp.
- `failure` and `recovery_failure`: nullable JSON objects, each typed as `{ code: string; message: string }`.

The lifecycle is:

| From | To | Event |
| --- | --- | --- |
| None | `initialized` | `order_initialized` |
| `initialized` | `payment_authorizing` | `payment_authorization_started` |
| `payment_authorizing` | `payment_authorized` | `payment_authorized` |
| `payment_authorizing` | `rejected` | `payment_declined` |
| `payment_authorized` | `completing` | `completion_started` |
| `completing` | `complete` | `order_completed` |
| `completing` | `payment_voiding` | `payment_void_started` |
| `payment_voiding` | `cancelled` | `payment_voided` |
| `payment_voiding` | `needs_attention` | `payment_void_failed` |

Initialization creates history at version `0`; subsequent transitions increment the version. History is ordered by version.

A rejection records the authorization failure. Cancellation records the completion failure after a successful void. `needs_attention` records both the completion failure and the void failure. Error details must exclude credentials, raw provider responses, and stack traces.

The four outcome states have no outgoing transitions in this prototype.

## Integrity and write contract

- Use PostgreSQL checks and matching TypeScript literal unions for state/event values.
- Enforce initialization shape, valid version ranges, nonempty request IDs, and JSON-object shape in the database.
- Require unique `(order_id, request_id)` and `(order_id, version)` pairs.
- Use a restrictive foreign key to prevent deleting an order with history.
- TypeScript will enforce allowed transitions and outcome-specific failure/reference requirements. No triggers or stored transition functions.
- Document that creation inserts the order and initialization history in one transaction.
- Before external calls, atomically claim the in-progress state using expected state/version, persist the operation key, and append start history. Only the successful claimant can proceed after commit. Outcome writes use another conditional transaction.
- Record completion failure when entering `payment_voiding`. Retain operation keys on outcomes and retry with the same key after uncertain results. Timeouts never automatically reset pending states or imply decline/cancellation.
- History request IDs identify individual start/outcome transitions; provider idempotency keys identify the external operation. Keep those identities separate. No automatic recovery worker or key-immutability trigger is included.
- Treat history as append-only through the future application interface; direct SQL immutability is outside this phase.
- Defer duplicate-request response behavior, creation-request idempotency, and manual-resolution actions to the service phase.

## Implementation and validation

Create the definitive Drizzle schema and one initial migration that creates it. Replace disposable scaffold definitions as needed; add no upgrade migrations, compatibility logic, backfills, or legacy-data checks.

Test:

- Initial schema creation and migration reapplication.
- Initialization and persisted history for all four outcome paths.
- Preservation of both errors for `needs_attention`.
- Rejection of invalid state/event values, malformed initialization, invalid versions, duplicate requests/versions, and orphaned history.
- Transaction rollback leaving both current state and history unchanged.
- Required/nonblank/distinct payment keys and uniqueness across orders.
- Competing conditional claims produce one winner for authorization, completion, and void; later requests preserve the pending state/key. PGlite serializes these transactions, so real network concurrency remains unverified.

Run lint, type-check, PGlite database tests, and build. These tests validate storage behavior; transition-service enforcement and concurrent network-session testing belong to later phases.

## Deliverables and boundaries

Deliver schema definitions, exported state/event/failure types, the initial migration, passing tests, and README documentation of the lifecycle and write contract.

Keep the implementation compatible with ordinary managed Postgres. Provision no hosted resources and implement no API, payment integration, durable jobs, or recovery workers. Record implementation activity in the shared agent log.

## Reference

The project PDF, `07_—_The_Order_State_Machine_(Prompt)_(2).pdf`, guides the lifecycle and failure scenarios. Its broader service and submission requirements do not expand this database-modeling phase.
