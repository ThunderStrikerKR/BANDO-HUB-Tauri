import type { State } from "./types.js";
export function deleteGroup(input: State, gid: string) {
  const state = structuredClone(input),
    w = state.workflow,
    g = w?.groups.find((g) => g.id === gid);
  if (!w || !g) throw Error("삭제할 묶음을 찾을 수 없습니다.");
  if (g.deletedAt) return state;
  const ships = w.shipments.filter((s) => s.groupId === gid);
  if (
    ships.some((s) => s.transferred || s.step >= 4 || s.delivery) ||
    w.payments.some((p) => p.allocations.some((a) => ships.some((s) => s.id === a.shipmentId)))
  )
    throw Error("입금 확인 / 공장 이관 이후에는 일반 삭제 대신 별도 취소 절차가 필요합니다.");
  g.deletedAt = new Date().toISOString();
  w.events.push({
    id: crypto.randomUUID(),
    at: g.deletedAt,
    actor: state.settings.operatorName || "직원(이름 미설정)",
    action: "묶음 소프트 삭제",
    groupId: gid,
    shipmentIds: ships.map((s) => s.id),
    before: { deletedAt: null },
    after: { deletedAt: g.deletedAt },
  });
  return state;
}
export function restoreGroup(input: State, gid: string) {
  const state = structuredClone(input),
    g = state.workflow?.groups.find((g) => g.id === gid);
  if (!g) throw Error("복원할 묶음이 없습니다.");
  if (!g.deletedAt) return state;
  const before = g.deletedAt;
  delete g.deletedAt;
  state.workflow!.events.push({
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    actor: state.settings.operatorName || "직원(이름 미설정)",
    action: "묶음 복원",
    groupId: gid,
    shipmentIds: state.workflow!.shipments.filter((s) => s.groupId === gid).map((s) => s.id),
    before,
    after: null,
  });
  return state;
}
