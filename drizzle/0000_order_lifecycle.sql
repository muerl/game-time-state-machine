CREATE TABLE "order_transitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"request_id" text NOT NULL,
	"from_state" text,
	"to_state" text NOT NULL,
	"event" text NOT NULL,
	"version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"failure" jsonb,
	"recovery_failure" jsonb,
	CONSTRAINT "order_transitions_request_nonempty" CHECK ("order_transitions"."request_id" ~ '[^[:space:]]'),
	CONSTRAINT "order_transitions_from_state_valid" CHECK ("order_transitions"."from_state" is null or "order_transitions"."from_state" in ('initialized', 'payment_authorizing', 'payment_authorized', 'completing', 'payment_voiding', 'complete', 'rejected', 'cancelled', 'needs_attention')),
	CONSTRAINT "order_transitions_to_state_valid" CHECK ("order_transitions"."to_state" in ('initialized', 'payment_authorizing', 'payment_authorized', 'completing', 'payment_voiding', 'complete', 'rejected', 'cancelled', 'needs_attention')),
	CONSTRAINT "order_transitions_event_valid" CHECK ("order_transitions"."event" in ('order_initialized', 'payment_authorization_started', 'payment_authorized', 'payment_declined', 'completion_started', 'payment_void_started', 'order_completed', 'payment_voided', 'payment_void_failed', 'order_cancelled')),
	CONSTRAINT "order_transitions_initialization_shape" CHECK ((
    ("order_transitions"."version" = 0 and "order_transitions"."from_state" is null
      and "order_transitions"."to_state" = 'initialized' and "order_transitions"."event" = 'order_initialized')
    or ("order_transitions"."version" > 0 and "order_transitions"."from_state" is not null
      and "order_transitions"."to_state" <> 'initialized' and "order_transitions"."event" <> 'order_initialized')
  )),
	CONSTRAINT "order_transitions_failure_object" CHECK ("order_transitions"."failure" is null or jsonb_typeof("order_transitions"."failure") = 'object'),
	CONSTRAINT "order_transitions_recovery_failure_object" CHECK ("order_transitions"."recovery_failure" is null or jsonb_typeof("order_transitions"."recovery_failure") = 'object')
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"state" text DEFAULT 'initialized' NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"payment_authorization_id" text,
	"authorization_idempotency_key" text,
	"void_idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_state_valid" CHECK ("orders"."state" in ('initialized', 'payment_authorizing', 'payment_authorized', 'completing', 'payment_voiding', 'complete', 'rejected', 'cancelled', 'needs_attention')),
	CONSTRAINT "orders_version_nonnegative" CHECK ("orders"."version" >= 0),
	CONSTRAINT "orders_authorization_key_nonblank" CHECK ("orders"."authorization_idempotency_key" is null or "orders"."authorization_idempotency_key" ~ '[^[:space:]]'),
	CONSTRAINT "orders_void_key_nonblank" CHECK ("orders"."void_idempotency_key" is null or "orders"."void_idempotency_key" ~ '[^[:space:]]'),
	CONSTRAINT "orders_authorization_key_required" CHECK ("orders"."state" in ('initialized', 'cancelled') or "orders"."authorization_idempotency_key" is not null),
	CONSTRAINT "orders_void_key_required" CHECK ("orders"."state" not in ('payment_voiding', 'needs_attention') or "orders"."void_idempotency_key" is not null),
	CONSTRAINT "orders_cancelled_payment_shape" CHECK ("orders"."state" <> 'cancelled' or (
    ("orders"."authorization_idempotency_key" is null and "orders"."void_idempotency_key" is null and "orders"."payment_authorization_id" is null)
    or ("orders"."authorization_idempotency_key" is not null and "orders"."void_idempotency_key" is not null and "orders"."payment_authorization_id" is not null)
  )),
	CONSTRAINT "orders_operation_keys_distinct" CHECK ("orders"."authorization_idempotency_key" is null or "orders"."void_idempotency_key" is null or "orders"."authorization_idempotency_key" <> "orders"."void_idempotency_key")
);
--> statement-breakpoint
ALTER TABLE "order_transitions" ADD CONSTRAINT "order_transitions_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "order_transitions_request_unique" ON "order_transitions" USING btree ("order_id","request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "order_transitions_version_unique" ON "order_transitions" USING btree ("order_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_authorization_key_unique" ON "orders" USING btree ("authorization_idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_void_key_unique" ON "orders" USING btree ("void_idempotency_key");--> statement-breakpoint
CREATE INDEX "orders_state_updated_at_idx" ON "orders" USING btree ("state","updated_at");