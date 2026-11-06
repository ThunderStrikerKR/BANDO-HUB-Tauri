import type { Product, State } from "./types.js";
const known =
  /^(Black|White|Gray|Grey|Brown|Silver|Clear|Frost|Blue|Red|블랙|화이트|그레이|브라운|실버|클리어|프로스트|블루|레드)$/i;
export function saleColorLabel(p: Product) {
  return p.colorStatus === "NOT_REQUIRED"
    ? ""
    : p.colorStatus === "MISSING"
      ? "색상 데이터 확인"
      : (p.variants[0]?.color ?? "");
}
export function splitSales(input: State): State {
  const state = structuredClone(input),
    map: Record<string, string> = { ...(state.productMappings ?? {}) },
    products: Product[] = [];
  for (const p of state.products) {
    if (p.supersededBy || p.saleUnit) {
      products.push(p);
      continue;
    }
    const family =
      p.modelKey ?? (p.catalog ?? "BANDOSTAND") + "|" + p.code.replace(/\s/g, "").toUpperCase();
    for (const [index, variant] of p.variants.entries()) {
      const id = index === 0 ? p.id : p.id + "~sale~" + encodeURIComponent(variant.id);
      if (products.some((x) => x.id === id)) throw Error("상품 ID 충돌: " + id);
      const description = [p.originalName, p.subtitle, variant.option].join(" ");
      const colorStatus = known.test(variant.color)
        ? "KNOWN"
        : /색상\s*선택|컬러\s*선택|랜덤|색상\s*누락/.test(description)
          ? "MISSING"
          : "NOT_REQUIRED";
      const unit: Product = {
        ...p,
        id,
        saleUnit: true,
        familyKey: family,
        isDefaultSale: variant.color === p.defaultColor,
        sourceProductId: p.id,
        colorStatus,
        variants: [structuredClone(variant)],
        requiresOption: false,
        defaultColor: variant.color,
        modelKey: family + "|sale:" + variant.id,
        subtitle: (p.subtitle ?? "")
          .replace(/black|white|gray|grey|brown|silver|clear|frost|실버|블랙|화이트|그레이/gi, "")
          .replace(/\s+/g, " ")
          .trim(),
      };
      products.push(unit);
      map[p.id + "|" + variant.id] = id;
      if (p.deletedAt) {
        state.deletedProductKeys ??= [];
        state.deletedProductKeys.push(unit.modelKey!);
      }
      if (index && state.shipping?.productRules?.[p.id]) {
        state.shipping.productRules[id] = structuredClone(state.shipping.productRules[p.id]);
        state.shipping.productHistory ??= {};
        state.shipping.productHistory[id] = structuredClone(
          state.shipping.productHistory[p.id] ?? [],
        );
      }
    }
  }
  state.products = products;
  state.productMappings = map;
  for (const o of state.orders)
    for (const r of o.recipients)
      for (const i of r.items) {
        const id = map[(i.productId ?? "") + "|" + (i.variantId ?? "")];
        if (id && id !== i.productId) {
          i.originalProductId ??= i.productId ?? undefined;
          i.productId = id;
        }
      }
  for (const a of state.aliases) {
    const old = input.products.find((p) => p.id === a.productId);
    const vid =
      a.variantId ??
      old?.variants.find((v) => v.color === old.defaultColor)?.id ??
      old?.variants[0]?.id;
    const id = map[a.productId + "|" + vid];
    if (id) {
      a.productId = id;
      a.variantId = vid;
    }
  }
  return state;
}
