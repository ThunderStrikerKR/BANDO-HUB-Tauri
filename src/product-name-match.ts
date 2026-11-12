import type { Product } from "./types.js";

/**
 * Business product matching is based on registered sale names only.
 * Legacy internal codes and Cafe24 product codes are never evidence.
 */
export const normalizedProductName = (name: string) =>
  name.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim();

const escape = (term: string) =>
  [...term].map(char => /[\\^$.*+?()[\]{}|]/.test(char) ? "\\" + char : char).join("");

/**
 * The first slash-separated part of the sale name may be a model without
 * a number (BD Conductor), or a numbered model (Cart-10, BD Desk TS-2).
 */
export function productModelNames(product: Product): string[] {
  const first = product.name.split(/\s*\/\s*/)[0].trim();
  const isModel = /^(?:BD\s+)?(?:\d{3}[A-Za-z0-9-]*|[A-Za-z][A-Za-z0-9]*(?:\s+[A-Za-z][A-Za-z0-9]*){0,3}[- ]\d+[A-Za-z0-9-]*|[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+|[A-Za-z]{4,})$/i.test(first);
  if (!isModel) return [];
  return /^BD\s+/i.test(first)
    ? [first, first.replace(/^BD\s+/i, "")]
    : [first];
}

type NameMatch = { match: RegExpExecArray; priority: number };
type NameTerm = { text: string; priority: number };

/** Descriptions such as "지휘자 보면대" can name a product, but common
 * color, type and configuration fragments cannot independently identify it.
 */
const categoryOnly = /^(?:반도\s*)?(?:보면대|악보대|마이크\s*스탠드|키보드\s*스탠드|건반\s*스탠드|의자|카트)$/i;
const optionOnly = /^(?:블랙|검정|화이트|실버|그레이|브라운|골드|크롬|단일|기본|[A-Z]타입|타공\s*상판|비타공\s*상판|무타공\s*상판|가방\s*(?:미포함|포함)|바퀴\s*(?:미포함|포함)|\d+(?:\.\d+)?\s*cm)$/i;

function nameTerms(product: Product): NameTerm[] {
  const terms: NameTerm[] = [{ text: product.name, priority: 3 }];
  terms.push(...productModelNames(product).map(text => ({ text, priority: 2 })));
  const segments = product.name.split(/\s*\/\s*/).slice(1);
  for (const segment of segments) {
    const text = segment.trim();
    if (/[가-힣]/.test(text) && text.replace(/\s/g, "").length >= 4 &&
        !categoryOnly.test(text) && !optionOnly.test(text)) {
      terms.push({ text, priority: 1 });
    }
  }
  return terms
    .filter(term => !!term.text)
    .sort((a,b) => b.priority - a.priority || b.text.length - a.text.length);
}

function productNameMatch(source: string, product: Product): NameMatch | null {
  for (const term of nameTerms(product)) {
    // Permissive spacing recognizes "지휘자보면대" and "지휘자 보면대"
    // as the same registered Korean descriptor. ASCII model boundaries must
    // still keep 709 separate from 709-1 and Cart-10 separate from Cart-100.
    const expression = new RegExp("(?<![A-Za-z0-9-])" +
      [...term.text].map(c => /\s/.test(c) ? "\\s*" : escape(c)).join("") +
      "(?![A-Za-z0-9-])", "i");
    const match = expression.exec(source);
    if (match) return { match, priority: term.priority };
  }
  return null;
}

export function productNameEvidence(source: string, product: Product): RegExpExecArray | null {
  return productNameMatch(source, product)?.match ?? null;
}

export function registeredNameCandidates(products: Product[], source: string): Product[] {
  const found = products.map(product => ({ product, evidence: productNameMatch(source, product) }))
    .filter((row): row is { product: Product; evidence: NameMatch } => !!row.evidence);
  if (!found.length) return [];
  // Complete sale name > explicit model > descriptive Korean name fragment.
  // Equal-priority matches remain ambiguous instead of selecting by array order.
  const priority = Math.max(...found.map(row => row.evidence.priority));
  return found.filter(row => row.evidence.priority === priority).map(row => row.product);
}
