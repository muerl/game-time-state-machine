import type { OrderCompletion } from './order-completion.js';
import type { CompletionResult } from './order-completion-types.js';

/** Prototype simulation; does not deliver tickets or call an external system. */
export function createStubOrderCompletion(status: CompletionResult['status'] = 'completed'): OrderCompletion {
  return { complete: async () => ({ status }) };
}
