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


const CAFE24_CODE = /^P[A-Z0-9]{6,}$/i;
const TITLE_PREFIX = /^(?:반도스탠드|bandostand)\s*/i;
const BINARY_CONTENT = /(가방|바퀴)\s*(미포함|포함|미장착|장착|없음|있음)/g;
const escapeModel = (s: string) => s.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");

function explicitModel(raw: string): string | null {
  const candidate = clean(raw);
  if (!candidate || CAFE24_CODE.test(candidate) ||
      /^(?:미등록|모델명|N\/A|없음|선택|선택하세요)$/i.test(candidate) ||
      candidate.length > 60 || /[<>]/.test(candidate)) return null;
  const bd = candidate.match(/^BD[\s-]*([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)$/i);
  return bd ? normalizeModel("BD " + bd[1]) : normalizeModel(candidate);
}

/** A Cafe24 P-code is never a model. Only use unique title tokens. */
function modelCode(field: (name: string) => string, title: string): {
  code: string | null; source: "MODEL_FIELD" | "CUSTOM_CODE" | "TITLE" | "UNRESOLVED";
} {
  const direct = explicitModel(field("모델명"));
  if (direct) return { code: direct, source: "MODEL_FIELD" };
  const custom = explicitModel(field("자체 상품코드"));
  if (custom) return { code: custom, source: "CUSTOM_CODE" };
  const tokens: string[] = [];
  for (const found of title.matchAll(/\bBD[\s-]*([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)\b/gi)) {
    if (/\d/.test(found[1])) tokens.push(normalizeModel("BD " + found[1]));
  }
  if (!tokens.length) {
    for (const found of title.matchAll(/\b(?:[A-Z][A-Z0-9]{1,8}(?:-[A-Z0-9]{1,8}){1,3}|\d{3,4}[A-Z]{1,3})\b/gi)) {
      if (/\d/.test(found[0]) && !CAFE24_CODE.test(found[0])) tokens.push(normalizeModel(found[0]));
    }
  }
  const unique = new Set(tokens.map((value) => normalizeCode(value)));
  return unique.size === 1
    ? { code: tokens[0], source: "TITLE" }
    : { code: null, source: "UNRESOLVED" };
}

function parsePrice(raw: string): number | null {
  const text = clean(raw);
  // Do not guess the lower bound of a price range or a bundle price.
  if (!/^(?:₩\s*)?\d+(?:,\d{3})*(?:\.00)?\s*(?:원)?$/.test(text)) return null;
  const value = Number(text.replace(/[,₩원\s]/g, ""));
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

export interface OfficialOptionEvidence {
  group: string;
  kind: "SELECT" | "RADIO" | "CHECKBOX" | "CUSTOM";
  values: { label: string; token: string }[];
}
const isRealOption = (value: string) => !!value && !["*", "**", "0"].includes(value);
function inspectOptions(doc: Document): OfficialOptionEvidence[] {
  const results: OfficialOptionEvidence[] = [];
  const selectors = '.xans-product-option select, select[id^="product_option_id"]';
  for (const select of Array.from(doc.querySelectorAll<HTMLSelectElement>(selectors)).slice(0, 20)) {
    const group = clean(select.closest("tr")?.querySelector("th")?.textContent) ||
      clean(select.getAttribute("aria-label")) || "선택 옵션";
    const values = Array.from(select.options).filter((option) =>
      !option.disabled && isRealOption(option.value.trim())
    ).slice(0, 50).map((option) => ({
      label: clean(option.textContent).slice(0, 120),
      token: option.value.trim().slice(0, 100),
    }));
    // Empty dynamic controls are also evidence of selectable options.
    results.push({ group: group.slice(0, 80), kind: "SELECT", values });
  }
  for (const control of Array.from(doc.querySelectorAll<HTMLInputElement>(
    '.xans-product-option input[type="radio"], .xans-product-option input[type="checkbox"]'
  )).slice(0, 80)) {
    const group = clean(control.name) || "선택 옵션";
    let found = results.find((entry) => entry.group === group && entry.kind ===
      (control.type === "radio" ? "RADIO" : "CHECKBOX"));
    if (!found) {
      found = { group, kind: control.type === "radio" ? "RADIO" : "CHECKBOX", values: [] };
      results.push(found);
    }
    if (!control.disabled && found.values.length < 50) {
      found.values.push({
        label: clean(control.closest("label")?.textContent) ||
          clean(control.getAttribute("aria-label")) || clean(control.value),
        token: control.value.slice(0, 100),
      });
    }
  }
  const customs = Array.from(doc.querySelectorAll<HTMLElement>(
    '.xans-product-option [data-option-value]'
  )).slice(0, 50);
  if (customs.length) results.push({
    group: "선택 옵션", kind: "CUSTOM",
    values: customs.map((item) => ({
      label: clean(item.textContent).slice(0, 120),
      token: (item.dataset.optionValue ?? "").slice(0, 100),
    })),
  });
  return results;
}

function presentationName(sourceTitle: string, code: string | null): {
  name: string; subtitle: string;
} {
  const original = clean(sourceTitle.replace(TITLE_PREFIX, ""));
  if (!code) return { name: original, subtitle: "" };
  const flags = Array.from(original.matchAll(BINARY_CONTENT)).map((match) => ({
    label: match[1] + " " + (/^(미포함|미장착|없음)$/.test(match[2]) ? "미포함" : "포함"),
  }));
  const withoutModel = original.replace(
    new RegExp(escapeModel(code).replace(/\s+/g, "\\s*"), "i"), " ");
  const residual = clean(withoutModel.replace(BINARY_CONTENT, " ")
    .replace(/^[\s,/\[\]()–—-]+|[\s,/\[\]()–—-]+$/g, ""));
  const usageOnly = /^(?:성악용|녹음용|국악용|탁상용|교육용|연주용|실내용|야외용|사용|추천|용도)|^[가-힣,\s]+용\s/.test(residual);
  // If the remainder might distinguish SKUs, keep it in the shared name.
  const baseName = residual && !usageOnly ? clean(code + " " + residual) : code;
  return {
    name: [baseName, ...new Set(flags.map((f) => f.label))].join(" / "),
    subtitle: usageOnly ? residual : "",
  };
}

function pageFields(doc: Document): (name: string) => string {
  const map = new Map<string, string>();
  for (const row of Array.from(doc.querySelectorAll("tr"))) {
    const header = clean(row.querySelector("th")?.textContent).replace(/[\s:：]/g, "");
    const data = clean(row.querySelector("td")?.textContent);
    if (header && data && !map.has(header)) map.set(header, data);
  }
  for (const item of Array.from(doc.querySelectorAll("dl"))) {
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
  const { code, source: modelSource } = modelCode(field, name);
  const siteCodeRaw = field("상품코드") || field("자체 상품코드");
  const siteCode = CAFE24_CODE.test(siteCodeRaw) ? siteCodeRaw : undefined;
  const presentation = presentationName(name, code);
  const displayedPrice = field("판매가");
  // Never use a meta-tag base price to mask an ambiguous, explicit price range.
  const retail = displayedPrice
    ? parsePrice(displayedPrice)
    : parsePrice(meta('meta[property="product:price:amount"]')) ??
      parsePrice(clean(doc.querySelector("#span_product_price_text")?.textContent));
  const description = clean(doc.querySelector("#prdDetail, .prdDetail")?.textContent).slice(0, 6000);
  const explicitColor = field("색상") ||
    name.match(/\b(Black|White|Gray|Grey|Silver|Brown|Blue|Red|Gold|Clear)\b/i)?.[1] ||
    name.match(/(블랙|검정|화이트|그레이|회색|실버|브라운|블루|레드|골드|클리어)/)?.[1] ||
    description.match(/\bColor\s*:\s*(Black|White|Gray|Grey|Silver|Brown|Blue|Red|Gold|Clear)\b/i)?.[1] || "";
  const color = normalizeColor(explicitColor || "단일");
  const catalog: Catalog = url.hostname.endsWith("bandomall.co.kr") ? "BANDOMALL" : "BANDOSTAND";
  const now = new Date().toISOString();

  const optionEvidence = inspectOptions(doc);
  const selectableOptions = optionEvidence.length > 0;
  const unclearOptions = /(?:색상|컬러|사이즈|규격|옵션|바퀴|가방)\s*(?:선택|옵션)/i.test(name) ||
    /\bBD\s*\d{3,4}[A-Z0-9-]*\s*(?:\/|,|\+)\s*(?:BD\s*)?\d{3,4}[A-Z0-9-]*/i.test(name) ||
    /\bBD\s*\d{3,4}[A-Z0-9-]*\s+\d{3,4}[A-Z][A-Z0-9-]*/i.test(name);
  const matches = exactSourceMatches(state, catalog, id);
  const sameCode = registeredProducts(state.products).filter((p) =>
    (p.catalog ?? "BANDOSTAND") === catalog && !!code && normalizeCode(p.code) === normalizeCode(code)
  );
  const reasons = [
    ...(code === null ? ["모델코드를 확정할 수 없습니다. 카페24 상품코드와 상품번호는 모델명으로 사용하지 않습니다."] : []),
    ...(retail === null ? ["판매가를 확인하지 못했습니다. 가격을 임의로 입력하지 않습니다."] : []),
    ...(selectableOptions || unclearOptions ? ["상품 선택 옵션이 있습니다. 옵션별 모델, 포함 / 미포함 구성과 판매가를 직접 확인해야 합니다."] : []),
    ...(matches.length > 1 ? ["원본 상품번호에 여러 상품이 연결되어 있어 자동 반영할 수 없습니다."] : []),
    ...(matches.length === 1 && matches[0].variants.length !== 1 ?
      ["기존 상품에 여러 옵션이 연결되어 있어 대상 옵션을 확정할 수 없습니다."] : []),
    ...(matches.length === 0 && sameCode.length > 0 ?
      ["같은 모델코드의 기존 상품이 있습니다. 중복 또는 색상 구성을 확인해야 합니다."] : []),
    ...(state.products.some((p) => p.deletedAt &&
      (p.siteId === id || ((p.catalog ?? "BANDOSTAND") === catalog && !!code &&
        normalizeCode(p.code) === normalizeCode(code)))) ?
      ["삭제된 상품과 일치할 수 있으므로 자동 복원하지 않습니다."] : []),
  ];
  const product: Product = {
    id: crypto.randomUUID(), code: code ?? "", name: presentation.name,
    subtitle: presentation.subtitle, originalName: name, siteCode,
    catalog, origin: catalog === "BANDOSTAND" ? "FACTORY" : "STORE",
    category: "", categories: [], active: true,
    siteId: id, siteRefs: [id],
    defaultColor: color, colorStatus: color === "단일" ? "NOT_REQUIRED" : "KNOWN",
    saleUnit: !selectableOptions && !unclearOptions,
    requiresOption: selectableOptions || unclearOptions,
    manufacturerCode: code ?? undefined,
    modelCodes: code ? [code] : [],
    modelKey: code ? catalog + "|" + normalizeCode(code) : undefined,
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
    optionEvidence, modelSource,
    canApply: reasons.length === 0,
    revision: state.revision ?? 0,
  };
}

/** Apply only an unambiguous, single-option import, with revision and duplicate guards. */
export function applyOfficialProductPreview(
  state: State, preview: ImportPreview, selectedCategoryId?: string,
): { next: State; created: boolean } {
  if (!preview.canApply || preview.product.requiresOption ||
      preview.optionEvidence?.length || !preview.product.code?.trim() ||
      CAFE24_CODE.test(preview.product.code)) {
    throw Error("확인이 필요한 옵션 또는 모델이 있어 자동 반영을 중단했습니다.");
  }
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
