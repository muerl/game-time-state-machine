import type { CompletionRequest, CompletionResult } from './order-completion-types.js';

/** Expected failures are results; unknown outcomes must not trigger payment voiding. */
export interface OrderCompletion {
  complete(request: CompletionRequest): Promise<CompletionResult>;
}
