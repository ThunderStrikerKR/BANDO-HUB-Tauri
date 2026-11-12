import type { Product } from "./types.js";

/** Match only staff-curated product names. Old codes and Cafe24 P-codes are excluded. */
export const normalizedProductName = (name: string) =>
  name.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim();

const escape = (term: string) =>
  [...term].map(char => /[\\^$.*+?()[\]{}|]/.test(char) ? "\\" + char : char).join("");

export function productModelNames(product: Product): string[] {
  const first = product.name.split(/\s+\/\s+/)[0].trim();
  const model = /^(?:BD\s+)?(?:\d{3}[A-Za-z0-9-]*|[A-Za-z][A-Za-z0-9]*(?:\s+[A-Za-z][A-Za-z0-9]*){0,3}[- ]\d+[A-Za-z0-9-]*|[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+)$/i.test(first);
  if (!model) return [];
  return /^BD\s+/i.test(first) ? [first, first.replace(/^BD\s+/i, "")] : [first];
}
export function productNameEvidence(source: string, product: Product): RegExpExecArray | null {
  const terms = [product.name, ...productModelNames(product)].sort((a,b)=>b.length-a.length);
  for(const term of terms) {
    const pattern = new RegExp("(?<![A-Za-z0-9-])" +
      [...term].map(c=>/\s/.test(c) ? "\\s*" : escape(c)).join("") +
      "(?![A-Za-z0-9-])", "i");
    const match = pattern.exec(source);
    if(match) return match;
  }
  return null;
}
export function registeredNameCandidates(products: Product[], source: string): Product[] {
  const found = products.map(product=>({product,match:productNameEvidence(source,product)}))
    .filter((row): row is {product:Product;match:RegExpExecArray} => !!row.match);
  const exact = found.filter(({product,match}) =>
    normalizedProductName(match[0]) === normalizedProductName(product.name));
  return (exact.length ? exact : found).map(row=>row.product);
}
