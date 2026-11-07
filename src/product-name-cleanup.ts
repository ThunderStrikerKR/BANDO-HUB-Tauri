import { normalizeModel, registeredProducts } from "./product-models";
import type { Product, State } from "./types";

/**
 * Brand prefixes, use cases and sale notes belong in the description, not
 * the model-only title. Never infer a model from a Cafe24 inventory P-code.
 */
export interface ProductNameCleanupRow {
  productId: string;
  code: string;
  oldName: string;
  newName: string;
  oldDescription: string;
  newDescription: string;
  status: "READY" | "HOLD";
  reason: string;
}
export interface ProductNameCleanupPreview {
  revision: number;
  rows: ProductNameCleanupRow[];
}

const PREFIX = /^\s*(?:반도스탠드|bandostand)\s*/i;
const SITE_CODE = /^(?:P[A-Z0-9]{5,}|SITE-|BANDO-SITE-)/i;
const KNOWN_MODEL = /\b(?:Cart[-\s]?\d+|Boss[-\s]?\d+|GT-\d+|LP-[A-Za-z0-9-]+|BL-\d+|1200A|MISpeech|Cupholder|Sheet\s+magnetic|MusicTray[A-Za-z0-9]*)\b/gi;
// When two sellable configurations differ by contents, neither side may
// rely on an implicit default. In particular, "미포함" is never omitted.
// This function only labels explicit evidence; it never invents a missing SKU.
const BINARY_CONTENT = /(가방|바퀴)\s*(미포함|포함|미장착|장착|없음|있음)/g;
function contentsOf(text: string): { label: string; kind: string; negative: boolean; raw: string }[] {
  const found: { label: string; kind: string; negative: boolean; raw: string }[] = [];
  for (const match of text.matchAll(BINARY_CONTENT)) {
    const negative = /^(?:미포함|미장착|없음)$/.test(match[2]);
    found.push({ label: match[1] + " " + (negative ? "미포함" : "포함"),
      kind: match[1], negative, raw: match[0] });
  }
  return found;
}
function variantContentsAreUnambiguous(product: Product): boolean {
  // A parent with multiple distinct sellable variants cannot have all of its
  // product-defining options safely collapsed into one short model title.
  // Keep the original display name until the SKU labels are reviewed.
  if (product.variants.length > 1) return false;
  return true;
}
const escapeRegex = (value: string) => value.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
const spaces = (value: string) => value.replace(/\s+/g, " ").trim();

function resolveModel(product: Product): { title: string; reason: string } | null {
  const code = spaces(product.code);
  const title = spaces(product.name.replace(PREFIX, ""));
  if (!SITE_CODE.test(code) && code.length >= 3 && code.length <= 52) {
    const compact = (value: string) => value.replace(/[\s-]/g, "").toLocaleUpperCase();
    if (compact(title).includes(compact(code))) {
      return { title: normalizeModel(code), reason: "확인된 상품 모델코드 사용" };
    }
  }
  // Only explicitly printed, recognizable models are accepted here.
  const candidates = [...title.matchAll(KNOWN_MODEL)].map((match) => spaces(match[0]));
  const distinct = [...new Set(candidates.map((candidate) => candidate.toLocaleUpperCase()))];
  if (distinct.length === 1) {
    return { title: candidates[0], reason: "상품명에 적힌 고유 모델 표기를 사용" };
  }
  return null;
}

function descriptionFromTitle(name: string, model: string): string {
  const title = spaces(name.replace(PREFIX, ""));
  const flexibleModel = model.split(/\s+/).map(escapeRegex).join("\\s*");
  const matcher = new RegExp("(?<![A-Za-z0-9])" + flexibleModel + "(?![A-Za-z0-9])", "i");
  const remainder = title.replace(matcher, " ")
    .replace(BINARY_CONTENT, " ")
    .replace(/^\s*(?:BD\s+)?반도스탠드\s*/i, "")
    .replace(/^\s*BD\s+(?=[가-힣])/, "")
    .replace(/\(\s*\)/g, "")
    .replace(/^[\s,()\/\[\]–—-]+|[\s,()\/\[\]–—-]+$/g, "");
  return spaces(remainder);
}

function isOnlyUsageDescription(value: string): boolean {
  return /^(?:성악용|녹음용|국악용|탁상용|교육용|연주용|실내용|야외용|탁상,국악용)/.test(value);
}
function hasUnresolvedAlternatives(text: string): boolean {
  return /\bBD\s*\d{3,4}[A-Z0-9-]*\s*(?:\/|,|\+)\s*(?:BD\s*)?\d{3,4}[A-Z0-9-]*/i.test(text) ||
    /\bBD\s*\d{3,4}[A-Z0-9-]*\s+\d{3,4}[A-Z][A-Z0-9-]*/i.test(text);
}

function combineDescription(extracted: string, existing: string): string {
  const first = spaces(extracted);
  const second = spaces(existing);
  if (!first) return second;
  if (!second || first === second || first.includes(second)) return first;
  if (second.includes(first)) return second;
  return first + " / " + second;
}

export function previewProductNameCleanup(state: State): ProductNameCleanupPreview {
  const rows: ProductNameCleanupRow[] = [];
  for (const product of registeredProducts(state.products)) {
    if (product.catalog === "BANDOMALL" || !PREFIX.test(product.name)) continue;
    const existing = product.subtitle ?? "";
    const model = resolveModel(product);
    const qualifiers = contentsOf(product.name);
    const otherVariants = registeredProducts(state.products).filter((other) =>
      other.id !== product.id && (other.catalog ?? "BANDOSTAND") === (product.catalog ?? "BANDOSTAND") &&
      other.code.replace(/\s/g, "").toUpperCase() === product.code.replace(/\s/g, "").toUpperCase());
    const groupFlags = [qualifiers, ...otherVariants.map((other) => contentsOf(other.name))];
    const ambiguousSibling = ["가방", "바퀴"].some((kind) =>
      groupFlags.some((flags) => flags.some((item) => item.kind === kind)) &&
      groupFlags.some((flags) => !flags.some((item) => item.kind === kind)));
    if (!model || !variantContentsAreUnambiguous(product) ||
        ambiguousSibling || hasUnresolvedAlternatives(product.name)) {
      rows.push({
        productId: product.id, code: product.code, oldName: product.name, newName: product.name,
        oldDescription: existing, newDescription: existing,
        status: "HOLD", reason: !model ? "모델명을 확정할 수 없습니다. 상세관리에서 수동으로 확인하세요." :
          "색상, 규격, 구성품 또는 선택 옵션이 구분돼 있습니다. 개별 판매 상품명을 확인하세요.",
      });
      continue;
    }
    const remainder = descriptionFromTitle(product.name, model.title);
    const usageOnly = isOnlyUsageDescription(remainder);
    const description = combineDescription(usageOnly ? remainder : "", existing);
    const distinctFlags = [...new Set(qualifiers.map((flag) => flag.label))];
    const displayName = [model.title, ...(remainder && !usageOnly ? [remainder] : []),
      ...distinctFlags].join(" / ");
    if (displayName === product.name && description === existing) continue;
    rows.push({
      productId: product.id, code: product.code, oldName: product.name, newName: displayName,
      oldDescription: existing, newDescription: description,
      status: "READY", reason: model.reason,
    });
  }
  return { revision: state.revision ?? 0, rows };
}

/** Only name, subtitle, originalName and updatedAt change. Product/SKU IDs persist. */
export function applyProductNameCleanup(state: State, preview: ProductNameCleanupPreview): {
  next: State;
  changed: number;
} {
  if ((state.revision ?? 0) !== preview.revision) {
    throw Error("미리보기 이후 상품 데이터가 변경되었습니다. 다시 검토하세요.");
  }
  const fresh = previewProductNameCleanup(state);
  if (JSON.stringify(fresh.rows) !== JSON.stringify(preview.rows)) {
    throw Error("상품명 또는 설명이 변경되었습니다. 다시 검토하세요.");
  }
  const next = structuredClone(state);
  let changed = 0;
  for (const row of fresh.rows) {
    if (row.status !== "READY") continue;
    const product = next.products.find((item) => item.id === row.productId);
    if (!product || product.name !== row.oldName || (product.subtitle ?? "") !== row.oldDescription) {
      throw Error("변경 대상 상품이 현재 데이터와 일치하지 않습니다.");
    }
    product.originalName ??= product.name;
    product.name = row.newName;
    product.subtitle = row.newDescription;
    product.updatedAt = new Date().toISOString();
    changed++;
  }
  return { next, changed };
}
