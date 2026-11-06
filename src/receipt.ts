import type { Order, State } from "./types.js";
import { applyOrderRawEdit, reconcileWorkflow } from "./workflow.js";
export function receiptOf(order: Order) {
  return (
    order.receipt ?? {
      original: order.rawHistory?.[0]?.raw ?? order.raw,
      at: order.createdAt,
      actor: "과거 데이터 / 접수 직원 미확인",
      clientId: order.clientId,
      legacy: true,
    }
  );
}
export function correctReceipt(
  input: State,
  order: Order,
  text: string,
  reason: string,
  actor: string,
) {
  if (!reason.trim()) throw Error("붙여넣기 오류 정정 사유를 입력하세요.");
  const state = applyOrderRawEdit(reconcileWorkflow(input, order), order.id, text, actor),
    next = state.orders.find((o) => o.id === order.id)!;
  next.receipt = receiptOf(order);
  next.rawCorrections = [
    ...(order.rawCorrections ?? []),
    {
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      actor,
      reason: reason.trim(),
      before: order.raw,
      after: text,
      affectedRecipientIds: next.recipients.map((r) => r.id),
    },
  ];
  return state;
}
export function ordinaryDeleteIssue(state: State, orderId: string) {
  const ships = state.workflow?.shipments.filter((s) => s.orderId === orderId) ?? [];
  return ships.some((s) => s.transferred || s.step >= 4 || !!s.delivery) ||
    state.workflow?.payments.some((p) =>
      p.allocations.some((a) => ships.some((s) => s.id === a.shipmentId)),
    )
    ? "입금 확인 / 공장 이관 이후에는 일반 삭제 대신 취소 / 반품 절차를 사용하세요."
    : "";
}
