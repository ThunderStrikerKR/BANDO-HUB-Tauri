import { normalizeColor, uid, validateProduct, validProductUrl } from "./domain.js";
import type { ImportPreview, Product } from "./types.js";
export const CSV_TEMPLATE =
  "name,category,origin,defaultColor,color,wholesale,semi,retail,url,source,collectedAt\n";
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
/** New CSV imports one complete sale configuration per row; legacy code
 * columns are readable but ignored. Never re-identify a product by code.
 */
export function previewCsv(text: string, existing: Product[]): ImportPreview[] {
  const [headers, ...rows] = csvRows(text);
  if (!headers || !["name", "color", "retail", "source"].every(h=>headers.includes(h)))
    throw Error("CSV 필수 열: name,color,retail,source");
  const seen = new Set<string>();
  const previews: ImportPreview[] = [];
  for (const row of rows) {
    const record = Object.fromEntries(headers.map((h,i)=>[h,row[i]?.trim()??""]));
    if (!record.name) throw Error("상품명을 입력하세요.");
    if (!["MANUAL","OFFICIAL"].includes(record.source))
      throw Error("source는 MANUAL 또는 OFFICIAL이어야 합니다.");
    if (record.source==="OFFICIAL" && (!validProductUrl(record.url)||!record.collectedAt))
      throw Error("공식 가격은 원본 상세페이지 URL과 수집 날짜가 필요합니다.");
    const amount=(value:string)=>{
      if (!value) return null;
      if (!/^\d+$/.test(value)) throw Error("금액은 쉼표 없는 0 이상의 원 단위 정수로 입력하세요.");
      const n=Number(value);
      if (!Number.isSafeInteger(n)) throw Error("가격 범위 초과");
      return n;
    };
    const color=normalizeColor(record.color||"단일");
    const name=record.name;
    const identity=name.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g,"")+"|"+color;
    if (seen.has(identity)) throw Error("상품명과 색상이 같은 CSV 행이 중복되었습니다.");
    seen.add(identity);
    const id=uid();
    const product:Product={
      id,code:id,name,category:record.category??"",
      origin:record.origin==="STORE"?"STORE":"FACTORY",
      defaultColor:color,active:true,
      variants:[{id:uid(),color,wholesale:amount(record.wholesale),
        semi:amount(record.semi),retail:amount(record.retail),
        url:record.url??"",source:record.source as "MANUAL"|"OFFICIAL",
        collectedAt:record.collectedAt||undefined}],
      createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),
    };
    validateProduct(product,[]);
    const matches=existing.filter(p=>
      p.active!==false && !p.deletedAt && !p.supersededBy &&
      p.name.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g,"") ===
        name.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g,"") &&
      p.variants.length===1 && normalizeColor(p.variants[0].color)===color);
    previews.push({
      product,existingId:matches.length===1?matches[0].id:null,
      sourceUrl:product.variants[0].url,
      warnings:matches.length>1
        ? ["같은 상품명과 색상으로 여러 상품이 등록되어 있습니다. 수동 확인이 필요합니다."]
        : matches.length
          ? ["기존 상품과 중복: 회사 입력값은 보존하고 소매가 변경을 개별 승인합니다."]
          : [],
    });
  }
  return previews;
}
