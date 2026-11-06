import type { State, Origin } from "./types.js";
import { actualFreightOf, recordActualFreight } from "./actual-freight.js";
export interface ReplyRow {
  row: number;
  name: string;
  address: string;
  contacts: string[];
  tracking: string;
  actual: number | null;
  issue?: string;
  shipmentId?: string;
  orderId?: string;
  applied?: boolean;
}
export interface FactoryReply {
  resolves?: { id: string; row: number };
  actor?: string;
  id: string;
  filename: string;
  archivedPath?: string;
  businessDate: string;
  at: string;
  rows: ReplyRow[];
  status: "APPLIED" | "REVIEW" | "PARTIAL";
  error?: string;
}
const key = (v: string) =>
  v
    .normalize("NFKC")
    .replace(/[\s(),.\-\[\]]/g, "")
    .toLowerCase();
export function replyNeedsReview(state: State, record: FactoryReply) {
  return (
    !!record.error ||
    record.rows.some(
      (row) =>
        !row.applied &&
        !state.factoryReplies?.some(
          (later) =>
            later.resolves?.id === record.id &&
            later.resolves.row === row.row &&
            later.rows.some((r) => r.applied),
        ),
    )
  );
}
export function connectFactoryReply(input: State, reply: FactoryReply, approveConflicts = false) {
  if (input.factoryReplies?.some((r) => r.id === reply.id)) return structuredClone(input);
  let s = structuredClone(input);
  const record = structuredClone(reply);
  const claimed = new Set<string>();
  for (const row of record.rows) {
    if (row.issue) continue;
    if (
      !row.name ||
      !row.address ||
      !row.contacts.length ||
      !/^\d{8,30}$/.test(row.tracking) ||
      row.actual === null ||
      !Number.isSafeInteger(row.actual) ||
      row.actual < 0
    ) {
      row.issue = "필수 배송정보 / Q열 운송장 / 실제 운임 확인 필요";
      continue;
    }
    const candidates = (s.workflow?.queue ?? [])
      .filter((q) => q.origin === "FACTORY" && q.status === "EXPORTED" && q.snapshot)
      .filter((q) => {
        const r = q.snapshot!.recipient;
        return (
          key(r.name) === key(row.name) &&
          key(r.address) === key(row.address) &&
          row.contacts.some((n) => [r.phone, r.mobile].some((v) => v && key(v) === key(n)))
        );
      });
    const ids = [...new Set(candidates.map((q) => q.shipmentId))];
    if (ids.length !== 1) {
      row.issue = ids.length
        ? "배송 건이 여러 개입니다. 직원 확인 필요"
        : "일치하는 공장 발송 배송 건이 없습니다.";
      continue;
    }
    const ship = s.workflow!.shipments.find((v) => v.id === ids[0])!,
      q = candidates.find((q) => q.shipmentId === ship.id)!;
    row.shipmentId = ship.id;
    row.orderId = ship.orderId;
    if (claimed.has(ship.id)) {
      row.issue = "한 파일에 동일 배송 건 중복 행";
      continue;
    }
    claimed.add(ship.id);
    if (s.workflow!.shipments.some((other) =>
      other.id !== ship.id && other.tracking?.FACTORY === row.tracking
    )) {
      row.issue = "운송장번호가 다른 배송 건에 이미 연결되어 있습니다.";
      continue;
    }
    const tracking = ship.tracking?.FACTORY,
      actual = actualFreightOf(ship, q.snapshot!.recipient, "FACTORY");
    if (
      !approveConflicts &&
      ((tracking && tracking !== row.tracking) || (actual !== null && actual !== row.actual))
    ) {
      row.issue = "기존 송장 / 실제 운임과 충돌합니다. 직원 확인 필요";
      continue;
    }
    const old = { tracking: tracking ?? null, actual };
    s = recordActualFreight(s, ship.id, "FACTORY", row.actual);
    s.workflow!.shipments.find((v) => v.id === ship.id)!.tracking = {
      ...ship.tracking,
      FACTORY: row.tracking,
    };
    s.workflow!.events.push({
      id: crypto.randomUUID(),
      at: record.at,
      actor: record.actor || "공장 회신 Excel",
      action: tracking && tracking !== row.tracking ? "공장 송장 / 운임 정정" : "공장 회신 반영",
      shipmentIds: [ship.id],
      before: old,
      after: { tracking: row.tracking, actual: row.actual, fileId: record.id },
    });
    row.applied = true;
  }
  const applied = record.rows.filter((r) => r.applied).length;
  record.status =
    record.error || record.rows.some((r) => !r.applied)
      ? applied
        ? "PARTIAL"
        : "REVIEW"
      : "APPLIED";
  s.factoryReplies = [...(s.factoryReplies ?? []), record];
  return s;
}
export function dispatchState(s: State, orderId: string) {
  const ships = s.workflow?.shipments.filter((v) => v.orderId === orderId) ?? [];
  return ships.length > 0 &&
    ships.every((ship) => {
      const r = s.orders
        .find((o) => o.id === orderId)
        ?.recipients.find((r) => r.id === ship.recipientId);
      return (
        r &&
        [...new Set(r.items.map((i) => i.origin))].every(
          (origin: Origin) => ship.tracking?.[origin] && actualFreightOf(ship, r, origin) !== null,
        )
      );
    })
    ? "처리 완료"
    : "처리 중";
}
export function trackingMessage(s: State, orderId: string) {
  return (s.workflow?.shipments ?? [])
    .filter((ship) => ship.orderId === orderId)
    .flatMap((ship) => {
      const r = s.orders
        .find((o) => o.id === orderId)
        ?.recipients.find((r) => r.id === ship.recipientId);
      return Object.values(ship.tracking ?? {})
        .filter(Boolean)
        .map((n) => `${r?.name ?? "수취인"} ${n}`);
    })
    .join("\n");
}
