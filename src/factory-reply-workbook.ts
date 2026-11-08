import type ExcelJS from "exceljs";
import { LOGEN_HEADERS } from "./factory-export.js";
import { connectFactoryReply, type FactoryReply, type ReplyRow } from "./factory-replies";
import type { State } from "./types";

/** Factory replies use the original Logen columns A/C/D/E/G and the
 * additional Q waybill column. Never infer a tracking number from A-O. */
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_ROWS = 1000;
// The fixed A:P real-world Logen shipping form plus the Q waybill field.
const STANDARD_REPLY_HEADERS = [...LOGEN_HEADERS, "운송장번호"] as const;

export interface FactoryReplyPreview {
  revision: number;
  reply: FactoryReply;
  rows: ReplyRow[];
  applied: number;
  held: number;
  status: FactoryReply["status"];
}

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
const parseFreight = (text: string): number | null => {
  if (!text) return null;
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(text)) return null;
  const amount = Number(text.replaceAll(",", ""));
  return Number.isSafeInteger(amount) && amount >= 0 ? amount : null;
};
const stableHash = async (bytes: ArrayBuffer) => {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
};
const formatDate = () => new Date().toLocaleDateString("sv-SE");
const validName = (name: string) => /\.xlsx$/i.test(name) && !/[\\/\0]/.test(name);

// Do not infer columns, accept alternative header names, or repair a moved column.
function requireStandardReplySheet(sheet: ExcelJS.Worksheet): void {
  const header = sheet.getRow(1);
  for (let index = 1; index <= STANDARD_REPLY_HEADERS.length; index++) {
    const cell = header.getCell(index);
    cellText(cell); // Reject merged/formula header cells as well as wrong labels.
    const actual = cell.value == null ? "" : cell.text;
    const expected = STANDARD_REPLY_HEADERS[index - 1];
    if (actual !== expected) {
      const column = String.fromCharCode(64 + index);
      throw Error("로젠 회신 양식 불일치: " + column +
        "열 제목은 " + (expected || "(공백)") + "이어야 합니다.");
    }
  }
  for (let index = STANDARD_REPLY_HEADERS.length + 1; index <= header.cellCount; index++) {
    const cell = header.getCell(index);
    cellText(cell);
    if (cell.value != null && cell.text !== "") {
      throw Error("로젠 회신 양식 불일치: Q열 뒤에 추가 열 제목이 있습니다.");
    }
  }
}

export function previewFactoryReply(state: State, reply: FactoryReply): FactoryReplyPreview {
  if (state.factoryReplies?.some((r) => r.id === reply.id)) {
    throw Error("이미 등록된 동일 회신 파일입니다. 회신 이력에서 확인하세요.");
  }
  const next = connectFactoryReply(state, reply);
  const result = next.factoryReplies?.find((r) => r.id === reply.id);
  if (!result) throw Error("공장 회신 미리보기를 생성할 수 없습니다.");
  return {
    revision: state.revision ?? 0, reply: structuredClone(reply),
    rows: result.rows, status: result.status,
    applied: result.rows.filter((r) => r.applied).length,
    held: result.rows.filter((r) => !r.applied).length,
  };
}

export async function parseFactoryReplyWorkbook(state: State, file: File):
  Promise<FactoryReplyPreview> {
  if (!validName(file.name) || file.size <= 0 || file.size > MAX_BYTES) {
    throw Error("10MB 이하의 .xlsx 공장 회신 파일을 선택하세요.");
  }
  const bytes = await file.arrayBuffer();
  const id = "factory-reply-" + await stableHash(bytes);
  const Excel = (await import("exceljs")).default;
  const book = new Excel.Workbook();
  await book.xlsx.load(new Uint8Array(bytes) as unknown as Parameters<typeof book.xlsx.load>[0]);
  const sheet = book.worksheets[0];
  if (!sheet) throw Error("로젠 회신 Excel의 첫 번째 시트를 찾지 못했습니다.");
  requireStandardReplySheet(sheet);
  if (sheet.rowCount - 1 > MAX_ROWS) throw Error("공장 회신은 한 번에 최대 1,000행을 처리합니다.");
  const rows: ReplyRow[] = [];
  for (let i = 2; i <= sheet.rowCount; i++) {
    const row = sheet.getRow(i);
    const reserved = row.getCell(10);
    cellText(reserved);
    if (reserved.value != null && reserved.text !== "") {
      throw Error(i + "행: 표준 양식의 J열은 공백이어야 합니다.");
    }
    for (let index = 18; index <= row.cellCount; index++) {
      const extra = row.getCell(index);
      cellText(extra);
      if (extra.value != null && extra.text !== "") {
        throw Error(i + "행: Q열 뒤의 추가 데이터는 허용하지 않습니다.");
      }
    }
    const relevant = [1, 3, 4, 5, 7, 17];
    const values = relevant.map((column) => cellText(row.getCell(column)));
    if (values.every((value) => value === "")) continue;
    const [name, address, phone, mobile, rawFreight, tracking] = values;
    if (typeof row.getCell(17).value === "number") {
      throw Error(i + "행: 운송장번호가 숫자로 저장되었습니다. 앞자리 0을 보호하려면 텍스트 셀로 입력하세요.");
    }
    const digits = tracking.replace(/[-\s]/g, "");
    const freight = parseFreight(rawFreight);
    const contacts = [phone, mobile].filter(Boolean);
    const issue = !name || !address || !contacts.length
      ? "수하인 이름, 주소 또는 연락처 누락"
      : !/^\d{8,30}$/.test(digits)
        ? "Q열 운송장번호가 없거나 올바르지 않습니다."
        : freight === null
          ? "G열 실제 택배운임은 0 이상의 정수로 입력하세요."
          : undefined;
    rows.push({
      row: i, name, address, contacts, tracking: digits, actual: freight,
      ...(issue ? { issue } : {}),
    });
  }
  if (!rows.length) throw Error("회신 파일에 처리할 배송 행이 없습니다.");
  const trackingCounts = new Map<string, number>();
  for (const row of rows) if (row.tracking) {
    trackingCounts.set(row.tracking, (trackingCounts.get(row.tracking) ?? 0) + 1);
  }
  for (const row of rows) if (row.tracking && (trackingCounts.get(row.tracking) ?? 0) > 1) {
    row.issue = "같은 회신 파일에 운송장번호가 중복됩니다.";
  }
  const reply: FactoryReply = {
    id, filename: file.name, businessDate: formatDate(),
    at: new Date().toISOString(), actor: state.settings.operatorName?.trim() || "직원",
    status: "REVIEW", rows,
  };
  return previewFactoryReply(state, reply);
}

export function applyFactoryReplyPreview(state: State, preview: FactoryReplyPreview):
  { next: State; applied: number; held: number } {
  if ((state.revision ?? 0) !== preview.revision) {
    throw Error("미리보기 이후 DB가 수정되었습니다. 공장 회신 파일을 다시 검토하세요.");
  }
  const current = previewFactoryReply(state, preview.reply);
  const projection = (v: FactoryReplyPreview) => JSON.stringify({
    rows: v.rows, applied: v.applied, held: v.held, status: v.status,
  });
  if (projection(current) !== projection(preview)) {
    throw Error("공장 회신 연결 결과가 달라졌습니다. 최신 데이터를 다시 검토하세요.");
  }
  const next = connectFactoryReply(state, preview.reply);
  return { next, applied: current.applied, held: current.held };
}

/** Explicit human approval is limited to a single previously held conflict.
 * Each override creates a new append-only record and does not rewrite the source. */
export function approveFactoryReplyRow(state: State, replyId: string, rowNumber: number) {
  const original = state.factoryReplies?.find((r) => r.id === replyId);
  const target = original?.rows.find((r) => r.row === rowNumber);
  if (!original || !target?.shipmentId || !target.issue?.includes("충돌") || target.applied) {
    throw Error("직원 정정을 허용하는 충돌 행을 찾지 못했습니다.");
  }
  if (state.factoryReplies?.some((r) => r.resolves?.id === replyId && r.resolves.row === rowNumber)) {
    throw Error("이미 정정된 회신 행입니다.");
  }
  const correction: FactoryReply = {
    id: crypto.randomUUID(), filename: original.filename,
    businessDate: original.businessDate, at: new Date().toISOString(),
    actor: state.settings.operatorName || "직원",
    resolves: { id: replyId, row: rowNumber },
    status: "REVIEW",
    rows: [{ ...structuredClone(target), issue: undefined, applied: false }],
  };
  const next = connectFactoryReply(state, correction, true);
  const resolved = next.factoryReplies?.at(-1);
  if (!resolved || !resolved.rows[0]?.applied || resolved.rows[0].shipmentId !== target.shipmentId) {
    throw Error("배송 건 재검증에 실패했습니다. 운송장과 실제 운임을 확인하세요.");
  }
  return next;
}
