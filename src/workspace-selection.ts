import type { State } from "./types";
import type { WorkflowSelection } from "./WorkflowBoard";
export function activeShipments(state: State) {
  return (
    state.workflow?.shipments.filter(
      (s) =>
        !s.transferred &&
        !s.legacyArchived &&
        state.orders.some((o) => o.id === s.orderId && !o.deletedAt) &&
        state.workflow?.groups.some((g) => g.id === s.groupId && !g.deletedAt),
    ) ?? []
  );
}
export function validSelection(state: State, selection?: WorkflowSelection) {
  const ss = activeShipments(state);
  const ship =
    ss.find(
      (s) =>
        s.groupId === selection?.groupId &&
        s.orderId === selection?.orderId &&
        (!selection.shipmentId || s.id === selection.shipmentId),
    ) ?? ss[0];
  return ship ? { orderId: ship.orderId, groupId: ship.groupId, shipmentId: ship.id } : undefined;
}

export function onlyDeletedGroups(state: State, orderId: string) {
  const groups =
    state.workflow?.groups.filter((g) =>
      state.workflow?.shipments.some((s) => s.orderId === orderId && s.groupId === g.id),
    ) ?? [];
  return groups.length > 0 && groups.every((g) => !!g.deletedAt);
}
