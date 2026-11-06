import { normalizeCode } from "./domain";
import { registeredProducts } from "./product-models";
import type { CatalogReport, Price, Product, State, Variant } from "./types";

export type CatalogPriceStatus = "READY" | "UNCHANGED" | "HOLD" | "UNREGISTERED";
export interface CatalogPriceRow {
  sourceProductId: string;
  variantId: string;
  targetProductId?: string;
  label: string;
  oldPrice: Price;
  newPrice: Price;
  status: CatalogPriceStatus;
  reason: string;
}
export interface CatalogPricePreview {
  revision: number;
  collectedAt: string;
  rows: CatalogPriceRow[];
}

export function previewCatalogPriceSync(state: State, report: CatalogReport): CatalogPricePreview {
  const active = registeredProducts(state.products);
  const rows: CatalogPriceRow[] = [];
  for (const source of report.products) {
    const seenVariantIds = new Set<string>();
    for (const incoming of source.variants) {
      const targetId = state.productMappings?.[source.id + "|" + incoming.id] ?? source.id;
      const target = active.find((p) => p.id === targetId);
      const variant = target?.variants.find((v) => v.id === incoming.id);
      const label = source.code + " / " + (incoming.option || incoming.color);
      let status: CatalogPriceStatus = "HOLD";
      let reason = "";
      const nextPrice = incoming.retail;
      const previous = variant?.retail ?? null;
      if (seenVariantIds.has(incoming.id)) {
        reason = "수집본에 중복된 옵션 ID가 있습니다.";
      } else if (!target || !variant) {
        status = "UNREGISTERED";
        reason = "등록된 상품과 옵션 ID가 일치하지 않습니다. 신규 자동 등록 대상은 아닙니다.";
      } else if ((target.catalog ?? "BANDOSTAND") !== (source.catalog ?? "BANDOSTAND") ||
        normalizeCode(target.code) !== normalizeCode(source.code) ||
        !source.siteId || !target.siteId || target.siteId !== source.siteId) {
        reason = "상품군, 모델코드 또는 공식 상품번호가 다릅니다.";
      } else if (
        (source.variants.length > 1 || target.sourceProductId) &&
        (!incoming.siteOptionId || incoming.siteOptionId !== variant.siteOptionId)
      ) {
        reason = "복합 옵션의 공식 옵션 ID가 다르거나 누락되었습니다.";
      } else if (incoming.siteOptionId && incoming.siteOptionId !== variant.siteOptionId) {
        reason = "공식 옵션 ID가 변경되어 자동 갱신할 수 없습니다.";
      } else if (nextPrice === null || !Number.isSafeInteger(nextPrice) || nextPrice < 0 ||
        (incoming.officialRetail !== undefined && incoming.officialRetail !== nextPrice)) {
        reason = "공식 수집 판매가가 없거나 유효하지 않습니다.";
      } else if (previous === nextPrice) {
        status = "UNCHANGED";
        reason = "현재 소매가와 일치합니다.";
      } else if (!Number.isFinite(Date.parse(report.collectedAt)) ||
        (variant.collectedAt && Date.parse(variant.collectedAt) > Date.parse(report.collectedAt))) {
        reason = "현재 상품에 더 최근의 수집 정보가 있습니다. 오래된 가격으로 되돌리지 않습니다.";
      } else if (variant.officialRetail !== undefined && variant.officialRetail !== previous) {
        reason = "직원이 변경한 소매가가 있어 자동 덮어쓰지 않습니다.";
      } else if (variant.source === "MANUAL" && previous !== null) {
        reason = "직원이 입력한 소매가입니다. 자동 덮어쓰지 않습니다.";
      } else {
        status = "READY";
        reason = "확인된 옵션의 소매가만 갱신합니다.";
      }
      rows.push({
        sourceProductId: source.id, variantId: incoming.id, targetProductId: target?.id,
        label, oldPrice: previous, newPrice: nextPrice, status, reason,
      });
      seenVariantIds.add(incoming.id);
    }
  }
  return { revision: state.revision ?? 0, collectedAt: report.collectedAt, rows };
}

/**
 * Approved catalogue snapshots only update retail/officialRetail for an exact
 * product + variant identity. They NEVER create products, reorder variants,
 * replace wholesale/semi prices, or update a newer official collection.
 */
export function applyCatalogPriceSync(
  state: State, report: CatalogReport, preview: CatalogPricePreview,
): { next: State; updated: number } {
  if ((state.revision ?? 0) !== preview.revision) {
    throw Error("가격 검토 후 다른 데이터가 변경되었습니다. 다시 검토하세요.");
  }
  const fresh = previewCatalogPriceSync(state, report);
  if (fresh.collectedAt !== preview.collectedAt ||
    JSON.stringify(fresh.rows) !== JSON.stringify(preview.rows)) {
    throw Error("카탈로그 수집본이나 옵션 가격이 달라졌습니다. 다시 검토하세요.");
  }
  const eligible = fresh.rows.filter((row) => row.status === "READY");
  if (!eligible.length) throw Error("안전하게 갱신할 소매가가 없습니다.");
  const next = structuredClone(state);
  const now = new Date().toISOString();
  for (const row of eligible) {
    const product: Product | undefined = next.products.find((p) => p.id === row.targetProductId);
    const variant: Variant | undefined = product?.variants.find((v) => v.id === row.variantId);
    if (!product || !variant) throw Error("가격 갱신 중 상품 옵션을 찾지 못했습니다.");
    const before = variant.retail;
    variant.retail = row.newPrice;
    variant.officialRetail = row.newPrice;
    variant.collectedAt = report.collectedAt;
    variant.source = "OFFICIAL";
    product.priceHistory ??= [];
    product.priceHistory.push({
      at: now, field: variant.id + ".retail", before, after: row.newPrice,
      source: "CATALOG_SNAPSHOT",
    });
    product.updatedAt = now;
  }
  return { next, updated: eligible.length };
}
