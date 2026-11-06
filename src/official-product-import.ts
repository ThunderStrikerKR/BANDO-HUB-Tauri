import { categoryPath } from "./category-tree";
import { catalogFromCategory, withCatalogRoots } from "./category-roots";
import { normalizeCode, normalizeColor, validateProduct, validProductUrl } from "./domain";
import { normalizeModel, registeredProducts } from "./product-models";
import type { Catalog, ImportPreview, Product, State } from "./types";

/**
 * Parse the current public detail page without executing embedded HTML scripts.
 * Conservatively refuse ambiguous variations rather than inventing option prices.
 */
const clean = (text?: string | null): string => (text ?? "").replace(/\s+/g, " ").trim();

function siteProductId(url: URL): string | null {
  const queryId = url.searchParams.get("product_no");
  if (url.pathname === "/product/detail.html" && queryId && /^\d+$/.test(queryId)) return queryId;
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] !== "product") return null;
  // The first numeric segment after a product slug is the Cafe24 product ID.
  return parts.slice(2).find((part) => /^\d+$/.test(part)) ?? null;
}

function modelCode(raw: string, title: string): string | null {
  const candidate = clean(raw);
  const bd = (candidate || title).match(/\bBD[\s-]*([A-Za-z0-9]+(?:[-][A-Za-z0-9]+)*)/i);
  if (bd) return normalizeModel("BD " + bd[1]);
  if (!candidate || /^P[A-Z0-9]{6,}$/i.test(candidate) || candidate.length > 60) return null;
  return normalizeModel(candidate);
}

function parsePrice(raw: string): number | null {
  const match = clean(raw).match(/(?:^|[^\d])(\d{1,3}(?:,\d{3})+|\d+)(?:\s*원|\s*$)/);
  if (!match) return null;
  const value = Number(match[1].replaceAll(",", ""));
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function pageFields(doc: Document): (name: string) => string {
  const map = new Map<string, string>();
  for (const row of doc.querySelectorAll("tr")) {
    const header = clean(row.querySelector("th")?.textContent).replace(/[\s:：]/g, "");
    const data = clean(row.querySelector("td")?.textContent);
    if (header && data && !map.has(header)) map.set(header, data);
  }
  for (const item of doc.querySelectorAll("dl")) {
    const header = clean(item.querySelector("dt")?.textContent).replace(/[\s:：]/g, "");
    const data = clean(item.querySelector("dd")?.textContent);
    if (header && data && !map.has(header)) map.set(header, data);
  }
  return (name) => map.get(name.replace(/\s/g, "")) ?? "";
}

function exactSourceMatches(state: State, catalog: Catalog, id: string) {
  return registeredProducts(state.products).filter((product) =>
    (product.catalog ?? "BANDOSTAND") === catalog &&
    (product.siteId === id || product.siteRefs?.includes(id) ||
      product.variants.some((variant) => variant.siteProductId === id))
  );
}

export function parseOfficialProductPage(urlText: string, html: string, state: State): ImportPreview {
  if (!validProductUrl(urlText)) {
    throw Error("공식 홈페이지의 HTTPS 상품 상세 URL을 입력하세요.");
  }
  const url = new URL(urlText);
  const id = siteProductId(url);
  if (!id) throw Error("상품번호가 없는 상세페이지는 분석할 수 없습니다.");
  const doc = new DOMParser().parseFromString(html, "text/html");
  const field = pageFields(doc);
  const meta = (selector: string) => clean(doc.querySelector<HTMLMetaElement>(selector)?.content);
  const name = field("상품명") ||
    clean(doc.querySelector(".headingArea h2, .xans-product-detail h2")?.textContent) ||
    meta('meta[property="og:title"]');
  if (!name) throw Error("공식 상세페이지에서 상품명을 확인하지 못했습니다.");
  const code = modelCode(field("모델명") || field("자체 상품코드"), name);
  if (!code) throw Error("모델코드를 확정할 수 없습니다. 상세관리에서 수동으로 등록해 주세요.");
  const retail = parsePrice(field("판매가")) ??
    parsePrice(meta('meta[property="product:price:amount"]')) ??
    parsePrice(clean(doc.querySelector("#span_product_price_text")?.textContent));
  const description = clean(doc.querySelector("#prdDetail, .prdDetail")?.textContent).slice(0, 6000);
  const explicitColor = field("색상") ||
    name.match(/\b(Black|White|Gray|Grey|Silver|Brown|Blue|Red|Gold|Clear)\b/i)?.[1] ||
    name.match(/(블랙|검정|화이트|그레이|회색|실버|브라운|블루|레드|골드|클리어)/)?.[1] ||
    description.match(/\bColor\s*:\s*(Black|White|Gray|Grey|Silver|Brown|Blue|Red|Gold|Clear)\b/i)?.[1] || "";
  const color = normalizeColor(explicitColor || "단일");
  const catalog: Catalog = url.hostname.endsWith("bandomall.co.kr") ? "BANDOMALL" : "BANDOSTAND";
  const now = new Date().toISOString();

  const selectableOptions = Array.from(doc.querySelectorAll<HTMLSelectElement>(
    '.xans-product-option select, select[id^="product_option_id"]'
  )).some((select) => Array.from(select.options).some((option) =>
    !option.disabled && !!option.value &&
    option.value !== "*" && option.value !== "**" && option.value !== "0"
  ));
  const matches = exactSourceMatches(state, catalog, id);
  const sameCode = registeredProducts(state.products).filter((p) =>
    (p.catalog ?? "BANDOSTAND") === catalog && normalizeCode(p.code) === normalizeCode(code)
  );
  const reasons = [
    ...(retail === null ? ["판매가를 확인하지 못했습니다. 가격을 임의로 입력하지 않습니다."] : []),
    ...(selectableOptions ? ["상품 선택 옵션이 있습니다. 옵션별 모델과 판매가를 직접 확인해야 합니다."] : []),
    ...(matches.length > 1 ? ["원본 상품번호에 여러 상품이 연결되어 있어 자동 반영할 수 없습니다."] : []),
    ...(matches.length === 1 && matches[0].variants.length !== 1 ?
      ["기존 상품에 여러 옵션이 연결되어 있어 대상 옵션을 확정할 수 없습니다."] : []),
    ...(matches.length === 0 && sameCode.length > 0 ?
      ["같은 모델코드의 기존 상품이 있습니다. 중복 또는 색상 구성을 확인해야 합니다."] : []),
    ...(state.products.some((p) => p.deletedAt &&
      (p.siteId === id || ((p.catalog ?? "BANDOSTAND") === catalog &&
        normalizeCode(p.code) === normalizeCode(code)))) ?
      ["삭제된 상품과 일치할 수 있으므로 자동 복원하지 않습니다."] : []),
  ];
  const product: Product = {
    id: crypto.randomUUID(), code, name,
    catalog, origin: catalog === "BANDOSTAND" ? "FACTORY" : "STORE",
    category: "", categories: [], active: true,
    siteId: id, siteRefs: [id],
    defaultColor: color, colorStatus: color === "단일" ? "NOT_REQUIRED" : "KNOWN",
    saleUnit: true, manufacturerCode: code,
    modelCodes: [code], modelKey: catalog + "|" + normalizeCode(code),
    createdAt: now, updatedAt: now,
    variants: [{
      id: crypto.randomUUID(), color, option: "",
      wholesale: null, semi: null, retail,
      officialRetail: retail, url: url.toString(), source: "OFFICIAL",
      siteProductId: id, collectedAt: now,
    }],
  };
  return {
    product, related: [], sourceUrl: url.toString(),
    existingId: matches.length === 1 ? matches[0].id : null,
    warnings: reasons.length ? reasons : ["공식 페이지의 표시 판매가입니다. 승인 전에 상품명과 모델을 확인하세요."],
    canApply: reasons.length === 0,
    revision: state.revision ?? 0,
  };
}

/** Apply only an unambiguous, single-option import, with revision and duplicate guards. */
export function applyOfficialProductPreview(
  state: State, preview: ImportPreview, selectedCategoryId?: string,
): { next: State; created: boolean } {
  if (!preview.canApply) throw Error("확인이 필요한 옵션 또는 모델이 있어 자동 반영을 중단했습니다.");
  if ((state.revision ?? 0) !== preview.revision) {
    throw Error("미리보기 후 상품 데이터가 변경되었습니다. 다시 분석하세요.");
  }
  const imported = preview.product;
  const id = imported.siteId;
  if (!id || !imported.variants[0] || imported.variants[0].retail === null ||
      !validProductUrl(preview.sourceUrl)) {
    throw Error("공식 상품 식별자 또는 판매가를 다시 확인하세요.");
  }
  const matches = exactSourceMatches(state, imported.catalog ?? "BANDOSTAND", id);
  if (matches.length > 1) throw Error("하나의 원본 상품번호에 여러 상품이 연결되어 있습니다.");
  const next = structuredClone(state);
  if (matches.length === 1) {
    const product = next.products.find((item) => item.id === matches[0].id)!;
    if (product.variants.length !== 1) throw Error("여러 옵션 중 대상 옵션을 확정할 수 없습니다.");
    if (normalizeCode(product.code) !== normalizeCode(imported.code)) {
      throw Error("원본의 모델코드가 기존 상품과 다릅니다. 수동 확인이 필요합니다.");
    }
    const variant = product.variants[0];
    const oldPrice = variant.retail;
    const newPrice = imported.variants[0].retail;
    if (oldPrice === newPrice) throw Error("기존 판매가와 동일합니다. 수정할 내용이 없습니다.");
    variant.retail = newPrice;
    variant.officialRetail = newPrice;
    variant.collectedAt = imported.variants[0].collectedAt;
    variant.source = "OFFICIAL";
    variant.url = preview.sourceUrl;
    product.priceHistory ??= [];
    product.priceHistory.push({
      at: new Date().toISOString(), field: variant.id + ".retail",
      before: oldPrice, after: newPrice, source: "OFFICIAL_URL",
    });
    product.updatedAt = new Date().toISOString();
    return { next, created: false };
  }
  if (registeredProducts(state.products).some((p) =>
    (p.catalog ?? "BANDOSTAND") === imported.catalog &&
    normalizeCode(p.code) === normalizeCode(imported.code))) {
    throw Error("같은 모델코드의 상품이 존재합니다. 자동 중복 등록을 막았습니다.");
  }
  if (state.products.some((p) => p.deletedAt &&
    (p.siteId === id || ((p.catalog ?? "BANDOSTAND") === imported.catalog &&
      normalizeCode(p.code) === normalizeCode(imported.code))))) {
    throw Error("삭제된 상품을 자동 복구할 수 없습니다.");
  }
  const cats = withCatalogRoots(state.categories);
  const category = cats.find((c) => c.id === selectedCategoryId);
  const path = category ? categoryPath(cats, category.id) : [];
  if (!category || !path.length || !state.categories?.some((c) => c.id === category.id) ||
      cats.some((c) => c.parentId === category.id) || category.active === false ||
      catalogFromCategory(cats, category.id) !== imported.catalog) {
    throw Error("상품이 속할 활성 최하위 카테고리를 선택하세요.");
  }
  const product = structuredClone(imported);
  product.categories = path.map((c) => c.id);
  product.category = path.map((c) => c.name).join(" > ");
  validateProduct(product, registeredProducts(next.products));
  next.products.push(product);
  return { next, created: true };
}

export function leafCategories(state: State, catalog: Catalog) {
  const cats = withCatalogRoots(state.categories);
  return cats.filter((item) => state.categories?.some((c) => c.id === item.id) &&
    item.active !== false && !cats.some((other) => other.parentId === item.id) &&
    catalogFromCategory(cats, item.id) === catalog).map((item) => ({
      id: item.id,
      label: categoryPath(cats, item.id).map((c) => c.name).join(" / "),
    }));
}
