import type { StoredOrder } from './order-store-types.js';

export type OrderClaim = Readonly<{ claimed: boolean; order: StoredOrder }>;
