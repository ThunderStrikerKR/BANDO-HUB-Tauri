import type { State } from "./types.js";
import { actualFreightOf } from "./actual-freight.js";

export function factoryConflictConfirmation(state: State, id: string, rowNumber: number): string {
  const source = state.factoryReplies?.find((record) => record.id === id);
  const row = source?.rows.find((entry) => entry.row === rowNumber);
  if (!row || !row.shipmentId || !row.issue?.includes("충돌") || row.applied) {
    throw Error("승인 가능한 회신 충돌 행을 찾지 못했습니다.");
  }
  const ship = state.workflow?.shipments.find((entry) => entry.id === row.shipmentId);
  const recipient = state.orders
    .find((order) => order.id === ship?.orderId)
    ?.recipients.find((entry) => entry.id === ship?.recipientId);
  if (!ship || !recipient) throw Error("원본 배송 건을 찾지 못했습니다.");
  const oldFreight = actualFreightOf(ship, recipient, "FACTORY");
  const amount = (value: number | null) => value === null
    ? "미확인" : value.toLocaleString("ko-KR") + "원";
  return [
    row.row + "행 / " + row.name,
    "기존: " + (ship.tracking?.FACTORY || "미등록") + " / 운임 " + amount(oldFreight),
    "회신: " + row.tracking + " / 운임 " + amount(row.actual),
    "이 한 행만 정정할까요? 기존 값과 원본 파일은 보존됩니다.",
  ].join("\n");
}
