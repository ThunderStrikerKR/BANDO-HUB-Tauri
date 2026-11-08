import type ExcelJS from "exceljs";
import type { State } from "./types";
import { resolveHistoricalProductReference } from "./historical-product-reference.js";
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
    if (!item.productId || !item.variantId) {
      throw Error("과거 주문의 상품 또는 가격 기록 ID가 없습니다. 발송 전 품목을 확인하세요.");
    }
    const linked = resolveHistoricalProductReference(state, item.productId, item.variantId);
    // The recorded original ID is immutable, but the matching current product
    // must be identified by BOTH the former product ID and price-record ID.
    if (item.productId && !linked) {
      const older = state.products.find((p) => p.id === item.productId);
      if (older && older.variants.length !== 1) {
        throw Error("복수 판매 구성이 묶인 옛 상품은 공장 발송할 수 없습니다. 독립 상품을 확인하세요.");
      }
      throw Error("과거 주문의 상품 ID와 가격 기록 ID가 현재 독립 상품에 연결되지 않습니다. 발송 전 확인하세요.");
    }
    const product = linked?.product;
    if (!product) continue;
    if (product.variants.length !== 1) {
      throw Error("복수 판매 구성이 묶인 옛 상품은 공장 발송할 수 없습니다. 독립 상품을 확인하세요.");
    }
    if (item.variantId && item.variantId !== product.variants[0].id) {
      throw Error("공장 출고 상품과 가격 기록의 식별자가 다릅니다.");
    }
    for (const kind of ["가방", "바퀴"]) {
      const pattern = new RegExp(kind + "\\s*(미포함|포함|미장착|장착|없음|있음)");
      const expected = pattern.exec(product.name)?.[1];
      if (!expected) continue;
      const actual = pattern.exec(item.name)?.[1];
      const group = (s: string | undefined) =>
        ["미포함", "미장착", "없음"].includes(s ?? "") ? "EXCLUDED" :
        ["포함", "장착", "있음"].includes(s ?? "") ? "INCLUDED" : "UNKNOWN";
      if (group(expected) !== group(actual)) {
        throw Error(kind + " 포함 / 미포함 정보가 실제 출고 구성과 다릅니다. 주문을 확인하세요.");
      }
    }
    // Never fill missing distinguishing attributes from a mutable catalogue.
    const topType = (text: string) =>
      /비타공\s*상판|무타공\s*상판/.test(text) ? "NONPERFORATED" :
      /타공\s*상판/.test(text) ? "PERFORATED" : null;
    const registeredTop = topType(product.name);
    if (registeredTop && topType(item.name) !== registeredTop) {
      throw Error("상판 타공 / 비타공 구분이 확정된 출고 품목명과 다릅니다.");
    }
    const topStyle = (text: string) => /([AB])타입\s*상판/.exec(text)?.[1] ?? null;
    const expectedStyle = topStyle(product.name);
    if (expectedStyle && topStyle(item.name) !== expectedStyle) {
      throw Error("상판 A/B타입 구분이 확정된 출고 품목명과 다릅니다.");
    }
    if (linked?.via === "HISTORICAL") {
      const color = product.variants[0].color.trim();
      if (color && !["단일", "색상 미표기"].includes(color) &&
          product.name.includes(color) && !item.name.includes(color)) {
        throw Error("과거 주문의 색상 구분이 독립 상품 기록과 일치하는지 확인하세요.");
      }
    }
  }
  // The frozen business-facing product name already contains every identifying attribute.
  // Do not append a second color label to factory Excel.
  const goods = recipient.items.map((item) =>
    trim(item.name) + " " + item.quantity + "개").join(" / ");
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
