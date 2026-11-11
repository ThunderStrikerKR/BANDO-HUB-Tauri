import type { Order } from "../types.js";

/**
 * Only a still-uncommitted reception may follow current master prices and
 * shipping rules automatically. Opening or refreshing a saved order is a
 * read-only operation even when pricesLocked is false in legacy records.
 *
 * Explicit staff edits are handled by their own event handlers and can
 * reprice on purpose; this policy only gates background React effects.
 */
export function shouldRefreshUncommittedOrderPricing(
  order: Order,
  persistedOrders: readonly Pick<Order, "id">[],
): boolean {
  return !order.confirmedAt &&
    !order.deletedAt &&
    !order.pricesLocked &&
    !persistedOrders.some((persisted) => persisted.id === order.id);
}
