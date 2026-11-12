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
export function previewCsv(text: string, existing: Product[]): ImportPreview[] {
  const [headers,...rows]=csvRows(text);
  if (!headers || !["name","color","retail","source"].every(h=>headers.includes(h)))
    throw Error("CSV 필수 열: name,color,retail,source");
  const previews: ImportPreview[] = [], seen=new Set<string>();
  for(const row of rows) {
    const rec=Object.fromEntries(headers.map((h,i)=>[h,row[i]?.trim()??""]));
    if(!rec.name) throw Error("상품명이 필요합니다.");
    if(!["MANUAL","OFFICIAL"].includes(rec.source))
      throw Error("source는 MANUAL 또는 OFFICIAL이어야 합니다.");
    if(rec.source==="OFFICIAL" && (!validProductUrl(rec.url)||!rec.collectedAt))
      throw Error("공식 가격은 원본 상세페이지 URL과 수집 날짜가 필요합니다.");
    const price=(raw:string)=>{
      if(!raw)return null;
      if(!/^\d+$/.test(raw))throw Error("가격은 쉼표 없는 정수로 입력하세요.");
      const n=Number(raw);
      if(!Number.isSafeInteger(n)||n<0)throw Error("가격 범위 초과");
      return n;
    };
    const color=normalizeColor(rec.color||"단일");
    const origin: "STORE"|"FACTORY"=rec.origin==="STORE"?"STORE":"FACTORY";
    const key=[rec.name.normalize("NFKC").toLowerCase().replace(/\s+/g," "),
      rec.category,origin,color].join("|");
    if(seen.has(key))throw Error("CSV에 같은 상품명과 판매 구성이 중복되었습니다.");
    seen.add(key);
    const p:Product={
      id:uid(),name:rec.name,category:rec.category||"",origin,
      defaultColor:normalizeColor(rec.defaultColor||color),
      active:true,saleUnit:true,createdAt:new Date().toISOString(),
      updatedAt:new Date().toISOString(),
      variants:[{id:uid(),color,wholesale:price(rec.wholesale),
        semi:price(rec.semi),retail:price(rec.retail),
        url:rec.url||"",source:rec.source as "MANUAL"|"OFFICIAL",
        collectedAt:rec.collectedAt||undefined}],
    };
    const matches=existing.filter(x=>!x.deletedAt && x.active!==false &&
      x.name.normalize("NFKC").toLowerCase().replace(/\s+/g," ")===
        p.name.normalize("NFKC").toLowerCase().replace(/\s+/g," ") &&
      x.category===p.category && x.origin===origin &&
      x.variants.some(v=>normalizeColor(v.color)===color));
    if(matches.length>1)throw Error("동일한 이름의 상품이 여러 개 있습니다. 수동 확인하세요.");
    validateProduct(p,matches.length?[]:existing);
    previews.push({product:p,existingId:matches[0]?.id??null,
      sourceUrl:p.variants[0].url,
      warnings:matches.length?["같은 상품명의 기존 상품이 있습니다. 가격과 구성을 확인하세요."]:[]});
  }
  return previews;
}
