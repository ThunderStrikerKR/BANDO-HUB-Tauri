/** Native Rust computations used by editable reception and dealer workflows.
 * No fallback to TypeScript prices or freight on failed native execution.
 * These functions never write SQLite or silently modify the supplied order.
 */
import { businessCoreCall } from "../tauri-bridge";
import type { Client, Order, State } from "../types";

export async function nativeRepriceEditedOrder(
  order: Order,
  client: Client,
  state: State,
): Promise<Order> {
  const next = structuredClone(order);
  const requests = next.recipients.flatMap((recipient) =>
    recipient.items.flatMap((item) => {
      const product = state.products.find((p) => p.id === item.productId);
      return product && item.variantId
        ? [{ item, product, variantId: item.variantId }]
        : [];
    }),
  );
  const prices = await Promise.all(
    requests.map(({ product, variantId }) =>
      businessCoreCall<{ unitPrice: number | null }>(
        "rules", "resolve_unit_price", { product, variantId, client },
      )),
  );
  requests.forEach(({ item, product, variantId }, index) => {
    item.unitPrice = prices[index].unitPrice;
    if (item.modelProposal?.required) {
      const variant = product.variants.find((v) => v.id === variantId);
      if (variant?.url) item.url = variant.url;
    }
  });
  return next;
}

export async function nativeReconcileWorkflow(
  state: State,
  draft: Order,
): Promise<State> {
  // Rust reconciliation is deterministic and never reads the system clock
  // or generates IDs itself. Reserve enough candidate IDs for all potential
  // downgrade and revalidation events; unused IDs are not persisted.
  const count = Math.max(
    256,
    12 * (state.workflow?.shipments.length ?? 0) +
      8 * state.orders.length + 64,
  );
  if (count > 15000) throw Error("재검증 이벤트가 너무 많습니다. 발주 묶음을 나누어 확인하세요.");
  const eventIds = Array.from({ length: count }, () => crypto.randomUUID());
  const { state: next } = await businessCoreCall<{ state: State; emittedEvents: number }>(
    "rules", "reconcile_workflow", {
      state, draft, now: new Date().toISOString(), eventIds,
    },
  );
  await businessCoreCall<{ valid: boolean }>(
    "rules", "validate_workflow", { state: next, before: state },
  );
  return next;
}
