import { Hono } from 'hono';
import type { Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { isOrderPending } from '../domain/order.js';
import { OrderServiceError } from '../orders/order-service.js';
import type { OrderService } from '../orders/order-service.js';
import type { OrderSnapshot } from '../orders/order-types.js';
import { handleApiError } from './errors.js';
import { toOrderDto } from './order-mapper.js';
import { readOrderOperationCommand, readCreateOrderCommand, readOrderId } from './requests.js';
import { apiRoutes, orderLocation } from './routes.js';

function operationResponse(context: Context, snapshot: OrderSnapshot) {
  const order = toOrderDto(snapshot);
  const pending = isOrderPending(order.state);
  if (pending) context.header('Location', orderLocation(order.id));
  return context.json({ order }, pending ? 202 : 200);
}

export function createOrderApi(service: OrderService) {
  const app = new Hono();
  app.use('*', async (context, next) => {
    context.header('Cache-Control', 'no-store');
    await next();
  });
  app.use('*', bodyLimit({ maxSize: 16 * 1024,
    onError: (context) => context.json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body exceeds 16 KiB.' } }, 413),
  }));

  app.get(apiRoutes.health.path, (context) => context.json({ status: 'ok' }));

  app.post(apiRoutes.orders.path, async (context) => {
    const result = await service.create(await readCreateOrderCommand(context));
    const order = toOrderDto(result.order);
    context.header('Location', orderLocation(order.id));
    return context.json({ order }, result.replayed ? 200 : 201);
  });

  app.get(apiRoutes.order.path, async (context) => {
    const order = await service.get(readOrderId(context));
    if (!order) throw new OrderServiceError('ORDER_NOT_FOUND');
    return context.json({ order: toOrderDto(order) });
  });

  app.post(apiRoutes.authorizePayment.path, async (context) => {
    const command = await readOrderOperationCommand(context);
    return operationResponse(context, await service.authorizePayment(command));
  });

  app.post(apiRoutes.completeOrder.path, async (context) => {
    const command = await readOrderOperationCommand(context);
    return operationResponse(context, await service.completeOrder(command));
  });

  app.post(apiRoutes.cancelOrder.path, async (context) => {
    const command = await readOrderOperationCommand(context);
    return operationResponse(context, await service.cancelOrder(command));
  });

  for (const route of Object.values(apiRoutes)) {
    app.all(route.path, (context) => {
      context.header('Allow', route.methods.join(', '));
      return context.json({ error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed.' } }, 405);
    });
  }
  app.notFound((context) => context.json({ error: { code: 'NOT_FOUND', message: 'Route not found.' } }, 404));
  app.onError(handleApiError);
  return app;
}
