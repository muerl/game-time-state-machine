import type { FailureDetails } from '../domain/order.js';
import type { OrderHistoryEntry, OrderSnapshot } from '../orders/order-types.js';
import type { FailureDto, OrderDto, OrderHistoryDto } from './models.js';

function toFailureDto(failure: Readonly<FailureDetails> | null): FailureDto | null {
  return failure === null ? null : { code: failure.code, message: failure.message };
}

function toOrderHistoryDto(entry: OrderHistoryEntry): OrderHistoryDto {
  return {
    id: entry.id,
    fromState: entry.fromState,
    toState: entry.toState,
    event: entry.event,
    version: entry.version,
    createdAt: entry.createdAt.toISOString(),
    failure: toFailureDto(entry.failure),
    recoveryFailure: toFailureDto(entry.recoveryFailure),
  };
}

export function toOrderDto(order: OrderSnapshot): OrderDto {
  // Select public fields explicitly; never spread internal service/provider objects.
  return {
    id: order.id,
    state: order.state,
    version: order.version,
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
    history: [...order.history]
      .sort((left, right) => left.version - right.version)
      .map(toOrderHistoryDto),
  };
}
