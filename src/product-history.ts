import { modelKey } from "./matching.js";
import type { State } from "./types.js";
export const expressionKey = (value: string) =>
  modelKey(value.replace(/\s*\d+\s*(?:개|대|세트|ea).*$/i, "").trim());
export function selectionHistory(state: State, clientId: string, expression: string) {
  const key = expressionKey(expression),
    counts = new Map<string, { productId: string; variantId: string; count: number }>();
  for (const order of state.orders.filter(
    (o) => !o.deletedAt && !!o.confirmedAt && o.clientId === clientId,
  )) {
    const seen = new Set<string>();
    for (const row of order.confirmationSnapshot?.recipients ?? [])
      for (const item of row.items) {
        const evidence = item.selectionEvidence;
        if (
          !evidence ||
          expressionKey(evidence.expression) !== key ||
          evidence.productId !== item.productId ||
          evidence.variantId !== item.variantId
        )
          continue;
        const id = evidence.productId + "|" + evidence.variantId;
        if (seen.has(id)) continue;
        seen.add(id);
        const old = counts.get(id) ?? {
          productId: evidence.productId,
          variantId: evidence.variantId,
          count: 0,
        };
        old.count++;
        counts.set(id, old);
      }
  }
  return [...counts.values()];
}
