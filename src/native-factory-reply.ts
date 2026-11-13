/** Real production factory-reply bridge.
 * ExcelJS only decodes XLSX cells; Rust owns row validity, matching,
 * conflict decisions, state transitions and immutable audit history.
 * No TypeScript business-algorithm fallback is allowed.
 */
import type ExcelJS from "exceljs";
import { businessCoreCall } from "./tauri-bridge";
import type { FactoryReplyPreview } from "./factory-reply-workbook";
import type { State } from "./types";

const MAX_BYTES = 10 * 1024 * 1024;
const validName = (name: string) => /\.xlsx$/i.test(name) && !/[\\/\0]/.test(name);
const cellText = (cell: ExcelJS.Cell): string => {
  if (cell.isMerged || cell.type === 6 ||
    (typeof cell.value === "object" && cell.value !== null &&
      ("formula" in cell.value || "sharedFormula" in cell.value))) {
    throw Error("수식이나 병합된 셀은 공장 회신에서 사용할 수 없습니다.");
  }
  const value = cell.value;
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    if ("text" in value) return String(value.text ?? "").trim();
    if ("richText" in value) return value.richText.map((part) => part.text).join("").trim();
    throw Error("공장 회신 셀은 문자 또는 숫자로 입력해야 합니다.");
  }
  return String(value).trim();
};

export interface FactoryReplySourceRow {
  row: number;
  name: string;
  address: string;
  phone: string;
  mobile: string;
  rawFreight: string;
  tracking: string;
  trackingNumeric: boolean;
  reservedJ: boolean;
  extraAfterQ: boolean;
}
export interface FactoryReplySource {
  id: string;
  filename: string;
  sourceRowCount: number;
  sourceRows: FactoryReplySourceRow[];
}

/** Extract fixed Logen A/C/D/E/G/Q cells, with complete J/R+ presence flags.
 * Keep the content semantic validation in Rust, not in this reader.
 */
export async function readFactoryReplyCells(file: File): Promise<FactoryReplySource> {
  if (!validName(file.name) || file.size <= 0 || file.size > MAX_BYTES) {
    throw Error("10MB 이하의 .xlsx 공장 회신 파일을 선택하세요.");
  }
  const bytes = await file.arrayBuffer();
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const id = "factory-reply-" +
    Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  const Excel = (await import("exceljs")).default;
  const book = new Excel.Workbook();
  await book.xlsx.load(new Uint8Array(bytes) as unknown as Parameters<typeof book.xlsx.load>[0]);
  const sheet = book.worksheets[0];
  if (!sheet) throw Error("로젠 회신 Excel의 첫 번째 시트를 찾지 못했습니다.");
  // Reject oversized row maps before materializing thousands of JS objects.
  if (sheet.rowCount - 1 > 1000) throw Error("공장 회신은 한 번에 최대 1,000행을 처리합니다.");
  const sourceRows: FactoryReplySourceRow[] = [];
  for (let i = 2; i <= sheet.rowCount; i++) {
    const row = sheet.getRow(i);
    const j = row.getCell(10);
    cellText(j);
    const reservedJ = j.value != null && j.text !== "";
    let extraAfterQ = false;
    for (let column = 18; column <= row.cellCount; column++) {
      const cell = row.getCell(column);
      cellText(cell);
      if (cell.value != null && cell.text !== "") extraAfterQ = true;
    }
    const [name, address, phone, mobile, rawFreight, tracking] =
      [1, 3, 4, 5, 7, 17].map((column) => cellText(row.getCell(column)));
    sourceRows.push({
      row: i, name, address, phone, mobile, rawFreight, tracking,
      trackingNumeric: typeof row.getCell(17).value === "number",
      reservedJ, extraAfterQ,
    });
  }
  return { id, filename: file.name, sourceRowCount: sheet.rowCount - 1, sourceRows };
}
export async function nativeAnalyzeFactoryReply(
  state: State, file: File,
): Promise<FactoryReplyPreview> {
  const source = await readFactoryReplyCells(file);
  return businessCoreCall<FactoryReplyPreview>("rules", "analyze_factory_reply", {
    state, ...source,
    businessDate: new Date().toLocaleDateString("sv-SE"),
    at: new Date().toISOString(),
    actor: state.settings.operatorName?.trim() || "직원",
  });
}
/** Verify the reviewed projection again against the latest immutable state.
 * Rust supplies the entire candidate; SQLite persists through one onSave.
 */
export async function nativeApplyFactoryReplyPreview(
  state: State, preview: FactoryReplyPreview,
): Promise<{ next: State; applied: number; held: number }> {
  const size = preview.rows.length;
  return businessCoreCall("rules", "apply_factory_reply", {
    state, preview, freightAt: new Date().toISOString(),
    freightEventIds: Array.from({ length: size }, () => crypto.randomUUID()),
    replyEventIds: Array.from({ length: size }, () => crypto.randomUUID()),
  });
}
