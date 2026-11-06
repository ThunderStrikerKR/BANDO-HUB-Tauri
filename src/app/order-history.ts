import { orderClient, statusNames, totals } from "../domain";
import type { State } from "../types";
import { shipmentContext, shipmentTotals } from "../workflow";
import { onlyDeletedGroups } from "../workspace-selection";
export function orderHistory(state: State, query: string, date: string) {
  return state.orders
    .filter(
      (order) =>
        !order.deletedAt &&
        !onlyDeletedGroups(state, order.id) &&
        !(order.receptionVersion === 1 && !order.confirmedAt) &&
        (!date ||
          new Date(order.confirmedAt ?? order.createdAt).toLocaleDateString("en-CA", {
            timeZone: "Asia/Seoul",
          }) === date) &&
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
      return {
        order,
        client,
        recipients,
        total,
        deleted,
        status: deleted
          ? "삭제됨"
          : shipments.length
            ? shipments.some((ship) => !ship.transferred)
              ? `진행 중 ${shipments.filter((ship) => !ship.transferred).length}건`
              : "엑셀 / 발송 목록 이관"
            : statusNames[order.status],
      };
    });
}
