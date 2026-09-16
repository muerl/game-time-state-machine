type ApiMethod = 'GET' | 'HEAD' | 'POST';
type ApiRoute = Readonly<{ path: string; methods: readonly ApiMethod[] }>;

export const apiRoutes = {
  health: { path: '/health', methods: ['GET', 'HEAD'] },
  orders: { path: '/orders', methods: ['POST'] },
  order: { path: '/orders/:id', methods: ['GET', 'HEAD'] },
  authorizePayment: { path: '/orders/:id/authorize-payment', methods: ['POST'] },
  completeOrder: { path: '/orders/:id/complete', methods: ['POST'] },
  cancelOrder: { path: '/orders/:id/cancel', methods: ['POST'] },
} as const satisfies Record<string, ApiRoute>;

export function orderLocation(orderId: string): string {
  return apiRoutes.order.path.replace(':id', encodeURIComponent(orderId));
}
