import type ExcelJS from "exceljs";
import type { State } from "./types";
import type { ExcelQueueEntry } from "./workflow-types";

export const LOGEN_HEADERS = [
  "수하인명", "수하인우편번호", "수하인주소", "수하인전화", "수하인핸드폰",
  "택배수량", "택배운임", "운임구분", "품목명", "메시지", "송하인명",
  "(송)우편", "(송)주소1", "(송)전화", "(송)핸드폰",
] as const;

export interface FactoryExportRow {
  queueId: string;
  shipmentId: string;
  orderId: string;
  values: string[];
}
export interface FactoryExportPreview {
  revision: number;
  ids: string[];
  rows: FactoryExportRow[];
}
const trim = (value?: string) => (value ?? "").trim();

function exportRow(state: State, entry: ExcelQueueEntry): FactoryExportRow {
  if (entry.origin !== "FACTORY" || entry.status !== "QUEUED" || !entry.snapshot) {
    throw Error("공장 출력 대기 상태의 배송 건만 선택하세요.");
  }
  const ship = state.workflow?.shipments.find((s) => s.id === entry.shipmentId);
  if (!ship || !ship.transferred || ship.step !== 4 || ship.legacyArchived) {
    throw Error("공장 이관이 완료된 배송 건인지 확인하세요.");
  }
  if (state.exports.some((e) => e.queueEntryIds?.includes(entry.id)) ||
    state.workflow?.queue.some((other) => other !== entry &&
      other.shipmentId === ship.id && other.origin === "FACTORY" &&
      other.status === "EXPORTED")) {
    throw Error("이미 작성한 공장 Excel이 있습니다. 출력 이력을 확인하세요.");
  }
  const order = state.orders.find((o) => o.id === ship.orderId);
  if (!order || order.deletedAt) throw Error("원본 주문을 찾을 수 없습니다.");
  const recipient = entry.snapshot.recipient;
  const sender = entry.snapshot.sender;
  if (!trim(recipient.name) || !trim(recipient.address) ||
    (!trim(recipient.phone) && !trim(recipient.mobile))) {
    throw Error("수취인 성함, 주소, 연락처가 누락되었습니다.");
  }
  if (!trim(sender.name) || !trim(sender.address) ||
    (!trim(sender.phone) && !trim(sender.mobile))) {
    throw Error("대리발송 송하인의 상호, 주소, 연락처가 누락되었습니다.");
  }
  if (!["010", "020"].includes(entry.snapshot.freightCode)) {
    throw Error("운임구분은 010(선불) 또는 020(착불)이어야 합니다.");
  }
  if (!recipient.items.length || recipient.items.some((item) =>
    item.origin !== "FACTORY" || !trim(item.name) ||
    !Number.isSafeInteger(item.quantity) || (item.quantity ?? 0) <= 0)) {
    throw Error("공장 출고 품목명과 수량이 불명확합니다.");
  }
  // A frozen export must already contain the selected SKU's distinguishing
  // information. Never silently fill it from the *current* mutable catalogue,
  // since the catalogue may have changed after the order was approved.
  for (const item of recipient.items) {
    const product = state.products.find((p) => p.id === item.productId);
    if (!product) continue;
    if (product.variants.length > 1) {
      const chosen = product.variants.find((v) => v.id === item.variantId);
      if (!chosen || !trim(chosen.option) ||
          !trim(item.name).includes(trim(chosen.option))) {
        throw Error("공장 출고 품목에 선택 옵션의 구분 표기가 없습니다. 주문 내역을 확인하세요.");
      }
    }
    for (const kind of ["가방", "바퀴"]) {
      const pattern = new RegExp(kind + "\\s*(?:미포함|포함|미장착|장착|없음|있음)");
      if (pattern.test(product.name) && !pattern.test(item.name)) {
        throw Error(kind + " 포함 / 미포함 정보가 출고 품목명에 없습니다. 주문을 확인하세요.");
      }
    }
  }
  const goods = recipient.items.map((item) =>
    trim(item.name) + (trim(item.color) && item.color !== "단일" ? " " + trim(item.color) : "") +
    " " + item.quantity + "개").join(" / ");
  // The factory, not the store, calculates package count and actual postage.
  // Do not guess consignee or sender postal codes from raw addresses.
  const values = [
    trim(recipient.name), "", trim(recipient.address), trim(recipient.phone),
    trim(recipient.mobile), "", "", entry.snapshot.freightCode,
    goods, trim(recipient.note), trim(sender.displayName || sender.name),
    trim(sender.postcode), trim(sender.address), trim(sender.phone), trim(sender.mobile),
  ];
  if (values.length !== LOGEN_HEADERS.length) throw Error("로젠 열 수가 일치하지 않습니다.");
  return { queueId: entry.id, shipmentId: ship.id, orderId: order.id, values };
}

/** Read only frozen, already approved workflow queue records. */
export function previewFactoryExport(state: State, ids: string[]): FactoryExportPreview {
  if (!ids.length || ids.length > 500) throw Error("공장 배송 1~500건을 선택하세요.");
  if (new Set(ids).size !== ids.length) throw Error("중복 선택한 배송 건이 있습니다.");
  const queue = state.workflow?.queue ?? [];
  const claimed = new Set<string>();
  const rows: FactoryExportRow[] = [];
  for (const id of ids) {
    const entry = queue.find((item) => item.id === id);
    if (!entry) throw Error("이전 방식의 주문 또는 존재하지 않는 배송 건입니다. 주문 이관 상태를 확인하세요.");
    const row = exportRow(state, entry);
    if (claimed.has(row.shipmentId)) {
      throw Error("동일 배송 건을 두 번 선택했습니다.");
    }
    claimed.add(row.shipmentId);
    rows.push(row);
  }
  return { revision: state.revision ?? 0, ids: [...ids], rows };
}

export async function createFactoryWorkbook(preview: FactoryExportPreview): Promise<number[]> {
  const Excel = (await import("exceljs")).default;
  const book = new Excel.Workbook();
  const sheet = book.addWorksheet("로젠택배");
  sheet.addRow([...LOGEN_HEADERS]);
  for (const row of preview.rows) sheet.addRow(row.values);
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.autoFilter = { from: "A1", to: "O1" };
  // Shipping identifiers (010/020), phone numbers and postcodes must retain zeros.
  for (const [i, width] of [17, 20, 45, 20, 20, 13, 13, 13, 56, 40, 30, 18, 45, 20, 20].entries()) {
    const column = sheet.getColumn(i + 1);
    column.width = width;
    column.numFmt = "@";
  }
  sheet.getRow(1).font = { bold: true };
  return Array.from(new Uint8Array(await book.xlsx.writeBuffer() as ArrayBuffer));
}

/** Call only after native Save As succeeded; SQLite enforces the revision. */
export function recordFactoryExport(state: State, preview: FactoryExportPreview, savedPath: string) {
  if (!trim(savedPath) || !/\.xlsx$/i.test(savedPath)) throw Error("저장된 Excel 파일 경로가 올바르지 않습니다.");
  if ((state.revision ?? 0) !== preview.revision) {
    throw Error("파일 저장 중 주문 데이터가 변경되었습니다. 저장된 파일은 공장에 전달하지 말고 최신 출고 목록을 다시 확인하세요.");
  }
  const fresh = previewFactoryExport(state, preview.ids);
  if (JSON.stringify(fresh.rows) !== JSON.stringify(preview.rows)) {
    throw Error("출력하려는 배송 내용이 변경되었습니다. 방금 저장한 파일은 공장에 전달하지 마세요.");
  }
  const next = structuredClone(state);
  const stamp = new Date().toISOString();
  const exportId = crypto.randomUUID();
  for (const id of preview.ids) {
    const entry = next.workflow!.queue.find((q) => q.id === id)!;
    entry.status = "EXPORTED";
    entry.exportId = exportId;
    entry.exportedAt = stamp;
    entry.fileOnly = true; // File created, but actual factory delivery needs staff confirmation.
  }
  const filename = savedPath.split(/[/\\]/).at(-1) ?? savedPath;
  next.exports.push({
    id: exportId, at: stamp, filename, savedPath,
    orderIds: [...new Set(preview.rows.map((r) => r.orderId))],
    queueEntryIds: [...preview.ids],
    snapshots: preview.ids.map((id) => structuredClone(next.workflow!.queue.find((q) => q.id === id)!)),
  });
  next.workflow!.events.push({
    id: crypto.randomUUID(), at: stamp, actor: next.settings.operatorName?.trim() || "직원",
    action: "공장 발송 Excel 작성",
    shipmentIds: [...new Set(preview.rows.map((r) => r.shipmentId))],
    after: { exportId, filename },
  });
  return { next, filename, exportId };
}
