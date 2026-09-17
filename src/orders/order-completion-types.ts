export type CompletionRequest = Readonly<{ orderId: string; idempotencyKey: string }>;
export type CompletionResult =
  | Readonly<{ status: 'completed' }>
  | Readonly<{ status: 'failed' }>
  | Readonly<{ status: 'unknown' }>;

