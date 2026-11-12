import { selectionHistory } from "./product-history.js";
import { categoryKind } from "./matching.js";
import { registeredProducts } from "./product-models.js";
import { brandTerms } from "./product-registry.js";
import type { Product, State } from "./types.js";
export const searchKey = (s: string) => s.toLowerCase().replace(/\s+/g, "");
export function searchProducts(state: State, query: string, clientId?: string, category = "") {
  const terms = query.trim().split(/\s+/).filter(Boolean);
  return registeredProducts(state.products).filter(
    (p) =>
      (!category || p.categories?.includes(category) || p.category === category) &&
      terms.every((t) =>
        [
          p.name,
          p.subtitle ?? "",
          ...brandTerms(state, p),
          ...state.aliases
            .filter((a) => a.productId === p.id && (a.clientId === null || a.clientId === clientId))
            .map((a) => a.text),
        ].some((v) => searchKey(v).includes(searchKey(t))),
      ),
  );
}
export const productFamily = categoryKind;
export function representativeProducts(state: State, text: string, clientId?: string) {
  const family = productFamily(text);
  if (!family) return [];
  const all = registeredProducts(state.products).filter((p) =>
      searchKey(p.category + " " + p.name + " " + (p.subtitle ?? "")).includes(family),
    ),
    pool = all.some((p) => !p.variants.some((v) => v.source === "DEMO"))
      ? all.filter((p) => !p.variants.some((v) => v.source === "DEMO"))
      : all;
  const count = (p: Product) =>
    state.orders
      .filter(
        (o) =>
          !o.deletedAt &&
          (!clientId || o.clientId === clientId) &&
          state.workflow?.shipments.some(
            (s) => s.orderId === o.id && (s.step >= 1 || s.transferred),
          ),
      )
      .flatMap((o) => o.recipients.flatMap((r) => r.items))
      .filter((i) => i.productId === p.id)
      .reduce((n, i) => n + (i.quantity ?? 0), 0);
  const history = selectionHistory(state, clientId ?? "", text);
  const evidenceCount = (p: Product) =>
    history.filter((h) => h.productId === p.id).reduce((sum, h) => sum + h.count, 0);
  return pool
    .sort(
      (a, b) =>
        Number(
          /부속|라이트|바퀴|조명|브라켓|홀더|보면대등|부품|판대|스마트폰/.test(
            a.category + " " + a.name + " " + a.subtitle,
          ),
        ) -
          Number(
            /부속|라이트|바퀴|조명|브라켓|홀더|보면대등|부품|판대|스마트폰/.test(
              b.category + " " + b.name + " " + b.subtitle,
            ),
          ) ||
        evidenceCount(b) - evidenceCount(a) ||
        count(b) - count(a) ||
        Number(!!b.isDefaultSale) - Number(!!a.isDefaultSale) ||
        a.name.localeCompare(b.name, "ko", { numeric: true }),
    )
    .slice(0, 3);
}
