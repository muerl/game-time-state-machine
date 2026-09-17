import type {
  AuthorizePaymentCommand, CancelOrderCommand, CompleteOrderCommand,
  CreateOrderCommand, CreateOrderResult, OrderServiceErrorCode, OrderSnapshot,
} from './order-types.js';

export class OrderServiceError extends Error {
  constructor(public readonly code: OrderServiceErrorCode) {
    super(code);
    this.name = 'OrderServiceError';
  }
}

/**
 * HTTP-independent application boundary. Implemented by createOrderService.
 * The implementation must durably deduplicate request IDs (creation globally,
 * authorization/completion/cancellation in a shared per-order namespace), reject a different
 * operation or changed payload under an existing key, and
 * resolve an exact replay before checking whether the operation is allowed.
 * Read current state/version internally and use them to atomically claim the
 * operation and persist provider keys before any external call. If a concurrent
 * command wins the claim, re-read and resolve the conflict without starting a
 * duplicate external operation. Clients supply no state/version preconditions.
 * Request IDs are client command IDs, not provider keys or history-entry IDs.
 * Calls return a consistent snapshot; pending states may be returned for polling.
 */
export interface OrderService {
  create(command: CreateOrderCommand): Promise<CreateOrderResult>;
  get(orderId: string): Promise<OrderSnapshot | null>;
  /** Authorize payment for an initialized order, claiming it before calling the gateway. */
  authorizePayment(command: AuthorizePaymentCommand): Promise<OrderSnapshot>;
  /** Complete an authorized order, including void recovery on confirmed completion failure. */
  completeOrder(command: CompleteOrderCommand): Promise<OrderSnapshot>;
  /** Cancel initialized orders directly; void authorized payments first. Reject pending/terminal states. */
  cancelOrder(command: CancelOrderCommand): Promise<OrderSnapshot>;
}
