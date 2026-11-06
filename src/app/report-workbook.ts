import { orderHistory } from "./order-history";
import type { State } from "../types";
import { dailySettlement, type DailySettlementReport, type HistoryRow } from "./settlement-report";

export interface ReportWorkbookData {
  date: string;
  revision: number;
  report: DailySettlementReport;
}
const currency = (amount: number | null) => amount === null ? "미확정" : amount;
const safeCell = (value: string) => value.replace(/^[\s]*([=+@-])/, "'$1");
const style = (sheet: import("exceljs").Worksheet, widths: number[]) => {
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  sheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF303030" } };
  widths.forEach((width, index) => {
    const column = sheet.getColumn(index + 1);
    column.width = width;
    column.numFmt = "@";
  });
};

/** Reports only. No writing to orders, payment allocations, or settlement snapshots. */
export async function exportDailySettlementWorkbook(data: ReportWorkbookData): Promise<number[]> {
  const Excel = (await import("exceljs")).default;
  const book = new Excel.Workbook();
  const report = data.report;
  const summary = book.addWorksheet("일일 결산");
  [
    ["기준", "내용"],
    ["조회 기준일 (한국시간)", data.date],
    ["DB 버전", data.revision],
    ["청구 확정값 합계", report.billedKnown],
    ["청구 미확정 주문", report.billedUnknown],
    ["상품대금 확인분", report.productKnown],
    ["고객 청구 배송비 확인분", report.shippingKnown],
    ["부가세 확인분", report.vatKnown],
    ["당일 계좌 입금액", report.paidCash],
    ["당일 입금 중 배송 건 배분액", report.allocatedCash],
    ["당일 입금 중 미배분액", report.unallocatedCash],
    ["후불 청구액 확인분", report.postpaidKnown],
    ["현재 미수 확인분 (해당일 접수 주문)", report.outstandingKnown],
    ["현재 미수 미확정 주문", report.outstandingUnknown],
    ["공장 실제 운임 확인분 (현재 기록)", report.actualFreightKnown],
    ["실제 운임 미확정 주문", report.freightUnknown],
    ["입금 승인 기록 (현금 수입 미포함)", report.approvedPaymentKnown],
    ["중요 안내", "주문 청구액과 실제 입금액은 발생 시점이 달라 합산하지 않습니다."],
    ["중요 안내", "당일 입금액은 실제 입금일 기준이며, 이전 날짜 접수 주문에 대한 입금도 포함될 수 있습니다."],
    ["중요 안내", "실제 운임은 현재 저장된 공장 회신 값으로, 당일 현금 지출액과 다릅니다."],
    ...report.warnings.map((warning) => ["주의", warning]),
  ].forEach((values) => summary.addRow(values));
  style(summary, [47, 99]);

  const orders = book.addWorksheet("접수 주문");
  orders.addRow(["주문 ID", "접수일", "거래처", "거래 방식", "업무 상태",
    "상품대금", "고객 청구 배송비", "부가세", "청구 합계",
    "실제 입금 배분 누계", "입금 승인 누계 (수입 아님)", "현재 미수",
    "현재 실제 운임", "운임 확인 상태", "과거 주문 날짜 대체", "기존 입금표시 증빙 미확인"]);
  for (const row of report.orderRows) {
    orders.addRow([
      row.orderId, row.date, safeCell(row.clientName), row.paymentTerms, row.status,
      currency(row.subtotal), currency(row.shippingCharge), currency(row.vat),
      currency(row.total), row.paidAllocated, row.paymentApproved,
      currency(row.outstanding), currency(row.freightCost),
      row.freightComplete ? "확인" : "미확인", row.legacyDate ? "예" : "아니오",
      row.cashEvidenceMissing ? "예" : "아니오",
    ]);
  }
  style(orders, [40, 16, 30, 15, 25, 18, 22, 18, 18, 23, 30, 18, 19, 19, 22, 28]);
  const receipts = book.addWorksheet("실제 입금");
  receipts.addRow(["입금 기록 ID", "실제 입금 일시", "거래처", "입금 계좌",
    "실제 입금액", "배송 건 배분액", "미배분액", "입금 메모"]);
  for (const row of report.paymentRows) {
    receipts.addRow([
      row.id, row.paidAt, safeCell(row.dealer), safeCell(row.account),
      row.amount, row.allocated, row.unallocated, safeCell(row.memo),
    ]);
  }
  style(receipts, [40, 30, 30, 50, 19, 19, 19, 47]);
  const bytes = await book.xlsx.writeBuffer();
  return Array.from(new Uint8Array(bytes as ArrayBuffer));
}

export async function exportOrderHistoryWorkbook(
  state: State, historyRows: HistoryRow[],
): Promise<number[]> {
  const Excel = (await import("exceljs")).default;
  const book = new Excel.Workbook();
  const sheet = book.addWorksheet("주문 내역");
  sheet.addRow(["주문 ID", "접수일 (한국시간)", "거래처", "관리 상태",
    "수취인", "상품대금", "고객 청구 배송비", "부가세", "청구 합계", "배송 건 수",
    "입금 확인 주의"]);
  for (const row of historyRows) {
    sheet.addRow([
      row.order.id,
      new Date(row.order.confirmedAt ?? row.order.createdAt).toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" }),
      safeCell(row.client?.name ?? row.order.clientSnapshot?.name ?? "미확인"),
      row.status, safeCell(row.recipients.map((r) => r.name).join(", ")),
      currency(row.billing.subtotal), currency(row.billing.shipping),
      currency(row.billing.vat), currency(row.billing.total), row.shipmentIds.length,
      row.order.paid && !state.workflow?.payments.some((p) => p.allocations.some((a) =>
        row.shipmentIds.includes(a.shipmentId))) ? "입금 표시만 있고 실제 입금 기록 없음" : "",
    ]);
  }
  style(sheet, [40, 21, 31, 27, 43, 18, 23, 18, 18, 16, 46]);
  const guide = book.addWorksheet("안내");
  guide.addRow(["구분", "내용"]);
  guide.addRow(["작성 기준", "현재 저장된 주문과 확정 배송 스냅샷을 기준으로 합니다."]);
  guide.addRow(["금액 확인 필요", "입력 금액 또는 운임이 확정되지 않았으면 미확정으로 표시합니다."]);
  guide.addRow(["입금액", "주문 내역 청구금액은 입금 증빙이 아닙니다. 실제 입금은 일일 결산에서 확인하세요."]);
  guide.addRow(["데이터 관리", "이 파일은 조회 및 보관용이며 재업로드로 주문을 변경하지 않습니다."]);
  style(guide, [29, 105]);
  return Array.from(new Uint8Array(await book.xlsx.writeBuffer() as ArrayBuffer));
}
