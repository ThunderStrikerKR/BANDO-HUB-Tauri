import { explicitSender } from "../explicit-sender.js";
import { companyClient, companyParty } from "../order-types.js";
import { retailIssues } from "./retail-validation.js";
import { blankOrder } from "../seed.js";
import type { Order, State, OrderType } from "../types.js";
import { stageIssues } from "../workflow.js";

export function newReception(clientId = "", orderType: OrderType = "AGENCY"): Order {
  return { ...blankOrder(clientId), orderType, receptionVersion: 1 };
}
export function replaceReception(order: Order, raw: string): Order {
  if (order.confirmedAt) throw Error("확정된 발주 원문은 변경할 수 없습니다.");
  if (raw.length > 100000) throw Error("발주 원문은 100,000자 이내로 붙여넣어 주세요.");
  return {
    ...newReception(raw.trim() ? order.clientId : "", order.orderType),
    id: order.id,
    clientSnapshot: raw.trim() ? order.clientSnapshot : undefined,
    raw,
    createdAt: order.createdAt,
  };
}
/** Remove temporary preview entities before any unrelated settings/master save. */
export function persistedReceptionState(before: State, proposed: State): State {
  const next = structuredClone(proposed);
  const draftIds = new Set(
    next.orders
      .filter(
        (o) =>
          o.receptionVersion === 1 && !o.confirmedAt && !before.orders.some((b) => b.id === o.id),
      )
      .map((o) => o.id),
  );
  if (!draftIds.size) return next;
  next.orders = next.orders.filter((o) => !draftIds.has(o.id));
  next.queue = next.queue.filter((id) => !draftIds.has(id));
  const w = next.workflow;
  if (w) {
    const sources = new Set(w.sources.filter((s) => draftIds.has(s.orderId)).map((s) => s.id));
    const ships = new Set(w.shipments.filter((s) => draftIds.has(s.orderId)).map((s) => s.id));
    const groups = new Set(w.groups.filter((g) => sources.has(g.sourceId)).map((g) => g.id));
    w.sources = w.sources.filter((s) => !sources.has(s.id));
    w.shipments = w.shipments.filter((s) => !ships.has(s.id));
    w.groups = w.groups.filter((g) => !groups.has(g.id));
    w.events = w.events.filter(
      (e) => !e.shipmentIds.some((id) => ships.has(id)) && (!e.groupId || !groups.has(e.groupId)),
    );
    if (
      w.queue.some((q) => ships.has(q.shipmentId)) ||
      w.payments.some((p) => p.allocations.some((a) => ships.has(a.shipmentId))) ||
      w.confirmations?.some((c) => c.shipmentIds.some((id) => ships.has(id)))
    )
      throw Error("접수 초안에는 입금 / 출고 기록을 만들 수 없습니다.");
  }
  return next;
}
export function validateReceptionBoundary(before: State, next: State) {
  for (const order of next.orders) {
    const previous = before.orders.find((o) => o.id === order.id);
    if (order.orderType && !["AGENCY", "DEALER", "RETAIL"].includes(order.orderType))
      throw Error("주문 유형을 확인하세요.");
    if (!previous && order.orderType === "RETAIL" && order.receptionVersion !== 1)
      throw Error("소매 주문 전용 접수 절차를 사용하세요.");
    if (
      order.receptionVersion === 1 &&
      !previous &&
      (!order.confirmedAt || !order.confirmationSnapshot)
    )
      throw Error("주문 확인 완료 전에는 정식 주문으로 저장할 수 없습니다.");
    if (
      previous?.confirmedAt &&
      (order.confirmedAt !== previous.confirmedAt ||
        order.raw !== previous.raw ||
        JSON.stringify(order.confirmationSnapshot) !==
          JSON.stringify(previous.confirmationSnapshot))
    )
      throw Error("최초 확정 원문 / 시각 / 주문 스냅샷은 변경할 수 없습니다.");
    if (
      previous &&
      (previous.orderType !== order.orderType ||
        JSON.stringify(previous.senderSnapshot) !== JSON.stringify(order.senderSnapshot))
    )
      throw Error("확정 주문의 유형과 송하인 스냅샷은 변경할 수 없습니다.");
    if (order.receptionVersion === 1 && !previous) {
      const expectedSender =
        order.orderType === "DEALER" || order.orderType === "RETAIL"
          ? companyClient(next.settings)
          : (explicitSender(
              order.analysisRaw ?? order.raw,
              next.clients.find((c) => c.id === order.clientId)!,
            ) ?? next.clients.find((c) => c.id === order.clientId));
      if (JSON.stringify(order.senderSnapshot) !== JSON.stringify(expectedSender))
        throw Error("주문 유형에 맞는 송하인 스냅샷을 확인하세요.");
      if (
        order.orderType === "RETAIL" &&
        JSON.stringify(order.clientSnapshot) !== JSON.stringify(companyParty(next.settings))
      )
        throw Error("소매 주문의 주문처는 반도스탠드입니다.");
      if (order.orderType === "RETAIL") {
        const problems = retailIssues(order, next);
        if (problems.length) throw Error(problems.join("\n"));
        if (
          order.clientId ||
          order.raw ||
          order.analysisSnapshot ||
          order.recipients.some((r) => r.items.some((i) => i.unitPrice !== null)) ||
          !order.paid
        )
          throw Error("소매 주문은 별도 판매금액 / 원문 분석 없이 접수하세요.");
      }
      for (const row of order.recipients)
        for (const item of row.items)
          if (
            !next.products.some(
              (product) =>
                product.id === item.productId &&
                !product.deletedAt &&
                product.active !== false &&
                product.variants.some((variant) => variant.id === item.variantId),
            )
          )
            throw Error("등록된 독립 상품과 가격 기록을 확인하세요.");
      const snapshot = order.confirmationSnapshot!;
      if (
        snapshot.raw !== order.raw ||
        !snapshot.data ||
        snapshot.data.id !== order.id ||
        snapshot.data.raw !== order.raw ||
        JSON.stringify(snapshot.data.recipients) !== JSON.stringify(order.recipients) ||
        snapshot.at !== order.confirmedAt ||
        order.receipt?.original !== order.raw ||
        order.receipt.at !== order.confirmedAt ||
        JSON.stringify(snapshot.recipients) !== JSON.stringify(order.recipients) ||
        snapshot.client.id !== order.clientId
      )
        throw Error("정식 주문의 최초 확정 정보를 확인하세요.");
      const ships =
        next.workflow?.shipments.filter((s) => s.orderId === order.id && !s.legacyArchived) ?? [];
      const recipientIds = new Set(ships.map((ship) => ship.recipientId));
      if (order.recipients.some((row) => !recipientIds.has(row.id)))
        throw Error("일부 배송 건을 제외하고 정식 주문으로 저장할 수 없습니다.");
      if (
        !ships.length ||
        ships.some((s) => s.step < 1) ||
        !next.workflow?.events.some(
          (e) =>
            e.action === "주문 확인 완료" &&
            e.shipmentIds.some((id) => ships.some((s) => s.id === id)),
        )
      )
        throw Error("주문 확인 완료 기록이 없습니다.");
      for (const groupId of new Set(ships.map((ship) => ship.groupId))) {
        const issues = stageIssues(next, groupId, 1);
        if (issues.length) throw Error(issues.join("\n"));
      }
    }
  }
}
