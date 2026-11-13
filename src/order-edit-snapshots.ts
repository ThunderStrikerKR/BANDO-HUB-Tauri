import { sameValue } from "./shared/draft";
import type { Order } from "./types";

/** Drop a local edit only when the corresponding order was actually persisted. */
export function retainUnsavedOrderEdits(
  edits: Record<string, Order>,
  savedOrders: readonly Order[],
): Record<string, Order> {
  const persisted = new Map(savedOrders.map((order) => [order.id, order]));
  return Object.fromEntries(Object.entries(edits).filter(([id, draft]) => {
    const saved = persisted.get(id);
    return !saved || !sameValue(draft, saved);
  }));
}
