import type { Product } from "./types.js";

/** Model evidence comes from a registered business name, never its legacy code. */
export const normalizedProductName = (name: string) =>
  name.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim();

const escape = (char: string) =>
  /[\\^$.*+?()[\]{}|]/.test(char) ? "\\" + char : char;

const modelLead = (product: Product) => product.name.split(/\s*\/\s*/)[0].trim();
const isScoreStand = (product: Product) => /^보면대(?:\s*>|$)/.test(product.category);
const isNoHoles = (source: string) =>
  /민\s*판|무\s*타공|비\s*타공|구멍\s*(?:없음|없는|안\s*뚫린)/i.test(source);
const isWithHoles = (source: string) =>
  !isNoHoles(source) && /(?:^|[\s/,(])타\s*공|구멍\s*(?:있는|있음|뚫린)/i.test(source);

/** -1 means an unperforated TOP only for Bando score/music stands.
 * Never reinterpret GT-1, SS-1, Desk TS-1 or other non-score models.
 */
export function scoreStandTop(product: Product): "UNPERFORATED" | "PERFORATED" | null {
  if (!isScoreStand(product)) return null;
  const lead = modelLead(product);
  if (!/^(?:BD[\s-]*)?\d{3}(?:-1[A-Za-z]*)?$/i.test(lead)) return null;
  return /^(?:BD[\s-]*)?\d{3}-1[A-Za-z]*$/i.test(lead) ? "UNPERFORATED" : "PERFORATED";
}

/** The initial sale-name segment is a human model expression even when it
 * is alphabetic, Korean or contains digits (Boss101, MusicTrayA4, LP-WA).
 */
export function productModelNames(product: Product): string[] {
  const lead = modelLead(product);
  if (!lead) return [];
  const withoutBrand = lead.replace(/^BD[\s-]+/i, "");
  // The plain BD prefix is optional in customer orders. Do not manufacture
  // a model identifier from an arbitrary hidden code.
  return lead === withoutBrand ? [lead] : [lead, withoutBrand];
}

type Evidence = { match: RegExpExecArray; priority: number };
type Term = { text: string; priority: number; model: boolean };
const genericDescription = /^(?:반도\s*)?(?:보면대|악보대|마이크\s*스탠드|키보드\s*스탠드|건반\s*스탠드|의자|카트)$/i;
const optionDescription = /^(?:블랙|검정|화이트|실버|그레이|브라운|골드|크롬|단일|기본|[A-Z]타입(?:\s*상판)?|타공\s*상판|비타공\s*상판|무타공\s*상판|가방\s*(?:미포함|포함)|바퀴\s*(?:미포함|포함)|\d+(?:\.\d+)?\s*cm)$/i;

function terms(product: Product): Term[] {
  const result: Term[] = [{ text: product.name, priority: 3, model: false }];
  result.push(...productModelNames(product).map(text=>({ text, priority: 2, model: true })));
  for (const segment of product.name.split(/\s*\/\s*/).slice(1)) {
    const text = segment.trim();
    if (/[가-힣]/.test(text) && text.replace(/\s/g, "").length >= 4 &&
        !genericDescription.test(text) && !optionDescription.test(text))
      result.push({ text, priority: 1, model: false });
  }
  return result.sort((a,b)=>b.priority-a.priority || b.text.length-a.text.length);
}

function expression(term: Term): RegExp {
  const bare = term.model ? term.text.replace(/^BD[\s-]+/i, "") : term.text;
  const brand = term.model && /^[A-Za-z0-9]/.test(bare)
    ? "(?:BD[\\s-]*)?" : "";
  const spelling = [...bare].map(char =>
    /\s/.test(char) ? "\\s*" : char === "/" ? "\\s*\\/\\s*" : escape(char),
  ).join("");
  // The hyphen within 709-1, Z-2 and Cart-10 is significant.
  return new RegExp("(?<![A-Za-z0-9-])" + brand + spelling +
    "(?![A-Za-z0-9-])", "i");
}

function evidence(source: string, product: Product): Evidence | null {
  for (const term of terms(product)) {
    const match = expression(term).exec(source);
    if (match) return { match, priority: term.priority };
  }
  // Only a non-perforated SCORE stand can accept "709 민판" as evidence
  // for the distinct registered model "709-1".
  if (isNoHoles(source) && scoreStandTop(product) === "UNPERFORATED") {
    const base = modelLead(product).match(/^(?:BD[\s-]*)?(\d{3})-1[A-Za-z]*$/i)?.[1];
    if (base) {
      const match = new RegExp("(?<![A-Za-z0-9-])(?:BD[\\s-]*)?" + base +
        "(?![A-Za-z0-9-])", "i").exec(source);
      if (match) return { match, priority: 2 };
    }
  }
  return null;
}

export function productNameEvidence(source: string, product: Product): RegExpExecArray | null {
  return evidence(source, product)?.match ?? null;
}

export function registeredNameCandidates(products: Product[], source: string): Product[] {
  const all = products.map(product=>({ product, found: evidence(source,product) }))
    .filter((entry): entry is {product:Product;found:Evidence} => !!entry.found);
  if (!all.length) return [];

  // Configuration proof outranks a shared base model. Never reinterpret
  // perforated 709 as its unperforated 709-1 by stripping the -1 suffix.
  const nonperforated = isNoHoles(source);
  const perforated = isWithHoles(source);
  const constrained = all.filter(({product}) => {
    const top = scoreStandTop(product);
    return (nonperforated ? top !== "PERFORATED" :
            perforated ? top !== "UNPERFORATED" : true);
  });
  if (!constrained.length) return [];

  // For "709 민판" without an explicit color, the independent plain 709-1
  // represents the default black item. The G/BR/W products remain available
  // when the order explicitly asks for their color.
  const bareScore = source.match(/(?<![A-Za-z0-9-])(?:BD[\s-]*)?(\d{3})(?![-A-Za-z0-9])/i)?.[1];
  const scoreCandidates = nonperforated && bareScore
    ? constrained.filter(({product}) =>
        scoreStandTop(product) === "UNPERFORATED" &&
        modelLead(product).match(/^(?:BD[\s-]*)?(\d{3})-1[A-Za-z]*$/i)?.[1] === bareScore)
    : [];
  if (scoreCandidates.length) {
    const explicitColor = /그레이|회색|grey|gray|화이트|흰색|white|브라운|brown|블랙|검정|black/i.test(source);
    const narrowed = explicitColor ? scoreCandidates :
      scoreCandidates.filter(({product}) => /^(?:BD[\s-]*)?\d{3}-1$/i.test(modelLead(product)));
    const candidates = narrowed.length ? narrowed : scoreCandidates;
    const priority = Math.max(...candidates.map(x=>x.found.priority));
    return candidates.filter(x=>x.found.priority===priority).map(x=>x.product);
  }

  const priority = Math.max(...constrained.map(x=>x.found.priority));
  return constrained.filter(x=>x.found.priority===priority).map(x=>x.product);
}
