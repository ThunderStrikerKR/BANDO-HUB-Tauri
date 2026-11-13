import type ExcelJS from "exceljs";
import { registeredProducts, saleOption, sortProducts, variantLabel } from "./product-models";
import type { BulkPreview, Product, State, Variant } from "./types";

// The hidden identifiers intentionally match the legacy Electron price workbook.
// Never use row order, an editable name, or a model code as the sole record key.
export const PRICE_HEADERS = [
  "상품명", "상품설명", "상품 색상", "도매가", "반도매가", "소매가",
  "__상품ID", "__가격기록ID", "__외부구성원본", "__색상ID",
] as const;
const LEGACY_PRICE_HEADERS = [...PRICE_HEADERS.slice(0,8),
  "__모델코드", ...PRICE_HEADERS.slice(8)] as const;

export async function exportPriceWorkbook(state: State): Promise<number[]> {
  const excelJs = (await import("exceljs")).default;
  const wb = new excelJs.Workbook();
  const sheet = wb.addWorksheet("상품 가격표");
  sheet.addRow([...PRICE_HEADERS]);
  for (const p of sortProducts(registeredProducts(state.products))) {
    for (const v of p.variants) {
      sheet.addRow([
        p.name, p.subtitle ?? "", saleOption(p, v), v.wholesale, v.semi, v.retail,
        p.id, v.id, v.option ?? "", v.color,
      ]);
    }
  }
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.autoFilter = { from: "A1", to: "J1" };
  sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  sheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF303030" } };
  const widths = [27, 36, 28, 17, 17, 17, 23, 23, 24, 20];
  sheet.columns.forEach((column, i) => {
    column.width = widths[i];
    column.hidden = i >= 6;
    if (i >= 3 && i <= 5) column.numFmt = "#,##0";
  });
  for (let row = 2; row <= sheet.rowCount; row++) {
    for (let col = 4; col <= 6; col++) {
      const letter = String.fromCharCode(64 + col);
      sheet.getCell(row, col).dataValidation = {
        type: "custom",
        allowBlank: true,
        formulae: [`OR(ISBLANK(${letter}${row}),AND(ISNUMBER(${letter}${row}),${letter}${row}>=0,MOD(${letter}${row},1)=0),${letter}${row}="삭제")`],
        showErrorMessage: true,
        errorTitle: "가격 확인",
        error: "0 이상의 원 단위 정수 또는 삭제를 입력하세요.",
      };
    }
  }
  const buf = await wb.xlsx.writeBuffer();
  return Array.from(new Uint8Array(buf as ArrayBuffer));
}

function text(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return "text" in value ? String(value.text).trim() : "";
  return String(value).trim();
}

function rowMatches(p: Product, v: Variant, data: string[]): boolean {
  return data[0] === p.name &&
    data[1] === (p.subtitle ?? "") &&
    (data[2] === saleOption(p, v) || data[2] === variantLabel(v)) &&
    data[8] === (v.option ?? "") && data[9] === v.color;
}

export async function previewPriceWorkbook(state: State, file: File): Promise<BulkPreview> {
  if (file.size > 20 * 1024 * 1024) throw Error("20MB 이하의 가격표 파일을 선택하세요.");
  if (!/\.xlsx$/i.test(file.name)) throw Error(".xlsx 파일만 사용할 수 있습니다.");
  const excelJs = (await import("exceljs")).default;
  const wb = new excelJs.Workbook();
  await wb.xlsx.load(new Uint8Array(await file.arrayBuffer()) as unknown as Parameters<typeof wb.xlsx.load>[0]);
  const sheet = wb.worksheets[0];
  if (!sheet) throw Error("엑셀 시트가 없습니다.");
  const matches=(headers:readonly string[]) =>
    headers.every((header,index)=>text(sheet.getRow(1).getCell(index+1).value)===header) &&
    !text(sheet.getRow(1).getCell(headers.length+1).value);
  const headers=matches(PRICE_HEADERS)?PRICE_HEADERS:
    matches(LEGACY_PRICE_HEADERS)?LEGACY_PRICE_HEADERS:undefined;
  if (!headers) throw Error("반도허브에서 내려받은 가격표 양식과 열이 다릅니다.");
  if (sheet.rowCount > 20001) throw Error("한 번에 최대 2만 행까지 검증할 수 있습니다.");
  const products = structuredClone(state.products);
  const changes: BulkPreview["changes"] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  for (let rowIndex = 2; rowIndex <= sheet.rowCount; rowIndex++) {
    const row = sheet.getRow(rowIndex);
    const cells = headers.map((_, i) => row.getCell(i + 1));
    const rawValues = cells.map((cell) => text(cell.value));
    const values = headers === LEGACY_PRICE_HEADERS
      ? [...rawValues.slice(0,8),...rawValues.slice(9)] : rawValues;
    if (!values.some(Boolean)) continue;
    const issue = (message: string) => errors.push(`${rowIndex}행: ${message}`);
    if (cells.some((cell) => cell.isMerged || (cell.value && typeof cell.value === "object" && "formula" in cell.value))) {
      issue("병합된 셀과 수식은 허용되지 않습니다.");
      continue;
    }
    const id = state.productMappings?.[values[6] + "|" + values[7]] ?? values[6];
    const key = id + "|" + values[7];
    if (seen.has(key)) { issue("상품과 가격기록 ID가 중복된 행입니다."); continue; }
    seen.add(key);
    const product = registeredProducts(products).find((p) => p.id === id);
    const variant = product?.variants.find((v) => v.id === values[7]);
    if (!product || !variant || !rowMatches(product, variant, values)) {
      issue("상품명 또는 숨김 상품/가격 ID가 현재 데이터와 일치하지 않습니다. 최신 가격표를 다시 내려받으세요.");
      continue;
    }
    (["wholesale", "semi", "retail"] as const).forEach((tier, index) => {
      const raw = values[index + 3];
      if (!raw) return; // Blank means keep the current value.
      if (raw !== "삭제" && !/^(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(raw)) {
        issue(`${PRICE_HEADERS[index + 3]}: 가격은 정수 또는 삭제로 입력하세요.`);
        return;
      }
      const parsed = raw === "삭제" ? 0 : Number(raw.replaceAll(",", ""));
      if (!Number.isSafeInteger(parsed) || parsed < 0) { issue("가격은 0 이상의 안전한 정수여야 합니다."); return; }
      const nextPrice = parsed === 0 ? null : parsed;
      const before = variant[tier];
      if (before === nextPrice) return;
      changes.push({
        id: variant.id + ":" + tier,
        label: `${product.name} ${saleOption(product, variant)} / ${["도매가", "반도매가", "소매가"][index]}`,
        before: before === null ? "미등록" : before.toLocaleString("ko-KR"),
        after: nextPrice === null ? "가격 삭제" : nextPrice.toLocaleString("ko-KR"),
        ...(tier === "retail" && variant.officialRetail !== undefined && variant.officialRetail !== nextPrice ? {
          warning: `공식 수집 소매가 ${variant.officialRetail?.toLocaleString("ko-KR") ?? "미확인"}원과 다릅니다.`,
        } : {}),
      });
      variant[tier] = nextPrice;
      product.priceHistory ??= [];
      product.priceHistory.push({ at: new Date().toISOString(), field: `${variant.id}.${tier}`, before, after: nextPrice, source: "XLSX" });
      product.updatedAt = new Date().toISOString();
    });
  }
  return { kind: "prices", changes, errors, products };
}
