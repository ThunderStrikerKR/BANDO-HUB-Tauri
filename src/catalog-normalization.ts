import type { Product } from "./types.js";
import { zProductDisplay } from "./z-product-display.js";
export function normalizedDisplay(p: Product): Product {
  const next = structuredClone(p),
    v = next.variants[0];
  if (["134", "135", "136", "137", "138"].includes(p.siteId ?? "")) {
    const display = zProductDisplay(p);
    return display ? { ...next, ...display } : next;
  }
  const targeted =
    /Cart-\d+|Boss\d+|MISpeech|물림쇠|구즈넥|케이블홀더|Sheet magnetic|1200A|GT-10\b|BL-1500용|LP-WA|뮤직트레이/i.test(
      (p.originalName ?? p.name) + " " + p.code,
    );
  if (
    !targeted ||
    p.catalog === "BANDOMALL" ||
    p.variants.length !== 1 ||
    !p.saleUnit ||
    v.source !== "OFFICIAL"
  )
    return next;
  const option = v.option?.trim(),
    base = (p.originalName || p.name)
      .replace(/색상선택|길이선택|옵션\s*선택|\(4종류\)/g, "")
      .replace(/\s+/g, " ")
      .trim();
  const identifiers = [...base.matchAll(/\b(?:Cart-\d+|Boss\d+)\b/gi)].map((m) => m[0]);
  if (identifiers.length)
    next.modelCodes = [...new Set([...(next.modelCodes ?? []), ...identifiers])];
  if (option && v.siteOptionId) {
    next.originalName ??= p.name;
    const display = option.replace(/검정(?:,\s*블랙)?|Black/gi, "블랙").replace(/Chrome/gi, "크롬");
    next.name = base + " — " + display;
    next.subtitle = display;
  }
  const goose = /구즈넥|MISpeech|마이크물림쇠/i.test(base);
  if (goose) {
    const color = /검정|블랙|Black/i.test(option ?? p.name)
      ? "Black"
      : /실버|Silver/i.test(option ?? p.name)
        ? "Silver"
        : /크롬|Chrome/i.test(option ?? p.name)
          ? "Chrome"
          : !option || !/(?:검정|블랙|크롬|실버|Chrome|Black|Silver)/i.test(option)
            ? "Silver"
            : v.color;
    v.color = color;
    next.defaultColor = color;
    next.colorStatus = "KNOWN";
  }
  if (/Sheet magnetic/i.test(base)) next.isDefaultSale = /Chrome|크롬/i.test(option ?? "");
  if (/Sheet magnetic/i.test(base) && /Chrome|크롬/i.test(option ?? "")) {
    v.color = "Chrome";
    next.defaultColor = "Chrome";
    next.isDefaultSale = true;
    next.colorStatus = "KNOWN";
  }
  if (/MISpeech/i.test(base) && /2개/.test(option ?? "")) next.sellingUnit = "2개 구성";
  return next;
}
