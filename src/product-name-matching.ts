import { colorLabel } from "./product-models.js";
import type { Product } from "./types.js";

/** The curated product name is the recognition authority; IDs are storage keys. */
export const productNameHead = (product: Product) =>
  product.name.replace(/^\[가상\]\s*/, "").split(/\s*\/\s*/)[0].trim();

const escape = (value: string) =>
  [...value].map(char => "\\^$.*+?()[]{}|".includes(char) ? "\\" + char : char).join("");

export function productNameSpan(product: Product, input: string): RegExpExecArray | null {
  const head = productNameHead(product);
  if (head.length < 3 || /^(반도\s*)?(보면대|악보대|마이크\s*스탠드|키보드\s*스탠드)$/i.test(head))
    return null;
  const bare = head.replace(/^BD(?:\s|-)+/i, "");
  const prefix = bare !== head ? "(?:BD[\\s-]*)?" : "";
  const expression = bare.split(/\s+/).map(word =>
    [...word].map(escape).join("\\s*")).join("\\s*");
  return new RegExp("(?<![A-Za-z0-9가-힣-])" + prefix + expression +
    "(?![A-Za-z0-9가-힣-])", "i").exec(input.normalize("NFKC"));
}

const compact = (text: string) => text.normalize("NFKC").toLowerCase().replace(/\s/g, "");
function conflictsConfiguration(expression: string, product: Product): boolean {
  const raw = compact(expression), name = compact(product.name);
  if (/(민판|무타공|비타공)/.test(raw) && !/(민판|무타공|비타공)/.test(name)) return true;
  if (/(?<![비무])타공/.test(raw) && !/(?<![비무])타공/.test(name)) return true;
  for (const kind of ["가방", "바퀴"]) {
    const match = raw.match(new RegExp(kind + "(미포함|포함|미장착|장착|없음|있음)"));
    if (match && !name.includes(kind + match[1])) return true;
  }
  if ((raw.match(/\d+(?:\.\d+)?cm/g) ?? []).some(size => !name.includes(size))) return true;
  const colors: [RegExp, string][] = [
    [/(블랙|검정|black)/,"블랙"], [/(화이트|흰색|white)/,"화이트"],
    [/(브라운|brown)/,"브라운"], [/(그레이|회색|gray|grey)/,"그레이"],
    [/(실버|silver)/,"실버"], [/(크롬|chrome)/,"크롬"],
    [/(골드|gold)/,"골드"], [/(클리어|clear)/,"클리어"],
    [/(프로스트|frost)/,"프로스트"],
  ];
  for (const [pattern,label] of colors) {
    if (!pattern.test(raw)) continue;
    if (colors.some(([other])=>other.test(name)) && !pattern.test(name)) return true;
    const registered = colorLabel(product.variants[0]?.color ?? "");
    if (registered && registered !== "색상 미표기" && registered !== "단일" &&
        registered !== label && !pattern.test(name)) return true;
  }
  return false;
}
export function nameCandidates(products: Product[], expression: string): Product[] {
  const hits = products.filter(p => productNameSpan(p,expression) &&
    !conflictsConfiguration(expression,p));
  if (!hits.length) return [];
  const max = Math.max(...hits.map(p=>productNameHead(p).length));
  return hits.filter(p=>productNameHead(p).length === max);
}
