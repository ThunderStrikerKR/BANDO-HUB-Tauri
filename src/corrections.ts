import { uid } from "./domain.js";
import { internalModel } from "./matching.js";
import type { Recipient, State } from "./types.js";
import { blocking, orderIssues } from "./validation.js";
import { shipmentContext } from "./workflow.js";
export function correctionStatus(state: State, id: string) {
  return (
    (state.workflow?.events.filter((e) => e.action === "정정 요청 상태" && e.before === id).at(-1)
      ?.after as string) ?? "REGISTERED"
  );
}
function log(state: State, requestId: string, shipmentId: string, status: string) {
  state.workflow!.events.push({
    id: uid(),
    at: new Date().toISOString(),
    actor: state.settings.operatorName || "직원",
    action: "정정 요청 상태",
    shipmentIds: [shipmentId],
    before: requestId,
    after: status,
  });
}
export function requestCorrection(input: State, sid: string, after: Recipient) {
  const state = structuredClone(input),
    ship = state.workflow!.shipments.find((s) => s.id === sid);
  if (!ship || !ship.transferred) throw Error("전달한 배송 건을 선택하세요.");
  if (ship.delivery || ship.collectedAt)
    throw Error("택배 수거 / 배송 이후에는 별도 배송 변경 / 반품 처리가 필요합니다.");
  const ctx = shipmentContext(state, ship);
  if (after.id !== ctx.recipient.id) throw Error("수취인 고유 ID는 변경할 수 없습니다.");
  const current = ctx.recipient;
  if (JSON.stringify(current) === JSON.stringify(after)) throw Error("변경한 내용이 없습니다.");
  const originalOrigins = new Set(current.items.map((i) => i.origin));
  if (after.items.some((i) => !originalOrigins.has(i.origin)))
    throw Error("출고지가 바뀌는 정정은 별도 출고 변경 처리가 필요합니다.");
  if (!ctx.client.shippingFeeExcluded && (after.freightCode ?? ctx.order.freightCode) !== "020")
    for (const origin of new Set(after.items.map((i) => i.origin))) {
      const fee = after.shippingCharges?.[origin] ?? ship.charges[origin];
      if (fee === null || fee === undefined || !Number.isSafeInteger(fee) || fee < 0)
        throw Error("정정 운임을 원 단위 정수로 확인하세요.");
    }
  const issues = orderIssues({ ...ctx.order, recipients: [after] }).filter((i) => blocking(i, 1));
  if (issues.length) throw Error(issues.map((i) => i.title).join("\n"));
  if (
    state.workflow!.changeRequests.some(
      (r) =>
        r.shipmentId === sid &&
        r.afterRecipient &&
        JSON.stringify(r.afterRecipient) === JSON.stringify(after) &&
        correctionStatus(state, r.id) !== "CONFIRMED",
    )
  )
    return state;
  const id = uid();
  state.workflow!.changeRequests.push({
    id,
    shipmentId: sid,
    orderId: ctx.order.id,
    at: new Date().toISOString(),
    actor: state.settings.operatorName || "직원",
    text: "배송 정보 정정 요청",
    beforeRecipient: structuredClone(current),
    afterRecipient: structuredClone(after),
  });
  log(state, id, sid, "REGISTERED");
  return state;
}
export function correctionMessage(state: State, id: string) {
  const request = state.workflow?.changeRequests.find((r) => r.id === id),
    before = request?.beforeRecipient,
    after = request?.afterRecipient;
  if (!request || !before || !after) throw Error("구조화된 정정 요청을 선택하세요.");
  const lines = [
    "기존 출고 건 정정 요청입니다.",
    "배송 ID: " + request.shipmentId,
    "새 출고 주문이 아닙니다.",
  ];
  for (const field of ["name", "address", "mobile", "phone", "note"] as const)
    if (before[field] !== after[field])
      lines.push(
        {
          name: "수취인",
          address: "주소",
          mobile: "휴대폰",
          phone: "전화",
          note: "요청사항",
        }[field] +
          ": " +
          before[field] +
          " → " +
          after[field],
      );
  if (JSON.stringify(before.items) !== JSON.stringify(after.items))
    lines.push(
      "품목: " +
        before.items
          .map((i) => internalModel(i.name) + " (" + i.color + ") × " + i.quantity)
          .join(" / ") +
        " → " +
        after.items
          .map((i) => internalModel(i.name) + " (" + i.color + ") × " + i.quantity)
          .join(" / "),
    );
  for (const origin of ["FACTORY", "STORE"] as const) {
    const oldFee =
        before.shippingCharges?.[origin] ??
        state.workflow?.shipments.find((s) => s.id === request.shipmentId)?.charges[origin],
      newFee = after.shippingCharges?.[origin] ?? oldFee;
    if (oldFee !== newFee)
      lines.push(
        (origin === "FACTORY" ? "공장" : "매장") +
          " 운임: " +
          (oldFee ?? "미확정") +
          " → " +
          (newFee ?? "미확정") +
          "원",
      );
  }
  if (before.freightCode !== after.freightCode)
    lines.push(
      "운임 방식: " + (before.freightCode ?? "010") + " → " + (after.freightCode ?? "010"),
    );
  return lines.join("\n");
}
export function copiedCorrection(input: State, id: string) {
  const state = structuredClone(input),
    r = state.workflow?.changeRequests.find((r) => r.id === id);
  if (!r?.afterRecipient) throw Error("정정 요청을 선택하세요.");
  if (correctionStatus(state, id) === "REGISTERED") log(state, id, r.shipmentId, "PENDING_FACTORY");
  return state;
}
export function confirmCorrection(input: State, id: string) {
  const state = structuredClone(input),
    r = state.workflow?.changeRequests.find((r) => r.id === id);
  if (!r?.afterRecipient || !r.beforeRecipient) throw Error("정정 요청을 선택하세요.");
  if (correctionStatus(state, id) === "CONFIRMED") return state;
  if (correctionStatus(state, id) !== "PENDING_FACTORY")
    throw Error("변경 문구 복사 후 실제 공장 반영을 확인하세요.");
  const ship = state.workflow!.shipments.find((s) => s.id === r.shipmentId)!;
  if (ship.delivery || ship.collectedAt)
    throw Error("택배 수거 이후 별도 배송 변경 / 반품 처리가 필요합니다.");
  const ctx = shipmentContext(state, ship);
  if (JSON.stringify(ctx.recipient) !== JSON.stringify(r.beforeRecipient))
    throw Error("다른 정정이 먼저 반영되었습니다. 최신 내역으로 새 요청을 작성하세요.");
  Object.assign(ctx.recipient, structuredClone(r.afterRecipient));
  ship.latestRecipient = structuredClone(r.afterRecipient);
  if (r.afterRecipient.shippingCharges)
    ship.charges = structuredClone(r.afterRecipient.shippingCharges);
  state.workflow!.events.push({
    id: uid(),
    at: new Date().toISOString(),
    actor: state.settings.operatorName || "직원",
    action: "공장 정정 반영 확인",
    shipmentIds: [ship.id],
    before: structuredClone(r.beforeRecipient),
    after: { requestId: id, recipient: structuredClone(r.afterRecipient) },
  });
  log(state, id, ship.id, "CONFIRMED");
  return state;
}
export function markFactoryDelivered(input: State, sid: string) {
  const state = structuredClone(input),
    ship = state.workflow?.shipments.find((s) => s.id === sid);
  if (!ship) throw Error("배송 건을 선택하세요.");
  const entries = state.workflow!.queue.filter(
    (q) => q.shipmentId === sid && q.origin === "FACTORY" && q.status === "EXPORTED",
  );
  if (!entries.length) throw Error("작성한 공장 엑셀이 없습니다.");
  for (const q of entries) {
    q.fileOnly = false;
    q.factoryDeliveredAt ??= new Date().toISOString();
  }
  if (
    !state.workflow!.events.some(
      (e) => e.action === "공장 전달 직원 확인" && e.shipmentIds.includes(sid),
    )
  )
    state.workflow!.events.push({
      id: uid(),
      at: new Date().toISOString(),
      actor: state.settings.operatorName || "직원",
      action: "공장 전달 직원 확인",
      shipmentIds: [sid],
    });
  return state;
}
export function markCollected(input: State, sid: string) {
  const state = structuredClone(input),
    ship = state.workflow?.shipments.find((s) => s.id === sid);
  if (!ship || !ship.transferred) throw Error("전달한 배송 건을 선택하세요.");
  ship.collectedAt ??= new Date().toISOString();
  return state;
}
export function reopenUnsentExport(input: State, sid: string) {
  const state = structuredClone(input),
    ship = state.workflow?.shipments.find((s) => s.id === sid);
  if (!ship || ship.delivery || ship.collectedAt)
    throw Error("현재 배송 상태에서는 복구할 수 없습니다.");
  // Reverting a factory file must never roll back an independent STORE
  // export or shipment within the same combined order.
  if (state.workflow!.queue.some((q) =>
    q.shipmentId === sid && q.origin === "STORE" &&
    (q.status === "EXPORTED" || q.status === "STORE_SENT"))) {
    throw Error("매장 Excel 출력 또는 발송 이력이 있어 전체 출고를 복구할 수 없습니다.");
  }
  const qs = state.workflow!.queue.filter((q) =>
    q.shipmentId === sid && q.origin === "FACTORY" && q.status === "EXPORTED");
  if (!qs.length || qs.some((q) => q.fileOnly !== true || q.factoryDeliveredAt))
    throw Error("공장 전달 후에는 정정 요청을 사용하세요.");
  for (const q of qs) {
    if (
      !state.exports.some((e) =>
        e.snapshots?.some(
          (s) => s.id === q.id && JSON.stringify(s.snapshot) === JSON.stringify(q.snapshot),
        ),
      )
    )
      throw Error("기존 출력 스냅샷을 보존한 뒤 복구하세요.");
    q.status = "CANCELLED";
  }
  ship.transferred = false;
  ship.step = 0;
  state.workflow!.events.push({
    id: uid(),
    at: new Date().toISOString(),
    actor: state.settings.operatorName || "직원",
    action: "전달 전 출력본 폐기 / 재작성",
    shipmentIds: [sid],
    before: qs.map((q) => q.id),
  });
  return state;
}
