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

/** Only the official product number and the exact variant IDs may match prices.
 * A Cafe24 P-code is not a business model code and is never used for matching.
 */
export function previewCatalogPriceSync(state: State, report: CatalogReport): CatalogPricePreview {
  const active = registeredProducts(state.products);
  const rows: CatalogPriceRow[] = [];
  const encountered = new Set<string>();
  for (const source of report.products) {
    const catalog = source.catalog ?? "BANDOSTAND";
    for (const incoming of source.variants) {
      const lookupKey = catalog + "|" + (source.siteId ?? "") + "|" + incoming.id;
      const mapped = state.productMappings?.[source.id + "|" + incoming.id];
      const candidates = active.filter((product) =>
        (product.catalog ?? "BANDOSTAND") === catalog &&
        product.siteId === source.siteId &&
        (mapped ? product.id === mapped : product.id === source.id) &&
        product.variants.some((variant) => variant.id === incoming.id)
      );
      const target = candidates.length === 1 ? candidates[0] : undefined;
      const variant = target?.variants.find((v) => v.id === incoming.id);
      const oldPrice = variant?.retail ?? null;
      const newPrice = incoming.retail;
      let status: CatalogPriceStatus = "HOLD";
      let reason = "";
      if (!source.siteId || !incoming.id || encountered.has(lookupKey)) {
        reason = "홈페이지 상품번호나 판매 옵션 ID가 없거나 중복되었습니다.";
      } else if (candidates.length > 1) {
        reason = "동일한 공식 옵션에 연결된 상품이 여러 개 있습니다.";
      } else if (!target || !variant) {
        status = "UNREGISTERED";
        reason = "해당 홈페이지 상품번호와 옵션 ID의 등록 상품을 찾지 못했습니다.";
      } else if (
        (source.variants.length > 1 || target.sourceProductId || target.variants.length > 1) &&
        (!incoming.siteOptionId || !variant.siteOptionId ||
          incoming.siteOptionId !== variant.siteOptionId)
      ) {
        reason = "복합 옵션의 카페24 옵션 ID가 일치하지 않습니다.";
      } else if (incoming.siteOptionId && incoming.siteOptionId !== variant.siteOptionId) {
        reason = "카페24 옵션 ID가 변경되었습니다.";
      } else if (newPrice === null || !Number.isSafeInteger(newPrice) || newPrice <= 0 ||
        (incoming.officialRetail !== undefined && incoming.officialRetail !== newPrice)) {
        reason = "공식 소매가가 미등록이거나 유효하지 않습니다.";
      } else if (!Number.isFinite(Date.parse(report.collectedAt)) ||
        (variant.collectedAt && Number.isFinite(Date.parse(variant.collectedAt)) &&
          Date.parse(variant.collectedAt) >= Date.parse(report.collectedAt) &&
          oldPrice !== newPrice)) {
        reason = "기존 가격보다 최근의 자료이거나 같은 시각의 수집본입니다.";
      } else if (variant.source === "MANUAL" && oldPrice !== null) {
        reason = "직원이 입력한 소매가는 수집본으로 덮어쓰지 않습니다.";
      } else if (variant.officialRetail !== undefined &&
        variant.officialRetail !== null && variant.officialRetail !== oldPrice) {
        reason = "공식 소매가와 현재 소매가가 달라 수동 수정 가능성이 있습니다.";
      } else if (oldPrice === newPrice) {
        status = "UNCHANGED";
        reason = "현재 소매가와 동일합니다.";
      } else {
        status = "READY";
        reason = "공식 식별자가 일치하는 소매가만 변경할 수 있습니다.";
      }
      rows.push({
        sourceProductId: source.id, variantId: incoming.id,
        targetProductId: target?.id,
        label: source.name + " / " + (incoming.option || incoming.color),
        oldPrice, newPrice, status, reason,
      });
      encountered.add(lookupKey);
    }
  }
  return { revision: state.revision ?? 0, collectedAt: report.collectedAt, rows };
}

/** Apply only approved retail prices and preserve all staff tiers, IDs, orders and source links. */
export function applyCatalogPriceSync(
  state: State, report: CatalogReport, preview: CatalogPricePreview,
): { next: State; updated: number } {
  if ((state.revision ?? 0) !== preview.revision) {
    throw Error("검토 후 데이터가 변경되었습니다. 다시 미리보기를 생성하세요.");
  }
  const fresh = previewCatalogPriceSync(state, report);
  if (fresh.collectedAt !== preview.collectedAt ||
    JSON.stringify(fresh.rows) !== JSON.stringify(preview.rows)) {
    throw Error("수집본 또는 변경 대상이 달라졌습니다. 다시 검토하세요.");
  }
  const ready = fresh.rows.filter((r) => r.status === "READY");
  if (!ready.length) throw Error("안전하게 갱신할 소매가가 없습니다.");
  const next = structuredClone(state);
  const now = new Date().toISOString();
  for (const row of ready) {
    const product: Product | undefined = next.products.find((p) => p.id === row.targetProductId);
    const variant: Variant | undefined = product?.variants.find((v) => v.id === row.variantId);
    if (!product || !variant) throw Error("가격 수정 대상의 옵션 식별자를 찾지 못했습니다.");
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
  return { next, updated: ready.length };
}
