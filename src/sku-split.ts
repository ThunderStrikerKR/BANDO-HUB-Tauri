import { normalizeColor } from "./domain";
import { normalizeModel, registeredProducts } from "./product-models";
import { validateModelSettings } from "./model-families";
import type { Product, State, Variant } from "./types";

export interface SkuSplitPreview {
  sourceId: string;
  revision: number;
  rows: { variantId: string; newProductId: string; color: string; option: string; retail: number | null; wholesale: number | null; semi: number | null }[];
  blockers: string[];
  affectedOrders: number;
  historicalOrders: number;
  affectedAliases: number;
  affectedLinks: number;
}
const skuId = (sourceId: string, variantId: string): string =>
  "sku:" + encodeURIComponent(sourceId) + ":" + encodeURIComponent(variantId);

function sourceProduct(state: State, sourceId: string): Product {
  const source = state.products.find((product) => product.id === sourceId);
  if (!source || source.deletedAt || source.supersededBy || source.active === false) {
    throw Error("분리 가능한 활성 상품이 아닙니다.");
  }
  if (source.variants.length < 2 || source.saleUnit) {
    throw Error("여러 판매 옵션이 연결된 원본 상품만 분리할 수 있습니다.");
  }
  return source;
}

export function previewSkuSplit(state: State, sourceId: string): SkuSplitPreview {
  const source = sourceProduct(state, sourceId);
  const variants = source.variants;
  const blockers: string[] = [];
  const ids = new Set<string>();
  const options = new Set<string>();
  const defaultMatches = variants.filter((v) => normalizeColor(v.color) === normalizeColor(source.defaultColor));
  if (defaultMatches.length !== 1) blockers.push("기본 판매 옵션을 한 개로 특정할 수 없습니다.");
  for (const variant of variants) {
    if (!variant.id || ids.has(variant.id)) blockers.push("옵션 ID가 없거나 중복되었습니다.");
    ids.add(variant.id);
    const key = normalizeColor(variant.color) + "|" + (variant.option ?? "").trim();
    if (options.has(key)) blockers.push("같은 색상과 옵션명이 중복되어 있습니다.");
    options.add(key);
    if (!variant.color.trim() || (/색상\s*(?:미표기|확인\s*필요)/.test(variant.color) && !(variant.option ?? "").trim())) {
      blockers.push("색상과 옵션 구성을 확정할 수 없습니다.");
    }
    if (variant.source === "OFFICIAL" && !variant.siteOptionId) {
      blockers.push("공식 판매 옵션의 고유 옵션 ID가 없습니다.");
    }
    if (state.products.some((p) => p.id !== source.id && !p.deletedAt && !p.supersededBy &&
      p.variants.some((v) => v.id === variant.id))) {
      blockers.push("다른 활성 상품과 옵션 ID가 충돌합니다.");
    }
    if (state.products.some((p) => p.id === skuId(source.id, variant.id))) {
      blockers.push("새 SKU의 상품 ID가 이미 등록되어 있습니다.");
    }
    const priorMapping = state.productMappings?.[source.id + "|" + variant.id];
    if (priorMapping && priorMapping !== skuId(source.id, variant.id)) {
      blockers.push("기존 판매 옵션의 연결 이력이 있습니다. 자동 분리로 덮어쓸 수 없습니다.");
    }
  }
  const siteIds = variants.map((v) => v.siteOptionId).filter(Boolean);
  if (new Set(siteIds).size !== siteIds.length) {
    blockers.push("공식 옵션 ID가 중복되어 잘못된 가격이 연결될 위험이 있습니다.");
  }
  const variantIds = new Set(variants.map((v) => v.id));
  const aliases = state.aliases.filter((a) => a.productId === source.id);
  for (const alias of aliases) {
    if (!alias.variantId || !variantIds.has(alias.variantId)) {
      blockers.push("상품 별칭에 정확한 옵션 ID가 없습니다. 분리 전에 별칭을 정정하세요.");
    }
  }
  const links = (state.sourceLinks ?? []).filter((item) => item.productId === source.id);
  for (const link of links) {
    if (!link.optionId || variants.filter((v) => v.siteOptionId === link.optionId).length !== 1) {
      blockers.push("원본 사이트 연결에 식별 가능한 옵션 ID가 없습니다.");
    }
  }
  let affectedOrders = 0;
  let historicalOrders = 0;
  for (const order of state.orders) {
    const affected = order.recipients.some((r) =>
      r.items.some((i) => i.productId === source.id));
    if (!affected) continue;
    if (order.confirmedAt) {
      historicalOrders++;
      continue; // Immutable historical order references keep the archived original.
    }
    affectedOrders++;
    for (const recipient of order.recipients) {
      for (const item of recipient.items) {
        if (item.productId === source.id && (!item.variantId || !variantIds.has(item.variantId))) {
          blockers.push("진행 중인 주문에 어떤 판매 옵션인지 확인되지 않은 품목이 있습니다.");
        }
      }
    }
  }
  for (const [groupId, config] of Object.entries(state.settings.modelRepresentatives ?? {})) {
    if (config.productId === source.id && !variantIds.has(config.variantId)) {
      blockers.push(groupId + " 모델군의 대표 옵션 ID가 원본과 일치하지 않습니다.");
    }
  }
  const rows = variants.map((v) => ({
    variantId: v.id, newProductId: skuId(source.id, v.id),
    color: v.color, option: v.option ?? "",
    retail: v.retail, wholesale: v.wholesale, semi: v.semi,
  }));
  return {
    sourceId, revision: state.revision ?? 0, rows,
    blockers: [...new Set(blockers)],
    affectedOrders, historicalOrders, affectedAliases: aliases.length, affectedLinks: links.length,
  };
}

/**
 * This is a reviewed, all-or-nothing transformation. Existing variant IDs and prices
 * remain unchanged, confirmed order snapshots retain their original product IDs,
 * and the original multi-option product is archived (not deleted).
 */
export function applySkuSplit(state: State, preview: SkuSplitPreview): {
  next: State; created: number;
} {
  if ((state.revision ?? 0) !== preview.revision) {
    throw Error("검토 후 데이터가 변경되었습니다. 최신 상품으로 분리 내용을 다시 확인하세요.");
  }
  const fresh = previewSkuSplit(state, preview.sourceId);
  if (fresh.blockers.length) throw Error("확인되지 않은 판매 옵션이 있어 SKU 분리를 중단했습니다: " + fresh.blockers.join(" / "));
  if (JSON.stringify(fresh.rows) !== JSON.stringify(preview.rows)) {
    throw Error("옵션 구성 또는 가격이 달라졌습니다. 분리 내용을 다시 확인하세요.");
  }
  const next = structuredClone(state);
  const source = sourceProduct(next, preview.sourceId);
  const now = new Date().toISOString();
  const split = source.variants.map((variant: Variant) => {
    const family = source.familyKey || source.sourceProductId || source.id;
    const product: Product = {
      ...structuredClone(source),
      id: skuId(source.id, variant.id),
      sourceProductId: source.id,
      saleUnit: true,
      familyKey: family,
      modelKey: (source.catalog ?? "BANDOSTAND") + "|" +
        normalizeModel(source.code).replace(/\s/g, "").toUpperCase() + "|sale:" + variant.id,
      isDefaultSale: normalizeColor(variant.color) === normalizeColor(source.defaultColor),
      defaultColor: variant.color,
      colorStatus: source.colorStatus === "NOT_REQUIRED" ? "NOT_REQUIRED" : "KNOWN",
      requiresOption: false,
      siteId: variant.siteProductId || source.siteId,
      registrationIdentity: source.registrationIdentity
        ? source.registrationIdentity + "|sku:" + variant.id : undefined,
      variants: [structuredClone(variant)],
      updatedAt: now,
    };
    delete product.supersededBy;
    delete product.deletedAt;
    return product;
  });
  const mapped = new Map(source.variants.map((variant, i) => [variant.id, split[i].id]));
  const siteMapped = new Map(source.variants.map((variant, i) => [variant.siteOptionId, split[i].id]));
  const archived = structuredClone(source);
  archived.supersededBy = split[0].id;
  archived.updatedAt = now;
  const at = next.products.findIndex((p) => p.id === source.id);
  next.products.splice(at, 1, archived, ...split);

  next.productMappings ??= {};
  for (const [variantId, id] of mapped) next.productMappings[source.id + "|" + variantId] = id;

  for (const order of next.orders) {
    if (order.confirmedAt) continue;
    for (const recipient of order.recipients) {
      for (const item of recipient.items) {
        if (item.productId !== source.id) continue;
        const id = mapped.get(item.variantId ?? "");
        if (!id) throw Error("진행 중인 주문에 미확인 옵션이 있습니다.");
        item.originalProductId ??= source.id;
        item.productId = id;
        if (item.selectionEvidence?.productId === source.id) {
          item.selectionEvidence.productId = id;
        }
      }
    }
  }
  for (const alias of next.aliases) {
    if (alias.productId !== source.id) continue;
    const id = mapped.get(alias.variantId ?? "");
    if (!id) throw Error("옵션이 지정되지 않은 별칭은 이동할 수 없습니다.");
    alias.productId = id;
  }
  for (const link of next.sourceLinks ?? []) {
    if (link.productId !== source.id) continue;
    const id = siteMapped.get(link.optionId);
    if (!id) throw Error("공식 상품 연결에 옵션 식별자가 없습니다.");
    link.productId = id;
  }
  for (const group of Object.values(next.settings.modelFamilies ?? {})) {
    if (group.productIds.includes(source.id)) {
      group.productIds = [...new Set(group.productIds.flatMap((id) =>
        id === source.id ? split.map((p) => p.id) : [id]))];
    }
  }
  for (const group of Object.values(next.settings.modelRepresentatives ?? {})) {
    if (group.productId === source.id) {
      const id = mapped.get(group.variantId);
      if (!id) throw Error("대표 상품의 옵션 식별자를 찾지 못했습니다.");
      group.productId = id;
    }
  }
  if (next.shipping?.productRules?.[source.id]) {
    for (const product of split) {
      next.shipping.productRules[product.id] = structuredClone(next.shipping.productRules[source.id]);
    }
  }
  if (next.shipping?.productHistory?.[source.id]) {
    for (const product of split) {
      next.shipping.productHistory[product.id] = structuredClone(next.shipping.productHistory[source.id]);
    }
  }
  validateModelSettings(next, state);
  return { next, created: split.length };
}

export function skuSplitCandidates(state: State): Product[] {
  return registeredProducts(state.products).filter((p) => p.variants.length > 1 && !p.saleUnit);
}
