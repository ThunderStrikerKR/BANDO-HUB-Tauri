import type { Product, State, Variant } from "./types.js";
const colorAliases: Record<string, string> = {
  gold: "골드",
  "rose gold": "로즈골드",
  "cosmo black": "코스모블랙",
  black: "블랙",
  검정: "블랙",
  블랙: "블랙",
  gray: "그레이",
  grey: "그레이",
  회색: "그레이",
  그레이: "그레이",
  brown: "브라운",
  브라운: "브라운",
  white: "화이트",
  흰색: "화이트",
  화이트: "화이트",
  clear: "클리어",
  클리어: "클리어",
  frost: "프로스트",
  frosted: "프로스트",
  프로스트: "프로스트",
  silver: "실버",
  blue: "블루",
  red: "레드",
  "색상 미표기": "",
};
export const colorLabel = (value: string) => colorAliases[value.trim().toLowerCase()] ?? value;
export const normalizeModel = (value: string) =>
  value
    .trim()
    .replace(/^bd\s*/i, "BD ")
    .replace(/^BD (\d[A-Za-z0-9-]*)$/i, (_, s: string) => "BD " + s.toUpperCase());
const compact = (s: string) => s.toUpperCase().replace(/\s/g, "");
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export function optionModel(value: string): string | undefined {
  const bd = value.match(
    /\bBD\s*(\d[A-Za-z0-9-]*|[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z0-9-]+){0,2})/i,
  );
  if (bd)
    return normalizeModel(
      "BD " + bd[1].replace(/\s+(Black|White|Gray|Brown|Clear|Frost|Silver|Blue|Red).*$/i, ""),
    );
  const numeric = value.match(/^(\d{3}[A-Za-z0-9-]*)(?![A-Za-z0-9-])/);
  return numeric ? normalizeModel("BD " + numeric[1]) : undefined;
}
/** Stable tombstone identity; changing an editable name cannot change product identity. */
export function productKey(p: Product, _legacyCode?: string) {
  return "PRODUCT|" + p.id;
}

export const registeredProducts = (products: Product[]) =>
  products.filter((p) => p.active !== false && !p.deletedAt && !p.supersededBy);
export function variantLabel(v: Variant) {
  let option = v.option ?? "";
  const model = optionModel(option);
  if (model)
    option = option
      .replace(new RegExp(esc(model).replace(/\s+/g, "\\s*"), "ig"), "")
      .replace(new RegExp(esc(model.replace(/^BD\s*/, "")), "ig"), "");
  option = option
    .replace(
      /black|white|gray|grey|brown|clear|frost(?:ed)?|silver|blue|red|블랙|검정|화이트|그레이|브라운|클리어|프로스트/gi,
      "",
    )
    .replace(/[()[\]]/g, "")
    .trim();
  return [colorLabel(v.color), option].filter(Boolean).join(" / ");
}
function subtitle(name: string, models: string[]) {
  let text = name.replace(/반도스탠드|Bandostand/gi, "").replace(/^\s*반도\s*/, "");
  for (const code of [...models].sort((a, b) => b.length - a.length)) {
    const expression = [...compact(code)].map(esc).join("\\s*");
    text = text.replace(
      new RegExp("(?<![A-Za-z0-9-])" + expression + "(?![A-Za-z0-9-])", "ig"),
      "",
    );
    const bare = code.replace(/^BD\s*/, "");
    if (/^\d{3}/.test(bare))
      text = text.replace(
        new RegExp("(?<![A-Za-z0-9-])" + esc(bare) + "(?![A-Za-z0-9-])", "ig"),
        "",
      );
  }
  return text
    .replace(/black|white|gray|grey|brown|clear|frost(?:ed)?/gi, "")
    .replace(/[()[\]/]/g, " ")
    .replace(/\bBD\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
/** Split distinct model codes, merge the same model's colors, keep stable option IDs. */
/** All configurations are registered directly as their own business product.
 * Do not merge products by model code or silently create/select options.
 */
export function canonicalizeState(input: State): State {
  const copy = structuredClone(input);
  for (const p of registeredProducts(copy.products)) {
    if (p.variants.length !== 1) {
      throw Error("독립 상품 규칙 위반: 여러 판매 구성이 하나의 상품에 연결돼 있습니다.");
    }
  }
  return copy;
}
export function sortProducts(products: Product[]) {
  const natural = new Intl.Collator("ko", {
    numeric: true,
    sensitivity: "base",
  });
  return [...products].sort(
    (a, b) =>
      natural.compare(a.catalog ?? "", b.catalog ?? "") ||
      natural.compare(a.category, b.category) ||
      natural.compare(a.name, b.name),
  );
}
/** Related independent products, never nested selectable selling options. */
export function siblingOptions(product: Product, products: Product[]) {
  return registeredProducts(products)
    .filter((p) =>
      p.id === product.id ||
      (p.familyKey && p.familyKey === product.familyKey) ||
      p.siteRefs?.some((id) => product.siteRefs?.includes(id)),
    )
    .map((p) => ({
      product: p,
      variant: p.variants[0],
      label: p.name,
    }));
}
export function canonicalizeProducts(products: Product[]) {
  return registeredProducts(
    canonicalizeState({
      products,
      clients: [],
      orders: [],
      aliases: [],
      queue: [],
      exports: [],
      settings: {
        accounts: [],
        defaultAccountId: "",
        senderName: "",
        senderAddress: "",
        senderPhone: "",
        senderMobile: "",
        rounding: "ROUND",
      },
    }).products,
  );
}

export function saleOption(p: Product, v: Variant = p.variants[0]) {
  return p.saleUnit
    ? p.colorStatus === "NOT_REQUIRED"
      ? ""
      : colorLabel(v.color)
    : variantLabel(v);
}
