import type { State } from "../types";
import type { WorkflowPayment } from "../workflow-types";
import type { orderHistory } from "./order-history";

export type HistoryRow = ReturnType<typeof orderHistory>[number];
export interface SettlementOrderRow {
  orderId: string;
  clientName: string;
  date: string;
  status: string;
  paymentTerms: "선입금" | "후불" | "소매" | "미확인";
  subtotal: number | null;
  shippingCharge: number | null;
  vat: number | null;
  total: number | null;
  paidAllocated: number;
  paymentApproved: number;
  outstanding: number | null;
  freightCost: number | null;
  freightComplete: boolean;
  cashEvidenceMissing: boolean;
  legacyDate: boolean;
  shipmentIds: string[];
}
export interface SettlementPaymentRow {
  id: string;
  paidAt: string;
  dealer: string;
  account: string;
  amount: number;
  allocated: number;
  unallocated: number;
  memo: string;
}
export interface DailySettlementReport {
  date: string;
  revision: number;
  orderRows: SettlementOrderRow[];
  paymentRows: SettlementPaymentRow[];
  billedKnown: number;
  billedUnknown: number;
  productKnown: number;
  shippingKnown: number;
  vatKnown: number;
  paidCash: number;
  allocatedCash: number;
  unallocatedCash: number;
  postpaidKnown: number;
  outstandingKnown: number;
  outstandingUnknown: number;
  actualFreightKnown: number;
  freightUnknown: number;
  approvedPaymentKnown: number;
  warnings: string[];
}

/** Use date parts rather than Intl's locale-specific display format. */
export function seoulDate(value: string | undefined): string {
  if (!value) return "";
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf())) return "";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(parsed);
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return [part("year"), part("month"), part("day")].join("-");
}
const safe = (n: unknown): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const add = (list: number[]) => {
  const total = list.reduce((acc, v) => acc + v, 0);
  if (!Number.isSafeInteger(total)) throw Error("집계 금액이 안전한 정수 범위를 초과했습니다.");
  return total;
};
const paymentRows = (state: State, date: string): SettlementPaymentRow[] => {
  const seen = new Set<string>();
  const output: SettlementPaymentRow[] = [];
  for (const payment of state.workflow?.payments ?? []) {
    if (seoulDate(payment.paidAt) !== date) continue;
    if (seen.has(payment.id)) throw Error("입금 기록 ID가 중복되었습니다. 결산 전에 확인하세요.");
    seen.add(payment.id);
    if (!safe(payment.amount)) throw Error("실제 입금액이 올바르지 않습니다.");
    const allocated = add(payment.allocations.map((a) => {
      if (!safe(a.amount)) throw Error("입금 배분액이 올바르지 않습니다.");
      return a.amount;
    }));
    if (allocated > payment.amount) throw Error("입금 배분액이 실제 입금액보다 큽니다.");
    const client = state.clients.find((c) => c.id === payment.dealerId);
    output.push({
      id: payment.id, paidAt: payment.paidAt,
      dealer: client?.name ?? payment.dealerId,
      account: [payment.account.bank, payment.account.holder, payment.account.number].filter(Boolean).join(" / "),
      amount: payment.amount, allocated, unallocated: payment.amount - allocated,
      memo: payment.memo,
    });
  }
  return output.sort((a, b) => a.paidAt.localeCompare(b.paidAt));
};
function approvedForOrder(state: State, shipmentIds: string[]): number {
  const seen = new Set<string>();
  let result = 0;
  for (const c of state.workflow?.confirmations ?? []) {
    if (seen.has(c.id)) throw Error("입금 승인 기록 ID가 중복되었습니다.");
    seen.add(c.id);
    for (const allocation of c.allocations) {
      if (!shipmentIds.includes(allocation.shipmentId)) continue;
      if ((state.workflow?.events ?? []).some((event) =>
        event.action === "입금 승인 재확인 필요" &&
        event.before === c.id && event.shipmentIds.includes(allocation.shipmentId))) continue;
      if (!safe(allocation.amount)) throw Error("입금 승인 기록에 잘못된 금액이 있습니다.");
      result += allocation.amount;
    }
  }
  if (!Number.isSafeInteger(result)) throw Error("입금 승인 금액이 범위를 초과했습니다.");
  return result;
}
const orderPayments = (state: State, shipmentIds: string[]): number => {
  const payments = state.workflow?.payments ?? [];
  const seen = new Set<string>();
  let paid = 0;
  for (const payment of payments) {
    if (seen.has(payment.id)) throw Error("입금 기록 ID가 중복되었습니다.");
    seen.add(payment.id);
    for (const allocation of payment.allocations) {
      if (!shipmentIds.includes(allocation.shipmentId)) continue;
      if (!safe(allocation.amount)) throw Error("입금 배분액이 올바르지 않습니다.");
      paid += allocation.amount;
    }
  }
  if (!Number.isSafeInteger(paid)) throw Error("입금 배분 합계가 범위를 초과했습니다.");
  return paid;
};
function freightForOrder(state: State, history: HistoryRow) {
  let value = 0;
  let complete = true;
  for (const shipId of history.shipmentIds) {
    const shipment = state.workflow?.shipments.find((s) => s.id === shipId);
    if (!shipment) continue;
    const recipient = history.order.recipients.find((r) => r.id === shipment.recipientId);
    if (!recipient) { complete = false; continue; }
    for (const origin of [...new Set(recipient.items.map((item) => item.origin))]) {
      let cost = shipment.actualFreight?.[origin];
      if (cost === undefined && new Set(recipient.items.map((item) => item.origin)).size === 1) {
        cost = recipient.actualFreight;
      }
      if (!safe(cost)) { complete = false; continue; }
      value += cost;
    }
  }
  if (!history.shipmentIds.length) complete = false;
  if (!Number.isSafeInteger(value)) throw Error("실제 운임의 합계가 범위를 초과했습니다.");
  return { value, complete };
}

/**
 * Two independent clocks:
 * 1. Billed orders on their confirmed reception date (legacy createdAt is marked).
 * 2. Real bank receipts on paidAt, including deposits for orders from older days.
 * The numbers are NOT added together as revenue.
 */
export function dailySettlement(state: State, date: string, historyRows: HistoryRow[]): DailySettlementReport {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || seoulDate(date + "T12:00:00+09:00") !== date) {
    throw Error("결산 날짜를 확인하세요.");
  }
  const orders: SettlementOrderRow[] = historyRows.map((row) => {
    const order = row.order;
    const client = row.client;
    const terms = order.orderType === "RETAIL" ? "소매" :
      (order.clientSnapshot?.payment ?? client?.payment) === "POSTPAID" ? "후불" :
        (order.clientSnapshot?.payment ?? client?.payment) === "PREPAID" ? "선입금" : "미확인";
    const paidAllocated = orderPayments(state, row.shipmentIds);
    const paymentApproved = approvedForOrder(state, row.shipmentIds);
    const freight = freightForOrder(state, row);
    const total = row.billing.total;
    const hasEvidence = !!row.shipmentIds.length;
    const outstanding = total === null || !hasEvidence || terms === "소매"
      ? null : Math.max(0, total - paidAllocated - Math.min(paymentApproved, Math.max(0, total - paidAllocated)));
    return {
      orderId: order.id, clientName: client?.name ?? order.clientSnapshot?.name ?? "거래처 미확인",
      date: seoulDate(order.confirmedAt ?? order.createdAt),
      status: row.status, paymentTerms: terms,
      subtotal: row.billing.subtotal, shippingCharge: row.billing.shipping,
      vat: row.billing.vat, total,
      paidAllocated, paymentApproved, outstanding,
      freightCost: freight.complete ? freight.value : null,
      freightComplete: freight.complete,
      cashEvidenceMissing: !!order.paid && !paidAllocated,
      legacyDate: !order.confirmedAt,
      shipmentIds: [...row.shipmentIds],
    };
  });
  const receipts = paymentRows(state, date);
  const known = (field: "subtotal" | "shippingCharge" | "vat" | "total" | "outstanding" | "freightCost") =>
    add(orders.flatMap((row) => row[field] === null ? [] : [row[field]!]));
  const billedUnknown = orders.filter((row) => row.total === null).length;
  const warnings: string[] = [];
  if (billedUnknown) warnings.push("청구 합계가 미확정된 주문 " + billedUnknown + "건은 금액 합계에서 제외했습니다.");
  if (orders.some((row) => row.legacyDate)) warnings.push("확정일이 없는 과거 주문은 최초 작성일을 기준으로 분류했습니다.");
  if (orders.some((row) => row.cashEvidenceMissing)) warnings.push("기존 입금 완료 표시는 실제 입금 기록이 아니므로 수입에 포함하지 않았습니다.");
  if (orders.some((row) => row.paymentApproved)) warnings.push("입금 승인 기록은 실제 계좌 입금액과 구별하며 현금 입금액에 포함하지 않았습니다.");
  if (orders.some((row) => row.paymentTerms === "소매")) warnings.push("소매 주문은 이 결산에 실제 결제 수단 기록이 없어 별도 입금으로 추정하지 않습니다.");
  if (orders.some((row) => !row.freightComplete)) warnings.push("실제 운임은 현재 기록된 값이며 해당 날짜의 현금 지출액을 의미하지 않습니다.");
  const billedKnown = known("total");
  const paidCash = add(receipts.map((payment) => payment.amount));
  const allocatedCash = add(receipts.map((payment) => payment.allocated));
  const result: DailySettlementReport = {
    date, revision: state.revision ?? 0, orderRows: orders, paymentRows: receipts,
    billedKnown, billedUnknown,
    productKnown: known("subtotal"), shippingKnown: known("shippingCharge"),
    vatKnown: known("vat"), paidCash, allocatedCash,
    unallocatedCash: paidCash - allocatedCash,
    postpaidKnown: add(orders.filter((row) => row.paymentTerms === "후불" && row.total !== null)
      .map((row) => row.total!)),
    outstandingKnown: known("outstanding"),
    outstandingUnknown: orders.filter((row) => row.outstanding === null).length,
    actualFreightKnown: known("freightCost"),
    freightUnknown: orders.filter((row) => !row.freightComplete).length,
    approvedPaymentKnown: add(orders.map((row) => row.paymentApproved)),
    warnings,
  };
  return result;
}
