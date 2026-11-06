import { itemFromProduct, parseOrder, unassignedClient } from "../domain.js";
import { addressParts, quantities } from "../parser.js";
import type { Item, Order, Product, Recipient, State } from "../types.js";
import { synchronizeIssueDecisions } from "../validation.js";

export type Cell = { recipientId: string; field: string; itemId?: string };
export type Block = NonNullable<Order["manualClassification"]>["blocks"][number];
export type Assignment = NonNullable<Order["manualClassification"]>["assignments"][string];
export type ManualModel = {
  rows: Recipient[];
  blocks: Block[];
  assignments: Record<string, Assignment>;
};
export const cellKey = (cell: Cell) => `${cell.recipientId}:${cell.itemId ?? ""}:${cell.field}`;
export const validManualQuantity = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
export function newManualRecipient(): Recipient {
  return {
    id: crypto.randomUUID(),
    name: "",
    address: "",
    phone: "",
    mobile: "",
    note: "",
    items: [],
  };
}
export function emptyManualItem(): Item {
  return {
    id: crypto.randomUUID(),
    productId: null,
    variantId: null,
    raw: "",
    name: "",
    color: "",
    quantity: null,
    unitPrice: null,
    origin: "FACTORY",
    defaulted: false,
    issues: [],
    url: "",
    quantityConfirmed: false,
  };
}
export function manualValue(model: ManualModel, cell: Cell): string {
  const r = model.rows.find((r) => r.id === cell.recipientId);
  if (!r) return "";
  if (cell.itemId) {
    const i = r.items.find((i) => i.id === cell.itemId);
    return cell.field === "product" ? (i?.name ?? "") : String(i?.quantity ?? "");
  }
  return String(r[cell.field as "name" | "address" | "mobile" | "phone" | "note"] ?? "");
}
export function initialManual(order: Order): ManualModel {
  if (order.confirmedAt) throw Error("정식 주문은 수동 분류로 변경할 수 없습니다.");
  const rows = structuredClone(order.recipients);
  const spans = rows.flatMap((r) => [
    ...(r.sources ?? []),
    ...(r.candidates ?? []).map((c) => ({
      ...c,
      targetId: r.id,
      text: (order.analysisRaw ?? order.raw).slice(c.start, c.end),
    })),
    ...r.items.flatMap((i) => i.sources ?? []),
    ...(r.unassignedEvidence ?? []).map((c) => ({ ...c, field: c.kind, targetId: r.id })),
  ]);
  for (const candidate of order.analysisEvidence ?? [])
    spans.push({
      ...candidate,
      field: candidate.kind,
      targetId: candidate.itemId ?? candidate.recipientId ?? order.id,
    });
  const blocks: Block[] = [];
  for (const span of spans.sort((a, b) => a.start - b.start || b.end - a.end)) {
    if (
      span.start < 0 ||
      span.end > (order.analysisRaw ?? order.raw).length ||
      span.end <= span.start ||
      blocks.some((b) => span.start < b.end && span.end > b.start)
    )
      continue;
    blocks.push({
      ...span,
      id: `${span.start}:${span.end}`,
      text: (order.analysisRaw ?? order.raw).slice(span.start, span.end),
    });
  }
  const assignments: ManualModel["assignments"] = {};
  for (const block of blocks) {
    const r = rows.find(
      (r) => r.id === block.targetId || r.items.some((i) => i.id === block.targetId),
    );
    if (!r) continue;
    const i = r.items.find((i) => i.id === block.targetId);
    const cell = { recipientId: r.id, itemId: i?.id, field: block.field };
    if (!["name", "address", "mobile", "phone", "note", "product", "quantity"].includes(cell.field))
      continue;
    if (manualValue({ rows, blocks, assignments }, cell))
      assignments[block.id] = { ...cell, value: manualValue({ rows, blocks, assignments }, cell) };
  }
  if (order.manualClassification) {
    return {
      rows,
      blocks: structuredClone(order.manualClassification.blocks),
      assignments: structuredClone(order.manualClassification.assignments),
    };
  }
  return { rows, blocks, assignments };
}
export function setManualValue(
  model: ManualModel,
  cell: Cell,
  value: string,
  state: State,
  order: Order,
  product?: Product,
): ManualModel {
  const next = structuredClone(model),
    r = next.rows.find((r) => r.id === cell.recipientId);
  if (!r) throw Error("배송 행을 선택하세요.");
  if (!cell.itemId) {
    if (!["name", "address", "mobile", "phone", "note"].includes(cell.field))
      throw Error("입력 필드를 확인하세요.");
    r[cell.field as "name" | "address" | "mobile" | "phone" | "note"] = value;
    r.confirmedFields = [...new Set([...(r.confirmedFields ?? []), cell.field])];
    if (cell.field === "address") {
      r.addressParts = addressParts(value);
      r.addressStatus = undefined;
    }
    return next;
  }
  const index = r.items.findIndex((i) => i.id === cell.itemId);
  if (index < 0) throw Error("상품 행을 선택하세요.");
  const old = r.items[index];
  if (cell.field === "quantity") {
    const trimmed = value.trim(),
      matches = quantities(trimmed);
    const quantity = /^\d+$/.test(trimmed)
      ? Number(trimmed)
      : matches.length === 1 && matches[0].start === 0 && matches[0].end === trimmed.length
        ? matches[0].value
        : undefined;
    old.quantity = validManualQuantity(quantity) ? quantity : null;
    old.quantityConfirmed = validManualQuantity(quantity);
    delete old.quantityApproval;
    old.issues = old.issues.filter((s) => !s.includes("수량"));
  } else if (cell.field === "product") {
    const client = state.clients.find((c) => c.id === order.clientId) ?? unassignedClient;
    const parsed = product
      ? [itemFromProduct(product, client, undefined, null)]
      : parseOrder(value, client, state).flatMap((r) => r.items);
    if (parsed.length > 1) throw Error("상품 셀에는 상품 하나를 입력하세요.");
    const item = parsed[0] ?? { ...emptyManualItem(), raw: value, name: value };
    r.items[index] = {
      ...item,
      id: old.id,
      quantity: null,
      quantityConfirmed: false,
      manuallyConfirmed: !!product,
      raw: value,
      sources: [],
    };
    delete r.items[index].quantityApproval;
    for (const [id, a] of Object.entries(next.assignments))
      if (a.itemId === old.id && ["product", "quantity"].includes(a.field))
        delete next.assignments[id];
  } else throw Error("상품 / 수량 필드를 확인하세요.");
  return next;
}
export function assignManualBlock(
  model: ManualModel,
  id: string,
  cell: Cell,
  state: State,
  order: Order,
) {
  if (model.assignments[id]) throw Error("이미 배정한 블록입니다. 먼저 연결을 회수하세요.");
  const block = model.blocks.find((b) => b.id === id);
  if (!block) throw Error("원문 블록을 확인하세요.");
  const next = setManualValue(model, cell, block.text, state, order);
  for (const [key, a] of Object.entries(next.assignments))
    if (cellKey(a) === cellKey(cell)) delete next.assignments[key];
  next.assignments[id] = { ...cell, value: manualValue(next, cell) };
  return next;
}
export function releaseManualBlock(
  model: ManualModel,
  id: string,
  clear: boolean,
  state: State,
  order: Order,
) {
  const a = model.assignments[id];
  if (!a) return model;
  const next = clear ? setManualValue(model, a, "", state, order) : structuredClone(model);
  delete next.assignments[id];
  return next;
}
export function pendingManualQuantity(model: ManualModel): Cell | undefined {
  for (const r of model.rows) {
    const i = r.items.find(
      (i) =>
        (i.productId || i.name.trim()) &&
        (!validManualQuantity(i.quantity) || i.quantityConfirmed === false),
    );
    if (i) return { recipientId: r.id, itemId: i.id, field: "quantity" };
  }
}
export function applyManual(order: Order, model: ManualModel): Order {
  if (order.confirmedAt) throw Error("정식 주문은 수동 분류로 변경할 수 없습니다.");
  if (pendingManualQuantity(model)) throw Error("선택한 상품의 수량을 먼저 확정하세요.");
  if (!model.rows.length) throw Error("배송 건수를 설정하세요.");
  const next = {
    ...structuredClone(order),
    recipients: structuredClone(model.rows),
    manualClassification: {
      blocks: structuredClone(model.blocks),
      assignments: structuredClone(model.assignments),
    },
    analysisRaw: order.analysisRaw ?? order.raw,
    analysisClientId: order.clientId,
    pricesLocked: false,
  };
  // Old spans no longer define ownership after manual assembly; use the final assignment map.
  for (const r of next.recipients) {
    if (order.orderType) {
      r.dispatchOrigin ??= "FACTORY";
      r.items.forEach((i) => (i.origin = r.dispatchOrigin!));
    }
    delete r.unassignedEvidence;
    r.sources = [];
    for (const i of r.items) i.sources = [];
  }
  for (const [id, a] of Object.entries(model.assignments)) {
    const b = model.blocks.find((b) => b.id === id),
      r = next.recipients.find((r) => r.id === a.recipientId);
    if (!b || !r) continue;
    const span = { ...b, recipientId: r.id, targetId: a.itemId ?? r.id, field: a.field };
    if (a.itemId) r.items.find((i) => i.id === a.itemId)?.sources?.push(span);
    else r.sources!.push(span);
  }
  synchronizeIssueDecisions(next);
  return next;
}
