/** ExcelJS reads file cells only; all registration decisions belong to Rust.
 * Keep the original TS previewRegistrationWorkbook untouched as the oracle.
 */
import type ExcelJS from "exceljs";
import { REGISTRATION_HEADERS, type RegistrationWorkbookPreview } from "./product-registration-xlsx";
import { businessCoreCall } from "./tauri-bridge";
import type { State } from "./types";

const MAX_ROWS = 2000;
const MAX_BYTES = 20 * 1024 * 1024;
const LEGACY_HEADERS = ["최종 등록명", "제조사 모델코드", ...REGISTRATION_HEADERS.slice(1)];
function text(cell: ExcelJS.Cell): string {
  const value = cell.value;
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    if ("text" in value) return String(value.text ?? "").trim();
    if ("richText" in value) return value.richText.map((item) => item.text).join("").trim();
    return "";
  }
  return String(value).trim();
}

export async function previewNativeRegistrationWorkbook(
  state: State, file: File,
): Promise<RegistrationWorkbookPreview> {
  if (!/\.xlsx$/i.test(file.name)) throw Error(".xlsx 상품 등록 양식만 업로드할 수 있습니다.");
  if (file.size > MAX_BYTES) throw Error("20MB 이하의 등록 양식을 선택하세요.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const excelJs = (await import("exceljs")).default;
  const workbook = new excelJs.Workbook();
  await workbook.xlsx.load(bytes as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  const sheet = workbook.getWorksheet("상품 등록");
  if (!sheet) throw Error("반도허브 등록 양식의 '상품 등록' 시트가 없습니다.");
  const matches = (headers: readonly string[]) =>
    headers.every((header, index) => text(sheet.getRow(1).getCell(index + 1)) === header) &&
    !text(sheet.getRow(1).getCell(headers.length + 1));
  const headers = matches(REGISTRATION_HEADERS) ? REGISTRATION_HEADERS :
    matches(LEGACY_HEADERS) ? LEGACY_HEADERS : undefined;
  if (!headers) throw Error("상품 등록 양식의 열 이름 또는 순서가 다릅니다.");
  if (sheet.rowCount > MAX_ROWS + 1) throw Error("한 번에 최대 2,000행까지 등록할 수 있습니다.");

  const rows: {
    row: number; values: Record<string, string>; unsafeCells: boolean;
  }[] = [];
  for (let i = 2; i <= sheet.rowCount; i++) {
    const cells = headers.map((_, index) => sheet.getRow(i).getCell(index + 1));
    const data = cells.map(text);
    if (!data.some(Boolean)) continue;
    const values: Record<string, string> = {};
    headers.forEach((header, index) => { values[header] = data[index]; });
    rows.push({
      row: i,
      values,
      unsafeCells: cells.some((cell) => cell.isMerged ||
        (typeof cell.value === "object" && cell.value !== null && "formula" in cell.value)),
    });
  }
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const fingerprint = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  const generated = rows.map(() => ({
    productId: crypto.randomUUID(), variantId: crypto.randomUUID(),
    at: new Date().toISOString(),
  }));
  return businessCoreCall<RegistrationWorkbookPreview>(
    "catalog_clients", "preview_registration_rows", { state, rows, generated, fingerprint },
  );
}
