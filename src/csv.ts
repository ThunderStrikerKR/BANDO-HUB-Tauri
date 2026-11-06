import { normalizeCode, normalizeColor, uid, validateProduct, validProductUrl } from "./domain.js";
import type { ImportPreview, Product } from "./types.js";
export const CSV_TEMPLATE =
  "code,name,category,origin,defaultColor,color,wholesale,semi,retail,url,source,collectedAt\n";
export function csvRows(text: string) {
  const rows: string[][] = [];
  let row: string[] = [],
    cell = "",
    quoted = false;
  const data = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < data.length; i++) {
    const c = data[i];
    if (c === '"') {
      if (quoted && data[i + 1] === '"') {
        cell += '"';
        i++;
      } else quoted = !quoted;
    } else if (c === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if (c === "\n" && !quoted) {
      row.push(cell.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (quoted) throw Error("CSV 따옴표가 닫히지 않았습니다.");
  if (cell || row.length) {
    row.push(cell.replace(/\r$/, ""));
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim()));
}
export function previewCsv(text: string, existing: Product[]): ImportPreview[] {
  const [headers, ...rows] = csvRows(text);
  if (!headers || !["code", "name", "color", "retail", "source"].every((h) => headers.includes(h)))
    throw Error("CSV 필수 열: code,name,color,retail,source");
  const grouped = new Map<string, Product>();
  for (const row of rows) {
    const rec = Object.fromEntries(headers.map((h, i) => [h, row[i]?.trim() ?? ""]));
    if (!["MANUAL", "OFFICIAL"].includes(rec.source))
      throw Error("source는 MANUAL 또는 OFFICIAL이어야 합니다.");
    if (rec.source === "OFFICIAL" && (!validProductUrl(rec.url) || !rec.collectedAt))
      throw Error("공식 가격은 원본 상세페이지 URL과 수집 날짜가 필요합니다.");
    const amount = (value: string) => {
      if (!value) return null;
      if (!/^\d+$/.test(value)) throw Error("금액은 쉼표 없는 0 이상의 원 단위 정수로 입력하세요.");
      const n = Number(value);
      if (!Number.isSafeInteger(n)) throw Error("가격 범위 초과");
      return n;
    };
    const key = normalizeCode(rec.code);
    let p = grouped.get(key);
    if (!p) {
      p = {
        id: uid(),
        code: rec.code,
        name: rec.name,
        category: rec.category ?? "",
        origin: rec.origin === "STORE" ? "STORE" : "FACTORY",
        defaultColor: normalizeColor(rec.defaultColor || rec.color),
        active: true,
        variants: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      grouped.set(key, p);
    }
    p.variants.push({
      id: uid(),
      color: normalizeColor(rec.color),
      wholesale: amount(rec.wholesale),
      semi: amount(rec.semi),
      retail: amount(rec.retail),
      url: rec.url ?? "",
      source: rec.source as "MANUAL" | "OFFICIAL",
      collectedAt: rec.collectedAt || undefined,
    });
  }
  return [...grouped.values()].map((p) => {
    validateProduct(p, []);
    const old = existing.find((x) => normalizeCode(x.code) === normalizeCode(p.code));
    return {
      product: p,
      existingId: old?.id ?? null,
      sourceUrl: p.variants[0].url,
      warnings: old
        ? ["기존 상품과 중복: 회사 입력값은 보존하고 소매가 변경을 개별 승인합니다."]
        : [],
    };
  });
}
