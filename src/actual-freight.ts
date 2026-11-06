import type { WorkflowShipment } from "./workflow-types.js";
import type { Recipient } from "./types.js";
import type { Origin, Price, State } from "./types.js";
export const actualFreightOf = (ship: WorkflowShipment, row: Recipient, origin: Origin): Price =>
  Object.hasOwn(ship.actualFreight ?? {}, origin)
    ? (ship.actualFreight?.[origin] ?? null)
    : (row.actualFreight ?? null);
export function recordActualFreight(input: State, id: string, origin: Origin, value: Price) {
  if (
    !["FACTORY", "STORE"].includes(origin) ||
    (value !== null && (!Number.isSafeInteger(value) || value < 0))
  )
    throw Error("실제 운임은 0 이상의 원 단위 정수로 입력하세요.");
  const next = structuredClone(input),
    ship = next.workflow?.shipments.find((s) => s.id === id),
    row = next.orders
      .find((o) => o.id === ship?.orderId)
      ?.recipients.find((r) => r.id === ship?.recipientId);
  if (!ship || !row?.items.some((i) => i.origin === origin))
    throw Error("실제 출고지와 배송 건을 확인하세요.");
  const before = actualFreightOf(ship, row, origin);
  if (before === value) return next;
  ship.actualFreight = { ...ship.actualFreight, [origin]: value };
  next.workflow!.events.push({
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    actor: next.settings.operatorName || "직원",
    action: "실제 출고 운임 입력",
    shipmentIds: [id],
    before,
    after: { origin, amount: value },
  });
  return next;
}
