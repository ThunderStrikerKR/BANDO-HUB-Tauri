import type { Order, State } from "./types.js";
import { orderIssues } from "./validation.js";
import { applyOrderRawEdit } from "./workflow.js";
export function rawCorrectionAllowed(s: State, o: Order) {
  const ids = new Set(s.workflow?.shipments.filter((v) => v.orderId === o.id).map((v) => v.id));
  return (
    s.orders.some((order) => order.id === o.id) &&
    !o.paid &&
    !o.notified &&
    !o.postpaidApproved &&
    o.orderType !== "RETAIL" &&
    orderIssues(o).some(
      (i) =>
        i.severity === "ACTION" &&
        [
          "NAME",
          "ADDRESS",
          "CONTACT",
          "CONTACT_INVALID",
          "MODEL",
          "QUANTITY_MISSING",
          "QUANTITY_INVALID",
          "ITEM",
          "UNASSIGNED_EVIDENCE",
        ].includes(i.kind),
    ) &&
    !s.workflow?.shipments.some(
      (v) => ids.has(v.id) && (v.step >= 2 || v.transferred || v.delivery),
    ) &&
    !s.workflow?.payments.some((p) => p.allocations.some((a) => ids.has(a.shipmentId))) &&
    !s.workflow?.confirmations?.some((c) => c.shipmentIds.some((id) => ids.has(id)))
  );
}
export function correctWorkingRaw(input: State, order: Order, text: string, reason: string) {
  if (!rawCorrectionAllowed(input, order))
    throw Error(
      "원문 정정 대상 오류가 없거나 입금 / 운임 확정 / 출고 이후입니다. 구조화된 변경 절차를 사용하세요.",
    );
  if (!text.trim() || !reason.trim()) throw Error("작업용 원문과 정정 사유를 입력하세요.");
  const actor = input.settings.operatorName || "직원",
    before = order.analysisRaw ?? order.raw;
  if (text === before) throw Error("변경한 내용이 없습니다.");
  const working = structuredClone(input);
  working.orders.find((o) => o.id === order.id)!.raw = before;
  const state = applyOrderRawEdit(working, order.id, text, actor, true),
    next = state.orders.find((o) => o.id === order.id)!;
  next.raw = order.raw;
  next.analysisRaw = text;
  delete next.analysisEvidence;
  delete next.manualClassification;
  next.receipt = order.receipt;
  next.confirmationSnapshot = order.confirmationSnapshot;
  next.confirmedAt = order.confirmedAt;
  next.rawCorrections = [
    ...(order.rawCorrections ?? []),
    {
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      actor,
      reason: reason.trim(),
      before,
      after: text,
      affectedRecipientIds: next.recipients.map((r) => r.id),
    },
  ];
  return state;
}
