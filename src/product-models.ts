import { splitSales } from "./sales.js";
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
  "색상 미표기": "색상 확인 필요",
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
export function productKey(p: Product, code = p.code) {
  return (
    (p.catalog ?? (p.variants.some((v) => v.source === "DEMO") ? "DEMO" : "BANDOSTAND")) +
    "|" +
    compact(normalizeModel(code)) +
    (p.saleUnit ? "|sale:" + p.variants[0].id : "")
  );
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
export function canonicalizeState(input: State) {
  if (registeredProducts(input.products).every((p) => p.saleUnit)) return structuredClone(input);
  const state = structuredClone(input),
    groups = new Map<string, Product>(),
    mapping: Record<string, string> = { ...(state.productMappings ?? {}) };
  const original = state.products;
  state.variantMappings ??= {};
  const sourceToTargets = new Map<string, Set<string>>();
  for (const p of registeredProducts(original))
    for (const originalVariant of p.variants) {
      const v = structuredClone(originalVariant);
      v.siteProductId ??= p.siteId;
      let code = optionModel(v.option ?? "") ?? normalizeModel(p.code);
      const suffix = code.match(/(Black|White|Gray|Grey|Brown|Silver|Blue|Red)$/i);
      if (suffix && colorLabel(suffix[1]) === colorLabel(v.color))
        code = code.slice(0, -suffix[1].length).trim();
      const originalName = p.originalName ?? p.name;
      const trailing = originalName.match(/\)\s*(-[A-Za-z0-9-]+)$/);
      if (trailing && !code.endsWith(trailing[1])) code += trailing[1];
      const composite = originalName.match(
        /\bBD\s*[A-Za-z0-9-]+(?:\s*\+\s*(?:BD\s*)?[A-Za-z0-9-]+)+/i,
      );
      if (composite) code = composite[0];
      if (
        new RegExp(esc(p.code).replace(/\s+/g, "\\s*") + "(?:용|\\s*전용)", "i").test(originalName)
      )
        code = originalName.replace(/^반도스탠드\s*/, "").trim();
      code = normalizeModel(code);
      if (/^(?:P\d{3,}|SITE-)/i.test(code)) code = p.name.replace(/^반도스탠드\s*/, "").trim();
      const key = productKey(p, code);
      let target = groups.get(key);
      if (!target) {
        const same = compact(normalizeModel(p.code)) === compact(code);
        const id = same ? p.id : p.id + "~" + compact(code);
        target = {
          ...p,
          id,
          code,
          catalog:
            p.catalog ?? (p.variants.some((v) => v.source === "DEMO") ? "DEMO" : "BANDOSTAND"),
          name: p.variants.some((v) => v.source === "DEMO") ? "[가상] " + code : code,
          subtitle:
            p.subtitle ??
            subtitle(p.originalName ?? p.name, [
              p.code,
              ...(p.modelCodes ?? []),
              ...p.variants.map((v) => optionModel(v.option ?? "") ?? "").filter(Boolean),
            ]),
          originalName: p.originalName ?? p.name,
          originalCode: p.originalCode ?? p.code,
          variants: [],
          modelCodes: [code],
          modelKey: key,
          siteRefs: [],
          active: true,
          requiresOption: false,
          dataIssues: [],
        };
        delete target.deletedAt;
        delete target.supersededBy;
        groups.set(key, target);
      }
      if (!v.option && colorLabel(v.color) === "색상 확인 필요")
        v.option = subtitle(originalName, [p.code, ...(p.modelCodes ?? [])]);
      if (!target.variants.some((x) => x.id === v.id)) target.variants.push(v);
      target.priceHistory = [
        ...(target.priceHistory ?? []),
        ...(p.priceHistory ?? []).filter(
          (h) => !(target!.priceHistory ?? []).some((t) => t.at === h.at && t.field === h.field),
        ),
      ];
      for (const ref of [p.siteId, ...(p.siteRefs ?? [])].filter((s): s is string => !!s))
        if (!target.siteRefs!.includes(ref)) target.siteRefs!.push(ref);
      mapping[p.id + "|" + v.id] = target.id;
      const targets = sourceToTargets.get(p.id) ?? new Set<string>();
      targets.add(target.id);
      sourceToTargets.set(p.id, targets);
    }
  for (const p of groups.values()) {
    const unique: Variant[] = [];
    for (const v of p.variants) {
      const prior = unique.find(
        (x) =>
          colorLabel(x.color) === colorLabel(v.color) &&
          (x.option ?? "") === (v.option ?? "") &&
          x.wholesale === v.wholesale &&
          x.semi === v.semi &&
          x.retail === v.retail &&
          !state.clients.some(
            (c) =>
              c.overrides[x.id] !== undefined &&
              c.overrides[v.id] !== undefined &&
              c.overrides[x.id] !== c.overrides[v.id],
          ),
      );
      if (prior) {
        prior.legacyIds = [...(prior.legacyIds ?? []), v.id, ...(v.legacyIds ?? [])];
        state.variantMappings![v.id] = prior.id;
      } else unique.push(v);
    }
    p.variants = unique;
    const keys = p.variants.map((v) => colorLabel(v.color) + "|" + (v.option ?? ""));
    if (new Set(keys).size !== keys.length)
      p.dataIssues!.push("동일 색상 / 옵션의 원본이 중복되어 단가 확인 필요");
    p.defaultColor =
      p.variants.find((v) => colorLabel(v.color) === "블랙")?.color ??
      p.variants.find((v) => v.color === p.defaultColor)?.color ??
      p.variants[0].color;
    p.requiresOption =
      !!p.dataIssues!.length ||
      p.variants.filter((v) => colorLabel(v.color) === "색상 확인 필요").length > 1;
  }

  const active = [...groups.values()];
  const ids = new Set(active.map((p) => p.id));
  const archives = original
    .filter((p) => !ids.has(p.id))
    .map((p) =>
      sourceToTargets.has(p.id) ? { ...p, supersededBy: [...sourceToTargets.get(p.id)!][0] } : p,
    );
  state.products = [...active, ...archives];
  state.productMappings = mapping;
  for (const o of state.orders) {
    const c = state.clients.find((c) => c.id === o.clientId);
    if (!o.clientSnapshot && c) o.clientSnapshot = structuredClone(c);
    for (const r of o.recipients)
      for (const i of r.items) {
        const target = mapping[(i.productId ?? "") + "|" + (i.variantId ?? "")];
        if (target && target !== i.productId) {
          i.originalProductId ??= i.productId ?? undefined;
          i.originalModel ??= i.name;
          i.productId = target;
        }
        const variant = state.variantMappings?.[i.variantId ?? ""];
        if (variant) {
          i.originalVariantId ??= i.variantId ?? undefined;
          i.variantId = variant;
        }
      }
  }
  for (const a of state.aliases) {
    const old = original.find((p) => p.id === a.productId);
    if (!old) continue;
    const chosen =
      a.variantId ??
      old.variants.find((v) => v.color === old.defaultColor)?.id ??
      old.variants[0]?.id;
    const target = mapping[a.productId + "|" + chosen];
    if (target) {
      a.productId = target;
      if (chosen) a.variantId = state.variantMappings?.[chosen] ?? chosen;
    }
  }
  for (const c of state.clients)
    for (const [oldId, newId] of Object.entries(state.variantMappings ?? {}))
      if (c.overrides[oldId] !== undefined && c.overrides[newId] === undefined)
        c.overrides[newId] = c.overrides[oldId];
  return splitSales(state);
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
export function siblingOptions(product: Product, products: Product[]) {
  return registeredProducts(products)
    .filter(
      (p) =>
        p.id === product.id ||
        (p.familyKey && p.familyKey === product.familyKey) ||
        p.siteRefs?.some((id) => product.siteRefs?.includes(id)),
    )
    .flatMap((p) =>
      p.variants.map((v) => ({
        product: p,
        variant: v,
        label: (p.id === product.id ? "" : p.code + " / ") + variantLabel(v),
      })),
    );
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
