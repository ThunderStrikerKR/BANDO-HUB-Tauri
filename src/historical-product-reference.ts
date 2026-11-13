import type { Product, State } from "./types.js";

/**
 * Resolve a frozen historical reference without editing the order, its
 * confirmation snapshot, price, or the recorded item name.
 *
 * A pre-split parent ID is only meaningful together with the historical
 * price-record ID. Product name, model code and color are not safe keys.
 */
export function resolveHistoricalProductReference(
  state: Pick<State, "products" | "productMappings">,
  productId: string | null | undefined,
  priceRecordId: string | null | undefined,
): { product: Product; via: "CURRENT" | "HISTORICAL" } | null {
  if (!productId || !priceRecordId) return null;
  const direct = state.products.find((p) => p.id === productId);
  if (direct) {
    // A current product with a mismatched record must not be reinterpreted
    // as an older parent product, even if stale mapping data exists.
    if (direct.variants.length !== 1 || direct.variants[0].id !== priceRecordId) return null;
    return { product: direct, via: "CURRENT" };
  }
  const mappedId = state.productMappings?.[`${productId}|${priceRecordId}`];
  if (!mappedId) return null;
  const mapped = state.products.find((p) => p.id === mappedId);
  if (
    !mapped ||
    mapped.sourceProductId !== productId ||
    mapped.variants.length !== 1 ||
    mapped.variants[0].id !== priceRecordId
  ) return null;
  return { product: mapped, via: "HISTORICAL" };
}
