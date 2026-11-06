import { modelKey, categoryKind } from "./matching.js";
import { registeredProducts } from "./product-models.js";
import type { Product, State } from "./types.js";
export const familyId = (p: Product) => p.familyKey || p.sourceProductId || p.id;
/** Explicit assignments override automatic families. Build the lookup once per operation,
 * rather than scanning every configured group again for every product. */
function assignedProductIds(state: State) {
  const ids = new Set<string>();
  for (const group of Object.values(state.settings.modelFamilies ?? {})) {
    for (const id of group.productIds) ids.add(id);
  }
  return ids;
}
export function modelGroup(state: State, product: Product) {
  const custom = Object.entries(state.settings.modelFamilies ?? {}).find(([, g]) =>
    g.productIds.includes(product.id),
  );
  if (custom) return { id: custom[0], ...custom[1] };
  const id = familyId(product);
  const assigned = assignedProductIds(state);
  const members = state.products.filter(
    (p) => familyId(p) === id && !assigned.has(p.id),
  );
  return { id, code: product.originalCode || product.code, productIds: members.map((p) => p.id) };
}
export function groupMembers(state: State, id: string) {
  const group = state.settings.modelFamilies?.[id];
  const products = registeredProducts(state.products);
  if (group) {
    const members = new Set(group.productIds);
    return products.filter((p) => members.has(p.id));
  }
  const assigned = assignedProductIds(state);
  return products.filter((p) => familyId(p) === id && !assigned.has(p.id));
}
const colorKey = (p: Product) => p.variants[0]?.color.toLowerCase() ?? "";
export function representative(state: State, id: string) {
  const configured = state.settings.modelRepresentatives?.[id],
    members = groupMembers(state, id);
  if (configured)
    return members.find(
      (p) => p.id === configured.productId && p.variants.some((v) => v.id === configured.variantId),
    );
  const kind = categoryKind(
    members.map((p) => p.category + " " + p.subtitle + " " + p.name).join(" "),
  );
  const defaults = members.filter((p) =>
    kind === "보면대"
      ? /^(black|블랙|검정)$/i.test(colorKey(p))
      : kind === "마이크"
        ? /^(chrome|크롬)$/i.test(colorKey(p))
        : false,
  );
  return defaults.length === 1 ? defaults[0] : undefined;
}
export function baseModelCandidates(text: string, state: State) {
  const keys = [
    ...text.matchAll(/(?<![A-Za-z0-9])(?:BD\s*)?(\d{3,}[A-Za-z0-9-]*)(?![A-Za-z0-9])/gi),
  ].map((m) => modelKey(m[0]));
  const matches = (code: string) => {
    const key = modelKey(code);
    if (!key) return false;
    const escaped = [...key]
      .map((char) => char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("\\s*");
    return new RegExp("(?<![A-Za-z0-9-])(?:BD\\s*)?" + escaped + "(?![A-Za-z0-9-])", "i").test(
      text,
    );
  };
  const groups = new Map<string, ReturnType<typeof modelGroup>>();
  for (const [id, group] of Object.entries(state.settings.modelFamilies ?? {}))
    if (matches(group.code)) groups.set(id, { id, ...group });
  if (!keys.length && !groups.size) return [];
  for (const p of registeredProducts(state.products)) {
    if (!keys.includes(modelKey(p.originalCode || p.code))) continue;
    const group = modelGroup(state, p);
    if (matches(group.code)) groups.set(group.id, group);
  }
  let rows = [...groups.values()].flatMap((g) => {
    const preferred = representative(state, g.id);
    return groupMembers(state, g.id).sort(
      (a, b) => Number(b.id === preferred?.id) - Number(a.id === preferred?.id),
    );
  });
  if (!rows.length) {
    // Registered, exact option suffixes are suggestions only, never a persisted family or SKU confirmation.
    rows = registeredProducts(state.products).filter((p) =>
      keys.some((key) => ["C", "BK"].some((suffix) => modelKey(p.code) === key + suffix)),
    );
    rows.sort(
      (a, b) =>
        Number(
          categoryKind(b.category + " " + b.name) === "마이크" &&
            /^(chrome|크롬)$/i.test(colorKey(b)),
        ) -
        Number(
          categoryKind(a.category + " " + a.name) === "마이크" &&
            /^(chrome|크롬)$/i.test(colorKey(a)),
        ),
    );
  }
  return [...new Map(rows.map((p) => [p.id, p])).values()];
}
export function validateModelSettings(next: State, before?: State) {
  for (const [id, g] of Object.entries(next.settings.modelFamilies ?? {})) {
    if (
      !g.code.trim() ||
      !g.productIds.length ||
      new Set(g.productIds).size !== g.productIds.length
    )
      throw Error("모델군과 실제 상품을 선택하세요.");
    if (
      Object.entries(next.settings.modelFamilies ?? {}).some(
        ([other, row]) =>
          other !== id &&
          (modelKey(row.code) === modelKey(g.code) ||
            row.productIds.some((p) => g.productIds.includes(p))),
      )
    )
      throw Error("모델군 코드 또는 소속 상품이 중복됩니다.");
    if (
      JSON.stringify(before?.settings.modelFamilies?.[id]) !== JSON.stringify(g) &&
      g.productIds.some(
        (pid) => !next.products.some((p) => p.id === pid && p.active !== false && !p.deletedAt),
      )
    )
      throw Error("등록된 판매 상품만 모델군에 지정하세요.");
  }
  for (const [id, r] of Object.entries(next.settings.modelRepresentatives ?? {})) {
    if (
      !groupMembers(next, id).some(
        (p) => p.id === r.productId && p.variants.some((v) => v.id === r.variantId),
      ) &&
      JSON.stringify(before?.settings.modelRepresentatives?.[id]) !== JSON.stringify(r)
    )
      throw Error("같은 모델군에 등록된 활성 SKU만 대표모델로 지정할 수 있습니다.");
  }
}
export function isRepresentative(state: State, p: Product) {
  const group = modelGroup(state, p);
  return representative(state, group.id)?.id === p.id;
}
