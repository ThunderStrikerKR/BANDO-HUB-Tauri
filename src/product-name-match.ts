import type { Product } from "./types.js";

/** Business identity is always derived from the registered sale name, never legacy codes. */
export const normalizedProductName = (name: string) =>
  name.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim();

const escape = (char: string) =>
  /[\\^$.*+?()[\]{}|]/.test(char) ? "\\" + char : char;
const modelLead = (product: Product) => product.name.split(/\s*\/\s*/)[0].trim();
const isScoreStand = (product: Product) => /^보면대(?:\s*>|$)/.test(product.category);
const scoreModel = (product: Product) =>
  modelLead(product).match(/^(?:BD[\s-]*)?(\d{3})(-1)?\s*(BR|G|W)?$/i);
const isNoHoles = (source: string) =>
  /민\s*판|무\s*타공|비\s*타공|구멍\s*(?:없음|없는|안\s*뚫린)/i.test(source);
const isWithHoles = (source: string) =>
  !isNoHoles(source) && /(?:^|[\s/,(])타\s*공|구멍\s*(?:있는|있음|뚫린)/i.test(source);

/** A base is verified only when the catalog actually registers both tops. */
export function verifiedScoreStandBases(products: Product[]): Set<string> {
  const perforated = new Set<string>();
  const nonperforated = new Set<string>();
  for (const product of products) {
    if (!isScoreStand(product)) continue;
    const model = scoreModel(product);
    if (!model) continue;
    if (!model[2] && /(?:^|\/)\s*타공\s*상판/.test(product.name))
      perforated.add(model[1]);
    if (model[2] && /비타공\s*상판|무타공\s*상판/.test(product.name))
      nonperforated.add(model[1]);
  }
  return new Set([...perforated].filter(base => nonperforated.has(base)));
}

/** -1 is a non-perforated top only on registered Bando music stands.
 * A number without -1 is NOT automatically a perforated top: that requires
 * an explicit product description or a verified pair in the catalog.
 */
export function scoreStandTop(
  product: Product, verifiedBases: ReadonlySet<string> = new Set(),
): "UNPERFORATED" | "PERFORATED" | null {
  if (!isScoreStand(product)) return null;
  const model = scoreModel(product);
  if (!model) return null;
  if (model[2]) return "UNPERFORATED";
  if (/(?:^|\/)\s*타공\s*상판/.test(product.name) || verifiedBases.has(model[1]))
    return "PERFORATED";
  return null;
}

/** The first slash-separated segment can be Korean or an alphabetic model. */
export function productModelNames(product: Product): string[] {
  const lead = modelLead(product);
  if (!lead) return [];
  const withoutBrand = lead.replace(/^BD[\s-]+/i, "");
  return lead === withoutBrand ? [lead] : [lead, withoutBrand];
}

type Evidence = { match: RegExpExecArray; priority: number };
type Term = { text: string; priority: number; model: boolean };
type Candidate = { product: Product; found: Evidence };
const genericDescription = /^(?:반도\s*)?(?:보면대|악보대|마이크\s*스탠드|키보드\s*스탠드|건반\s*스탠드|의자|카트)$/i;
const optionDescription = /^(?:블랙|검정|화이트|실버|그레이|브라운|골드|크롬|단일|기본|[A-Z]타입(?:\s*상판)?|타공\s*상판|비타공\s*상판|무타공\s*상판|가방\s*(?:미포함|포함)|바퀴\s*(?:미포함|포함)|\d+(?:\.\d+)?\s*cm)$/i;

/** A dimensional/quantity/color fragment is never enough to identify a product. */
const descriptiveIdentity = (text: string) =>
  /보면대|악보대|스탠드|트레이|홀더|마운트|발판|거치대|스테레오바|어댑터|테이블|마그네틱|클립/i.test(text);

function terms(product: Product): Term[] {
  const result: Term[] = [{ text: product.name, priority: 3, model: false }];
  result.push(...productModelNames(product).map(text => ({ text, priority: 2, model: true })));
  for (const segment of product.name.split(/\s*\/\s*/).slice(1)) {
    const text = segment.trim();
    if (/[가-힣]/.test(text) && text.replace(/\s/g, "").length >= 4 &&
        !genericDescription.test(text) && !optionDescription.test(text) &&
        descriptiveIdentity(text))
      result.push({ text, priority: 1, model: false });
  }
  return result.sort((a, b) => b.priority - a.priority || b.text.length - a.text.length);
}

function expression(term: Term): RegExp {
  const bare = term.model ? term.text.replace(/^BD[\s-]+/i, "") : term.text;
  const brand = term.model && /^[A-Za-z0-9]/.test(bare)
    ? "(?:BD[\\s-]*)?" : "";
  const spelling = [...bare].map(char =>
    /\s/.test(char) ? "\\s*" : char === "/" ? "\\s*\\/\\s*" : escape(char),
  ).join("");
  // An embedded hyphen or digit must not be silently removed.
  return new RegExp("(?<![A-Za-z0-9-])" + brand + spelling +
    "(?![A-Za-z0-9-])", "i");
}

function evidence(
  source: string, product: Product, verifiedBases: ReadonlySet<string>,
): Evidence | null {
  for (const term of terms(product)) {
    const match = expression(term).exec(source);
    if (match) return { match, priority: term.priority };
  }
  const model = scoreModel(product);
  const top = scoreStandTop(product, verifiedBases);
  // A bare 708/709 + a top/color description may refer to the separately
  // registered color suffix models. The base must have a verified top pair.
  if (model && verifiedBases.has(model[1]) &&
      ((isNoHoles(source) && top === "UNPERFORATED") ||
       (!isNoHoles(source) && top === "PERFORATED"))) {
    const match = new RegExp(
      "(?<![A-Za-z0-9-])(?:BD[\\s-]*)?" + model[1] + "(?![A-Za-z0-9-])", "i",
    ).exec(source);
    if (match) return { match, priority: 2 };
  }
  // For other -1 music stands retain the explicit "709 민판" interpretation,
  // but do not manufacture a perforated pair that the catalog cannot prove.
  if (isNoHoles(source) && top === "UNPERFORATED" && model) {
    const match = new RegExp(
      "(?<![A-Za-z0-9-])(?:BD[\\s-]*)?" + model[1] + "(?![A-Za-z0-9-])", "i",
    ).exec(source);
    if (match) return { match, priority: 2 };
  }
  return null;
}

export function productNameEvidence(source: string, product: Product): RegExpExecArray | null {
  return evidence(source, product, new Set())?.match ?? null;
}

const colorWords: Array<[string, RegExp]> = [
  ["Black", /블랙|검정|\bblack\b/i],
  ["Gray", /그레이|회색|\bgr(?:a|e)y\b/i],
  ["White", /화이트|흰색|\bwhite\b/i],
  ["Brown", /브라운|\bbrown\b/i],
];
const writtenColor = (source: string) => {
  // 708 BR and 709 G are explicit catalog color suffixes, not a bare
  // 708/709 default-black order. Keep the code anchored to the model.
  const suffix = source.match(
    /(?<![A-Za-z0-9-])(?:BD[\s-]*)?\d{3}(?:-1)?\s*(BR|BK|G|W)(?![A-Za-z0-9-])/i,
  )?.[1]?.toUpperCase();
  const suffixColors: Record<string, string> = {
    BR: "Brown", BK: "Black", G: "Gray", W: "White",
  };
  return (suffix && suffixColors[suffix]) ||
    colorWords.find(([, pattern]) => pattern.test(source))?.[0];
};
const productColor = (product: Product, color: string) =>
  product.variants.some(variant => variant.color.toLowerCase() === color.toLowerCase()) ||
  colorWords.some(([label, pattern]) => label === color && pattern.test(product.name));

/** Options are positional phrases, not unordered tokens: top 1 and top 2
 * must not be swapped. A whole segment is required ("바퀴 포함" !== "미포함").
 */
function optionEvidenceCount(source: string, product: Product): number {
  return product.name.split(/\s*\/\s*/).slice(1)
    .filter(text => text.trim() &&
      expression({ text: text.trim(), priority: 1, model: false }).test(source)).length;
}

function strongest(source: string, entries: Candidate[]): Product[] {
  if (!entries.length) return [];
  const priority = Math.max(...entries.map(entry => entry.found.priority));
  let result = entries.filter(entry => entry.found.priority === priority);

  if (priority === 2 && result.length > 1) {
    // "MIC holder" must outrank a shorter "Mic" inside the same expression.
    // "708 BR" must outrank the base "708" when BR was expressly supplied.
    const length = Math.max(...result.map(entry =>
      entry.found.match[0].replace(/\s/g, "").length));
    result = result.filter(entry =>
      entry.found.match[0].replace(/\s/g, "").length === length);
  }
  if (result.length > 1 && priority >= 2) {
    const scored = result.map(entry => ({
      ...entry, score: optionEvidenceCount(source, entry.product),
    }));
    const max = Math.max(...scored.map(entry => entry.score));
    if (max > 0) result = scored.filter(entry => entry.score === max);
  }
  // General descriptive fragments do not define a specific product when
  // multiple registered products share the same description.
  if (priority === 1 && result.length > 1) return [];
  return result.map(entry => entry.product);
}

export function registeredNameCandidates(products: Product[], source: string): Product[] {
  const verifiedBases = verifiedScoreStandBases(products);
  const all = products.map(product => ({
    product, found: evidence(source, product, verifiedBases),
  })).filter((entry): entry is Candidate => !!entry.found);
  if (!all.length) return [];

  const nonperforated = isNoHoles(source);
  const perforated = isWithHoles(source);
  const constrained = all.filter(({ product }) => {
    const top = scoreStandTop(product, verifiedBases);
    return nonperforated ? top !== "PERFORATED" :
      perforated ? top !== "UNPERFORATED" : true;
  });
  if (!constrained.length) return [];

  // Only a verified paired music-stand family can infer a colored 709G
  // from bare "709 타공 그레이", or 709-1G from "709 민판 그레이".
  const bareScore = source.match(
    /(?<![A-Za-z0-9-])(?:BD[\s-]*)?(\d{3})(?![-A-Za-z0-9])/i,
  )?.[1];
  if (bareScore && verifiedBases.has(bareScore)) {
    const wantedTop = nonperforated ? "UNPERFORATED" : "PERFORATED";
    const family = constrained.filter(({ product }) =>
      scoreModel(product)?.[1] === bareScore &&
      scoreStandTop(product, verifiedBases) === wantedTop);
    if (family.length) {
      const color = writtenColor(source);
      if (color) {
        const matchingColor = family.filter(({ product }) => productColor(product, color));
        // Never silently substitute the default black product for a
        // requested color which is not registered in this family.
        if (!matchingColor.length) return [];
        return strongest(source, matchingColor);
      }
      const defaultModel = family.filter(({ product }) => {
        const model = scoreModel(product);
        return !!model && !model[3];
      });
      return strongest(source, defaultModel.length ? defaultModel : family);
    }
  }

  return strongest(source, constrained);
}
