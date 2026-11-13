import { orderClient, totals } from "../domain";
import type { State } from "../types";
import { shipmentContext, shipmentTotals } from "../workflow";
import { seoulDate } from "./settlement-report";
import { onlyDeletedGroups } from "../workspace-selection";

export type OrderHistoryStatus =
  | "처리 중"
  | "엑셀 추출 대기"
  | "엑셀 추출 완료"
  | "공장 회신 완료";

/** The display stage is determined by the least-progressed shipment.
 * Transferred means reception was finished, not that the Excel file was saved.
 * Only an applied factory reply with its tracking number closes that stage.
 */
export function orderHistoryStatus(state: State, orderId: string): OrderHistoryStatus {
  const order = state.orders.find((current) => current.id === orderId);
  const shipments = (state.workflow?.shipments ?? []).filter((shipment) =>
    shipment.orderId === orderId &&
    !shipment.legacyArchived &&
    !state.workflow?.groups.find((group) => group.id === shipment.groupId)?.deletedAt
  );
  if (!shipments.length) {
    // Retain the already recorded export state for pre-workflow legacy orders.
    return order?.status === "EXPORTED" ? "엑셀 추출 완료" : "처리 중";
  }
  if (shipments.some((shipment) => !shipment.transferred)) return "처리 중";

  const ids = new Set(shipments.map((shipment) => shipment.id));
  const entries = (state.workflow?.queue ?? []).filter(
    (entry) => ids.has(entry.shipmentId) && entry.status !== "CANCELLED",
  );
  if (shipments.some((shipment) =>
    !entries.some((entry) => entry.shipmentId === shipment.id)
  ) || entries.some((entry) => entry.status === "QUEUED")) {
    return "엑셀 추출 대기";
  }
  if (!entries.every((entry) =>
    entry.status === "EXPORTED" || entry.status === "STORE_SENT"
  )) return "엑셀 추출 대기";

  const factoryEntries = entries.filter((entry) => entry.origin === "FACTORY");
  const replies = (state.factoryReplies ?? []).flatMap((reply) => reply.rows);
  const complete = factoryEntries.length > 0 && factoryEntries.every((entry) => {
    const shipment = shipments.find((current) => current.id === entry.shipmentId);
    const tracking = shipment?.tracking?.FACTORY?.trim();
    return !!tracking && replies.some((row) =>
      row.applied === true && row.shipmentId === entry.shipmentId &&
      row.tracking === tracking
    );
  });
  return complete ? "공장 회신 완료" : "엑셀 추출 완료";
}

export function orderHistory(state: State, query: string, date: string) {
  return state.orders
    .filter(
      (order) =>
        !order.deletedAt &&
        !onlyDeletedGroups(state, order.id) &&
        !(order.receptionVersion === 1 && !order.confirmedAt) &&
        (!date ||
          seoulDate(order.confirmedAt ?? order.createdAt) === date) &&
        ((orderClient(order, state)?.name ?? "") + " " + order.raw)
          .toLocaleLowerCase()
          .includes(query.toLocaleLowerCase()),
    )
    .map((order) => {
      const client = orderClient(order, state),
        deleted = onlyDeletedGroups(state, order.id),
        shipments =
          state.workflow?.shipments.filter(
            (ship) =>
              ship.orderId === order.id &&
              !ship.legacyArchived &&
              !state.workflow?.groups.find((group) => group.id === ship.groupId)?.deletedAt,
          ) ?? [],
        amounts = shipments.map((ship) => shipmentTotals(state, ship).total);
      const total = shipments.length
        ? amounts.every((amount) => amount !== null)
          ? amounts.reduce<number>((sum, amount) => sum + amount!, 0)
          : null
        : client
          ? totals(order, client).total
          : null;
      const recipients = shipments.length
        ? shipments.map((ship) => shipmentContext(state, ship).recipient)
        : order.recipients;
      // All four components share the same workflow snapshot source.
      // Never recompute a shipment's VAT or charge from current catalogue prices.
      const parts = shipments.length
        ? shipments.map((ship) => shipmentTotals(state, ship))
        : client ? [totals(order, client)] : [];
      const component = (key: "subtotal" | "shipping" | "vat" | "total"): number | null =>
        parts.length && parts.every((part) => part[key] !== null)
          ? parts.reduce((acc, part) => acc + part[key]!, 0)
          : null;
      return {
        order,
        client,
        recipients,
        total,
        billing: {
          subtotal: component("subtotal"),
          shipping: component("shipping"),
          vat: component("vat"),
          total: component("total"),
        },
        shipmentIds: shipments.map((ship) => ship.id),
        deleted,
        status: orderHistoryStatus(state, order.id),
      };
    });
}
