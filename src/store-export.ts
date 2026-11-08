import type { State } from "./types.js";
import type { ExcelQueueEntry } from "./workflow-types.js";
import { LOGEN_HEADERS, createFactoryWorkbook } from "./factory-export.js";

export interface StoreExportRow {
  queueId: string;
  shipmentId: string;
  orderId: string;
  values: string[];
}
export interface StoreExportPreview {
  revision: number;
  ids: string[];
  rows: StoreExportRow[];
}
const trim = (value?: string) => (value ?? "").trim();

function storeRow(state: State, entry: ExcelQueueEntry): StoreExportRow {
  if (entry.origin !== "STORE" || entry.status !== "QUEUED" || !entry.snapshot) {
    throw Error("매장 발송 대기 상태의 배송 건만 선택하세요.");
  }
  const ship = state.workflow?.shipments.find((s) => s.id === entry.shipmentId);
  if (!ship || !ship.transferred || ship.step !== 4 || ship.legacyArchived) {
    throw Error("매장 이관이 완료된 배송 건인지 확인하세요.");
  }
  if (state.exports.some((e) => e.queueEntryIds?.includes(entry.id)) ||
    state.workflow?.queue.some((other) => other !== entry &&
      other.shipmentId === ship.id && other.origin === "STORE" &&
      other.status === "EXPORTED")) {
    throw Error("이미 작성한 매장 Excel이 있습니다. 출력 이력을 확인하세요.");
  }
  const order = state.orders.find((o) => o.id === ship.orderId);
  if (!order || order.deletedAt) throw Error("원본 주문을 찾지 못했습니다.");
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
    item.origin !== "STORE" || !trim(item.name) ||
    !Number.isSafeInteger(item.quantity) || (item.quantity ?? 0) <= 0)) {
    throw Error("매장 출고 품목명과 수량이 불명확합니다.");
  }
  const goods = recipient.items.map((item) =>
    trim(item.name) + (trim(item.color) && item.color !== "단일" ? " " + trim(item.color) : "") +
    " " + item.quantity + "개").join(" / ");
  // The store staff supplies parcel counts and actual courier charges.
  // A billed shipping amount is not proof of the actual postage.
  const values = [
    trim(recipient.name), "", trim(recipient.address), trim(recipient.phone),
    trim(recipient.mobile), "", "", entry.snapshot.freightCode,
    goods, "", trim(recipient.note), trim(sender.displayName || sender.name),
    trim(sender.postcode), trim(sender.address), trim(sender.phone), trim(sender.mobile),
  ];
  if (values.length !== LOGEN_HEADERS.length) throw Error("로젠 열 수가 일치하지 않습니다.");
  return { queueId: entry.id, shipmentId: ship.id, orderId: order.id, values };
}

/** Preview immutable, approved STORE queue snapshots only. */
export function previewStoreExport(state: State, ids: string[]): StoreExportPreview {
  if (!ids.length || ids.length > 500) throw Error("매장 배송 1~500건을 선택하세요.");
  if (new Set(ids).size !== ids.length) throw Error("중복 선택한 배송 건이 있습니다.");
  const queue = state.workflow?.queue ?? [];
  const shipmentIds = new Set<string>();
  const rows = ids.map((id) => {
    const entry = queue.find((item) => item.id === id);
    if (!entry) throw Error("존재하지 않거나 이관 전인 매장 배송 건입니다.");
    const row = storeRow(state, entry);
    if (shipmentIds.has(row.shipmentId)) throw Error("동일 배송 건이 두 번 선택됐습니다.");
    shipmentIds.add(row.shipmentId);
    return row;
  });
  return { revision: state.revision ?? 0, ids: [...ids], rows };
}

export async function createStoreWorkbook(preview: StoreExportPreview): Promise<number[]> {
  // The same Logen template is used; the STORE-only preview determines the rows.
  return createFactoryWorkbook(preview);
}

/** Persist only after Save As completes; never mark the parcel as shipped here. */
export function recordStoreExport(state: State, preview: StoreExportPreview, savedPath: string) {
  if (!trim(savedPath) || !/\.xlsx$/i.test(savedPath)) {
    throw Error("저장된 Excel 파일 경로가 올바르지 않습니다.");
  }
  if ((state.revision ?? 0) !== preview.revision) {
    throw Error("파일 저장 중 주문 데이터가 변경됐습니다. 이 파일을 사용하지 말고 매장 출고 목록을 다시 확인하세요.");
  }
  const fresh = previewStoreExport(state, preview.ids);
  if (JSON.stringify(fresh.rows) !== JSON.stringify(preview.rows)) {
    throw Error("출력하려는 매장 배송 내용이 변경됐습니다. 파일을 사용하지 말고 다시 검토하세요.");
  }
  const next = structuredClone(state);
  const stamp = new Date().toISOString();
  const exportId = crypto.randomUUID();
  for (const id of preview.ids) {
    const entry = next.workflow!.queue.find((q) => q.id === id)!;
    entry.status = "EXPORTED";
    entry.exportId = exportId;
    entry.exportedAt = stamp;
    entry.fileOnly = true; // Printed, not yet shipped by store staff.
  }
  const filename = savedPath.split(/[/\\]/).at(-1) ?? savedPath;
  next.exports.push({
    id: exportId, at: stamp, filename, savedPath,
    orderIds: [...new Set(preview.rows.map((r) => r.orderId))],
    queueEntryIds: [...preview.ids],
    snapshots: preview.ids.map((id) =>
      structuredClone(next.workflow!.queue.find((q) => q.id === id)!)),
  });
  next.workflow!.events.push({
    id: crypto.randomUUID(), at: stamp,
    actor: next.settings.operatorName?.trim() || "직원",
    action: "매장 발송 Excel 작성",
    shipmentIds: [...new Set(preview.rows.map((r) => r.shipmentId))],
    after: { exportId, filename },
  });
  return { next, filename, exportId };
}
