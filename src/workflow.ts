import { saleIssues, saleProblem } from "./sale-status.js";
import { actualFreightOf } from "./actual-freight.js";
import { orderParty, senderFor } from "./order-types.js";
import { parseOrder, recommendAccount, totals, uid, unassignedClient, won } from "./domain.js";
import { hubMessages } from "./hub-messages.js";
import { mergeParsedItem } from "./parser.js";
import { ordinaryDeleteIssue } from "./receipt.js";
import { combinationCurrent, recommendShipping, saveCombination } from "./shipping.js";
import type { Account, Order, Origin, Price, Recipient, State } from "./types.js";
import {
  blocking,
  operationalIssue,
  orderIssues,
  synchronizeIssueDecisions,
} from "./validation.js";
import type {
  OrderGroup,
  WorkflowEvent,
  WorkflowShipment,
  WorkflowState,
} from "./workflow-types.js";
const now = () => new Date().toISOString();
const clone = <T>(x: T): T => structuredClone(x);
const amount = (n: unknown): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const sum = (xs: number[]) => {
  const n = xs.reduce((a, b) => a + b, 0);
  if (!amount(n)) throw Error("금액 합계를 확인하세요.");
  return n;
};
export const sourceId = (o: Order) => "source:" + o.id;
export const rootGroupId = (o: Order) => "group:" + o.id;
export const shipmentId = (o: Order, r: Recipient) => "shipment:" + o.id + ":" + r.id;
export function clientChangeIssue(state: State, order: Order, dealerId: string) {
  const w = state.workflow;
  if (!w) return;
  const affected = w.shipments.filter(
    (s) =>
      s.orderId === order.id && w.groups.some((g) => g.id === s.groupId && g.dealerId !== dealerId),
  );
  if (
    affected.some(
      (s) =>
        s.transferred ||
        s.step >= 4 ||
        s.delivery ||
        w.payments.some((p) => p.allocations.some((a) => a.shipmentId === s.id)) ||
        w.queue.some((q) => q.shipmentId === s.id && q.status !== "CANCELLED"),
    )
  )
    return "입금 / 출고 이력이 있는 주문은 거래처를 바로 변경할 수 없습니다. 기존 건을 확인한 뒤 새 주문으로 접수하세요.";
}
export const workflowEmpty = (): WorkflowState => ({
  sources: [],
  groups: [],
  shipments: [],
  payments: [],
  queue: [],
  events: [],
  deliveries: [],
  changeRequests: [],
});
export function shipmentContext(state: State, s: WorkflowShipment) {
  const order = state.orders.find((o) => o.id === s.orderId);
  const recipient = order?.recipients.find((r) => r.id === s.recipientId);
  const client = order ? orderParty(order, state) : undefined;
  if (!order || !recipient || !client)
    throw Error("배송 건의 발주서 / 수취인 / 거래처 연결을 확인하세요.");
  return { order, recipient, client };
}
export function groupShipments(state: State, groupId: string) {
  if (state.workflow?.groups.find((g) => g.id === groupId)?.deletedAt) return [];
  return (
    state.workflow?.shipments.filter(
      (s) =>
        s.groupId === groupId &&
        !s.legacyArchived &&
        !state.orders.find((o) => o.id === s.orderId)?.deletedAt,
    ) ?? []
  );
}
export function groupContext(state: State, id: string) {
  const group = state.workflow?.groups.find((g) => g.id === id);
  if (!group) throw Error("현재 주문 묶음을 찾지 못했습니다.");
  const shipments = groupShipments(state, id);
  if (!shipments.length) throw Error("묶음의 배송 건이 없습니다.");
  const { order, client } = shipmentContext(state, shipments[0]);
  return { group, shipments, order, client };
}
function event(
  state: State,
  action: string,
  shipments: WorkflowShipment[],
  actor: string,
  groupId?: string,
  before?: unknown,
  after?: unknown,
  reason?: string,
) {
  const e: WorkflowEvent = {
    id: uid(),
    at: now(),
    actor,
    action,
    shipmentIds: shipments.map((s) => s.id),
    groupId,
    before,
    after,
    reason,
  };
  state.workflow!.events.push(e);
  return e;
}
function information(order: Order, r: Recipient, c: State["clients"][number]) {
  return JSON.stringify({
    dealer: order.clientId,
    sender: [c.name, c.displayName, c.address, c.phone, c.mobile, c.payment],
    recipient: [r.name, r.address, r.addressStatus, r.phone, r.mobile, r.note],
    items: r.items.map((i) => [
      i.id,
      i.productId,
      i.variantId,
      i.color,
      i.quantity,
      i.quantityConfirmed,
      i.unitPrice,
      i.origin,
      i.issues,
    ]),
  });
}
function origins(r: Recipient) {
  return [...new Set(r.items.map((i) => i.origin))];
}
function freight(state: State, order: Order, r: Recipient) {
  return recommendShipping({ ...order, recipients: [r] }, state);
}
export const shipmentFreightCode = (order: Order, r: Recipient) =>
  r.freightCode ?? order.freightCode;
function feeTotal(s: WorkflowShipment, r: Recipient, order?: Order): Price {
  if (order && shipmentFreightCode(order, r) === "020") return 0;
  const os = origins(r);
  return os.length && os.every((o) => amount(s.charges[o]))
    ? sum(os.map((o) => s.charges[o]!))
    : null;
}
export const shipmentVat = (order: Order, r: Recipient) =>
  r.vatOverride ?? r.vatDefault ?? order.applyVat;
export function shipmentTotals(state: State, s: WorkflowShipment) {
  const frozen = s.transferred
    ? state.workflow?.queue.find((q) => q.shipmentId === s.id && q.status !== "CANCELLED")?.snapshot
    : undefined;
  if (frozen && !s.latestRecipient)
    return {
      subtotal: frozen.subtotal,
      shipping: frozen.shipping,
      vat: frozen.vat,
      total: frozen.total,
    };
  const { order, recipient, client } = shipmentContext(state, s);
  return totals(
    {
      ...order,
      recipients: [recipient],
      freightCode: shipmentFreightCode(order, recipient),
      applyVat: shipmentVat(order, recipient),
      shippingFee: feeTotal(s, recipient, order),
      pricesLocked: false,
      vatAmount: null,
    },
    client,
  );
}
export function orderGrandTotal(state: State, id: string) {
  const values = (state.workflow?.shipments ?? [])
    .filter(
      (s) =>
        s.orderId === id &&
        !s.legacyArchived &&
        !state.workflow?.groups.find((g) => g.id === s.groupId)?.deletedAt,
    )
    .map((s) => shipmentTotals(state, s).total);
  return values.length && values.every((v) => v !== null) ? sum(values as number[]) : null;
}
export function groupTotals(state: State, id: string) {
  const ss = groupShipments(state, id),
    ts = ss.map((s) => shipmentTotals(state, s));
  const total = (key: "subtotal" | "shipping" | "vat" | "total"): Price => {
    if (!ts.length || ts.some((t) => t[key] === null)) return null;
    const value = ts.reduce((sum, t) => sum + t[key]!, 0);
    return amount(value) ? value : null;
  };
  return {
    subtotal: total("subtotal"),
    shipping: total("shipping"),
    vat: total("vat"),
    total: total("total"),
  };
}
export function groupOrder(state: State, id: string) {
  const { group, shipments, order } = groupContext(state, id);
  return {
    ...order,
    recipients: order.recipients.filter((r) => shipments.some((s) => s.recipientId === r.id)),
    shippingFee: groupTotals(state, id).shipping,
    pricesLocked: false,
    vatAmount: null,
    accountMode: group.accountMode ?? order.accountMode,
    accountId: group.accountMode === "MANUAL" ? group.accountId : order.accountId,
  };
}
export function groupAccount(state: State, id: string) {
  const group = state.workflow?.groups.find((g) => g.id === id),
    source = state.workflow?.sources.find((s) => s.id === group?.sourceId),
    order = state.orders.find((o) => o.id === source?.orderId);
  if (order?.deletedAt && group)
    return recommendAccount(
      {
        ...order,
        accountMode: group.accountMode ?? order.accountMode,
        accountId: group.accountMode === "MANUAL" ? group.accountId : order.accountId,
      },
      state.settings,
      state.products,
      state.clients.find((c) => c.id === order.clientId) ?? order.clientSnapshot,
    );
  const active = groupOrder(state, id);
  return recommendAccount(active, state.settings, state.products,
    state.clients.find((c) => c.id === active.clientId) ?? active.clientSnapshot);
}
const accountKey = (a: Account | undefined) =>
  a ? JSON.stringify([a.id, a.bank.trim(), a.number.trim(), a.holder.trim()]) : "";
export function groupMessages(
  state: State,
  id: string,
  links = { payment: false, options: false },
) {
  const o = groupOrder(state, id),
    generated = hubMessages(o, state, id, links);
  const group = state.workflow!.groups.find((g) => g.id === id)!;
  if (
    groupShipments(state, id).some(
      (s) =>
        s.step < 2 &&
        shipmentFreightCode(
          shipmentContext(state, s).order,
          shipmentContext(state, s).recipient,
        ) !== "020",
    )
  )
    generated.paymentIssues.push("배송 건별 운임 적용 단계 확인 필요");
  generated.payment = group.messageEdits?.payment ?? generated.payment;
  generated.options = group.messageEdits?.options ?? generated.options;
  return generated;
}
function billing(state: State, s: WorkflowShipment) {
  return JSON.stringify({
    info: s.infoSignature,
    fees: s.charges,
    vat: shipmentVat(shipmentContext(state, s).order, shipmentContext(state, s).recipient),
    account: accountKey(groupAccount(state, s.groupId)),
    ...(shipmentFreightCode(
      shipmentContext(state, s).order,
      shipmentContext(state, s).recipient,
    ) === "020"
      ? { collect: true }
      : {}),
  });
}

function clearGroupMessages(_state: State, _id: string) {}
function revokeConfirmations(state: State, ids: string[]) {
  const remove = new Set(ids);
  let revoked = false;
  state.workflow!.confirmations = (state.workflow!.confirmations ?? []).flatMap((c) => {
    if (
      state.workflow!.events.some(
        (e) => e.action === "입금 승인 재확인 필요" && e.before === c.id,
      ) ||
      !c.shipmentIds.some((id) => remove.has(id))
    )
      return [c];
    revoked = true;
    const left = c.shipmentIds.filter((id) => !remove.has(id));
    if (!left.length) return [];
    const amounts = Object.fromEntries(
      left.map((id) => [
        id,
        c.amounts?.[id] ?? c.allocations.find((a) => a.shipmentId === id)?.amount ?? 0,
      ]),
    );
    return [
      {
        ...c,
        shipmentIds: left,
        allocations: c.allocations.filter((a) => !remove.has(a.shipmentId)),
        amounts,
        amount: sum(Object.values(amounts)),
      },
    ];
  });
  return revoked;
}
function downgrade(state: State, s: WorkflowShipment, to: number, reason: string) {
  if (s.step <= to) return;
  clearGroupMessages(state, s.groupId);
  const before = s.step;
  s.step = to;
  if (to < 4)
    for (const c of state.workflow!.confirmations ?? [])
      if (
        c.shipmentIds.includes(s.id) &&
        !state.workflow!.events.some(
          (e) =>
            e.action === "입금 승인 재확인 필요" &&
            e.before === c.id &&
            e.shipmentIds.includes(s.id),
        )
      )
        event(state, "입금 승인 재확인 필요", [s], "시스템", s.groupId, c.id, undefined, reason);
  s.rechecks = [...(s.rechecks ?? []), { at: now(), reason, fromStage: before, toStage: to }];
  s.legacyApproval = false;
  const g = state.workflow!.groups.find((g) => g.id === s.groupId)!;
  if (before >= 3) g.needsNotice = true;
  event(state, "재검증 필요", [s], "시스템", g.id, before, to, reason);
}
/** Stable IDs and append-only history; callers may provide an unsaved draft for preview. */
export function reconcileWorkflow(input: State, draft?: Order): State {
  const state = clone(input);
  if (
    draft &&
    !draft.deletedAt &&
    (draft.clientId || draft.orderType === "RETAIL") &&
    (state.clients.some((c) => c.id === draft.clientId) || draft.clientSnapshot)
  ) {
    const i = state.orders.findIndex((o) => o.id === draft.id);
    if (i < 0) state.orders.push(clone(draft));
    else state.orders[i] = clone(draft);
  }
  state.workflow ??= workflowEmpty();
  state.workflow.confirmations ??= [];
  const w = state.workflow;
  for (const order of state.orders) {
    if (
      order.deletedAt ||
      (!order.clientId && order.orderType !== "RETAIL") ||
      (!state.clients.some((c) => c.id === order.clientId) && !order.clientSnapshot)
    )
      continue;
    synchronizeIssueDecisions(order);
    let source = w.sources.find((s) => s.orderId === order.id);
    if (!source) {
      source = {
        number: Math.max(0, ...w.sources.map((s) => s.number ?? 0)) + 1,
        id: sourceId(order),
        orderId: order.id,
        dealerId: order.clientId,
        raw: order.raw,
        createdAt: order.createdAt,
      };
      w.sources.push(source);
    }
    let root = w.groups.find((g) => g.id === rootGroupId(order));
    if (!root) {
      root = {
        id: rootGroupId(order),
        sourceId: source.id,
        dealerId: order.clientId,
        rootGroupId: rootGroupId(order),
        createdAt: order.createdAt,
        notices: [],
        needsNotice: false,
      };
      root.messageEdits = clone(order.messageEdits);
      w.groups.push(root);
    }
    const clientIssue = clientChangeIssue(state, order, order.clientId);
    if (clientIssue) throw Error(clientIssue);
    for (const g of w.groups.filter((g) => g.sourceId === source.id)) {
      if (g.dealerId !== order.clientId) {
        const old = g.dealerId;
        g.dealerId = order.clientId;
        event(
          state,
          "거래처 변경",
          w.shipments.filter((s) => s.groupId === g.id),
          state.settings.operatorName?.trim() || "직원",
          g.id,
          old,
          order.clientId,
        );
      }
      if (order.groupMessageEdits) g.messageEdits = order.groupMessageEdits[g.id];
      const account = order.groupAccounts?.[g.id];
      if (account) {
        g.accountMode = account.mode;
        g.accountId = account.id;
      }
    }
    for (const r of order.recipients) {
      if (!r.items.length && !r.name && !r.address && !r.phone && !r.mobile) continue;
      const c = orderParty(order, state)!;
      const info = information(order, r, senderFor(order, state)),
        reco = freight(state, order, r);
      let s = w.shipments.find((s) => s.orderId === order.id && s.recipientId === r.id);
      if (!s) {
        if (r.vatDefault === undefined)
          r.vatDefault = input.orders.some((o) => o.id === order.id)
            ? order.applyVat
            : (c.defaultApplyVat ?? false);
        s = {
          recipientSnapshot: clone(r),
          id: shipmentId(order, r),
          sourceId: source.id,
          orderId: order.id,
          recipientId: r.id,
          groupId: root.id,
          step: 0,
          completedAt: {},
          charges: {},
          chargeMode: "AUTO",
          freightVersion: reco.version,
          infoSignature: info,
          transferred: false,
        };
        w.shipments.push(s);
      }
      if (s.transferred || s.legacyArchived) continue;
      if (s.infoSignature !== info) {
        downgrade(state, s, 0, "수취인 / 상품 / 수량 / 가격 / 출고지 / 송하인 변경");
        s.infoSignature = info;
      }
      if (s.freightVersion !== reco.version && !(s.step >= 2 && s.chargeMode === "MANUAL")) {
        downgrade(state, s, 1, "적용 운임 기준 변경");
        s.freightVersion = reco.version;
      }
      if (
        s.recipientSnapshot &&
        shipmentFreightCode(order, s.recipientSnapshot) !== shipmentFreightCode(order, r)
      )
        downgrade(state, s, 1, "운임 구분 변경");
      s.recipientSnapshot = clone(r);
      const beforeFees = JSON.stringify(s.charges);
      const os = origins(r);
      for (const origin of ["FACTORY", "STORE"] as const)
        if (!os.includes(origin)) delete s.charges[origin];
      if (r.shippingCharges) {
        s.chargeMode = "MANUAL";
        for (const origin of os) s.charges[origin] = r.shippingCharges[origin] ?? null;
      } else if (s.chargeMode === "AUTO")
        for (const origin of os)
          s.charges[origin] = reco.bundles.find((b) => b.origin === origin)?.recommendation ?? null;
      if (c.shippingFeeExcluded) for (const origin of os) s.charges[origin] = 0;
      if (beforeFees !== JSON.stringify(s.charges)) downgrade(state, s, 1, "추천 운임 변경");
    }
  }
  for (const s of w.shipments) {
    const order = state.orders.find((o) => o.id === s.orderId);
    if (!order?.recipients.some((r) => r.id === s.recipientId) && !s.legacyArchived) {
      if (s.transferred || w.payments.some((p) => p.allocations.some((a) => a.shipmentId === s.id)))
        throw Error("이관 / 입금 기록이 있는 배송 건은 삭제할 수 없습니다.");
      s.legacyArchived = true;
      event(state, "배송 건 제외", [s], "직원", s.groupId);
    }
  }
  for (const s of w.shipments.filter((s) => s.step >= 3 && !s.transferred && !s.legacyArchived)) {
    if (s.billingSignature && s.billingSignature !== billing(state, s)) {
      const g = w.groups.find((g) => g.id === s.groupId)!;
      g.needsNotice = true;
      downgrade(state, s, 2, "계좌 / 청구 금액 변경");
    }
  }
  return state;
}
export function applyOrderRawEdit(
  input: State,
  id: string,
  raw: string,
  actor = input.settings.operatorName?.trim() || "직원",
  strictIdentity = false,
) {
  const state = clone(input),
    order = state.orders.find((o) => o.id === id);
  if (!order || order.deletedAt) throw Error("편집할 발주를 찾을 수 없습니다.");
  if (!raw.trim()) throw Error("발주 원문을 입력하세요.");
  if (raw === order.raw) return state;
  const w = (state.workflow ??= workflowEmpty()),
    ships = w.shipments.filter((s) => s.orderId === id),
    sent = w.queue.some(
      (q) =>
        ships.some((s) => s.id === q.shipmentId) && ["EXPORTED", "STORE_SENT"].includes(q.status),
    );
  if (sent || ships.some((s) => s.delivery))
    throw Error(
      "이미 전달 / 배송한 발주는 원문을 다시 분석할 수 없습니다. 변경 요청으로 처리하세요.",
    );
  const client =
    state.clients.find((c) => c.id === order.clientId) ?? order.clientSnapshot ?? unassignedClient;
  const before = order.raw,
    old = order.recipients,
    used = new Set<string>();
  order.recipients = parseOrder(raw, client, state).map((r, index) => {
    const prior =
      old.find(
        (p) =>
          !used.has(p.id) &&
          ((r.mobile && r.mobile === p.mobile) || (r.phone && r.phone === p.phone)),
      ) ??
      old.find((p) => !used.has(p.id) && r.name && r.name === p.name) ??
      (!strictIdentity && !used.has(old[index]?.id) ? old[index] : undefined);
    if (prior) {
      const paid = w.payments.some((p) =>
        p.allocations.some((a) =>
          ships.some((s) => s.id === a.shipmentId && s.recipientId === prior.id),
        ),
      );
      if (paid && prior.name !== r.name && prior.mobile !== r.mobile)
        throw Error(
          "입금이 연결된 수취인을 다른 사람으로 바꿀 수 없습니다. 입금 배분을 먼저 확인하세요.",
        );
      used.add(prior.id);
      r.id = prior.id;
      r.vatDefault = prior.vatDefault;
      r.vatOverride = prior.vatOverride;
      const items = new Set<string>();
      for (const item of r.items) {
        const previous =
          prior.items.find((i) => !items.has(i.id) && i.raw === item.raw) ??
          prior.items.find(
            (i) =>
              !items.has(i.id) && i.productId === item.productId && i.variantId === item.variantId,
          );
        if (previous) {
          Object.assign(item, mergeParsedItem(item, previous));
          items.add(item.id);
        }
        for (const span of item.sources ?? []) span.targetId = item.id;
      }
    }
    for (const span of r.sources ?? []) span.targetId = r.id;
    return r;
  });
  for (const s of ships) {
    for (const q of w.queue.filter((q) => q.shipmentId === s.id && q.status === "QUEUED"))
      q.status = "CANCELLED";
    s.transferred = false;
    downgrade(state, s, 0, "발주 원문 편집");
  }
  order.rawHistory = [...(order.rawHistory ?? []), { at: now(), raw: before, actor }];
  Object.assign(order, {
    raw,
    analysisRaw: raw,
    analysisClientId: client.id,
    updatedAt: now(),
    pricesLocked: false,
    notified: false,
    paid: false,
    postpaidApproved: false,
    status: "REVIEW",
    shippingMode: "AUTO",
    messageEdits: undefined,
    groupMessageEdits: undefined,
  });
  for (const g of w.groups.filter(
    (g) => w.sources.find((s) => s.id === g.sourceId)?.orderId === id,
  ))
    g.messageEdits = undefined;
  event(state, "원문 편집", ships, actor, undefined, before, raw);
  return reconcileWorkflow(state);
}
export function deleteOrder(
  input: State,
  id: string,
  actor = input.settings.operatorName?.trim() || "직원",
) {
  const state = clone(input),
    order = state.orders.find((o) => o.id === id);
  if (!order) throw Error("삭제할 발주를 찾을 수 없습니다.");
  if (order.deletedAt) return state;
  const deletionIssue = ordinaryDeleteIssue(state, id);
  if (deletionIssue) throw Error(deletionIssue);
  const w = (state.workflow ??= workflowEmpty()),
    ships = w.shipments.filter((s) => s.orderId === id);
  for (const s of ships) {
    for (const q of w.queue.filter((q) => q.shipmentId === s.id && q.status === "QUEUED"))
      q.status = "CANCELLED";
    if (
      !w.queue.some(
        (q) => q.shipmentId === s.id && ["EXPORTED", "STORE_SENT"].includes(q.status),
      ) &&
      !s.delivery
    ) {
      s.transferred = false;
      downgrade(state, s, 0, "발주 삭제");
    }
  }
  order.deletedAt = now();
  order.updatedAt = order.deletedAt;
  state.queue = state.queue.filter((o) => o !== id);
  event(state, "발주 삭제", ships, actor, undefined, id, order.deletedAt);
  return state;
}
/** Existing approval flags are retained as legacy evidence, never invented receipts. */
export function migrateWorkflow(input: State) {
  const state = reconcileWorkflow(input);
  for (const s of state.workflow!.shipments) {
    const { order, recipient } = shipmentContext(state, s);
    s.step =
      order.paid ||
      order.postpaidApproved ||
      order.status === "QUEUED" ||
      order.status === "EXPORTED"
        ? 4
        : order.notified
          ? 3
          : 0;
    s.legacyApproval = s.step === 4;
    s.sender = clone(senderFor(order, state));
    if (order.recipients.length === 1 && amount(order.shippingFee)) {
      s.chargeMode = "MANUAL";
      const os = origins(recipient);
      if (os.length === 1) s.charges[os[0]] = order.shippingFee;
    }
    if (s.step >= 2) s.confirmedFreightVersion = s.freightVersion;
    if (s.step >= 3) s.billingSignature = billing(state, s);
    if (order.status === "EXPORTED") {
      s.transferred = true;
      s.legacyArchived = true;
    } else if (input.queue.includes(order.id)) {
      s.transferred = true;
      const t = shipmentTotals(state, { ...s, transferred: false });
      for (const origin of origins(recipient))
        state.workflow!.queue.push({
          id: "excel:" + s.id + ":" + origin,
          shipmentId: s.id,
          origin,
          at: order.updatedAt,
          actor: "마이그레이션",
          status: "QUEUED",
          legacy: true,
          snapshot: {
            recipient: clone({
              ...recipient,
              items: recipient.items.filter((i) => i.origin === origin),
            }),
            sender: clone(s.sender!),
            freightCode: shipmentFreightCode(order, recipient),
            total: t.total,
            vat: t.vat,
            subtotal: t.subtotal,
            shipping: t.shipping,
          },
        });
    }
    event(state, "기존 주문 상태 보존", [s], "마이그레이션", s.groupId, undefined, {
      step: s.step,
      status: order.status,
      receiptCreated: false,
    });
  }
  return state;
}
export function groupStep(state: State, id: string) {
  const ss = groupShipments(state, id);
  return ss.length ? Math.min(...ss.map((s) => s.step)) : 0;
}
export function orderInformationIssues(state: State, s: WorkflowShipment) {
  return workflowIssues(state, s.groupId)
    .filter((i) => i.recipientId === s.recipientId && blocking(i, 1))
    .map((i) => i.title);
}
export function paymentBalance(state: State, s: WorkflowShipment) {
  const account = groupAccount(state, s.groupId);
  const records = state.workflow!.payments.filter(
    (p) =>
      p.dealerId === shipmentContext(state, s).order.clientId &&
      accountKey(p.account) === accountKey(account),
  );
  const paid = sum(
    records.flatMap((p) => p.allocations.filter((a) => a.shipmentId === s.id).map((a) => a.amount)),
  );
  const total = shipmentTotals(state, s).total;
  const acknowledged = sum(
    (state.workflow!.confirmations ?? [])
      .filter(
        (p) =>
          p.dealerId === shipmentContext(state, s).order.clientId &&
          accountKey(p.announcedAccount) === accountKey(account) &&
          !state.workflow!.events.some(
            (e) =>
              e.action === "입금 승인 재확인 필요" &&
              e.before === p.id &&
              e.shipmentIds.includes(s.id),
          ),
      )
      .flatMap((p) => p.allocations.filter((a) => a.shipmentId === s.id).map((a) => a.amount)),
  );
  const confirmed =
    total === null ? acknowledged : Math.min(acknowledged, Math.max(0, total - paid));
  return {
    paid,
    confirmed,
    total,
    due: total === null ? null : Math.max(0, total - paid - confirmed),
    legacy: s.legacyApproval === true,
  };
}
export function workflowIssues(state: State, id: string) {
  const { shipments, group, order } = groupContext(state, id),
    recipientIds = new Set(shipments.map((s) => s.recipientId));
  const result = orderIssues(order)
    .filter((i) => !order.confirmedAt || !i.recipientId || recipientIds.has(i.recipientId))
    .map((i) => ({ ...i, groupId: id }));
  const add = (
    r: Recipient | undefined,
    kind: string,
    title: string,
    stage: number,
    field: string,
  ) => result.push(operationalIssue(order, r, id, kind, title, stage, field));
  for (const row of order.recipients)
    for (const item of row.items)
      if (item.productId) {
        const problem = saleProblem(state.products.find((p) => p.id === item.productId));
        if (problem)
          add(
            row,
            "SALE_STATUS",
            item.name + " / " + problem + " — 판매 상태 확인 필요",
            1,
            "product",
          );
      }
  const sender = senderFor(order, state),
    companySender = order.orderType === "DEALER" || order.orderType === "RETAIL";
  if (!sender.name.trim())
    add(
      undefined,
      "SENDER_NAME",
      companySender ? "설정의 반도스탠드 상호명을 확인하세요" : "송하인 거래처명을 확인하세요",
      1,
      "client",
    );
  if (!sender.address?.trim())
    add(
      undefined,
      "SENDER_ADDRESS",
      companySender ? "설정의 반도스탠드 주소를 등록하세요" : "송하인 거래처 주소를 확인하세요",
      1,
      "client",
    );
  if (!(sender.phone || sender.mobile)?.trim())
    add(
      undefined,
      "SENDER_CONTACT",
      companySender ? "설정의 반도스탠드 연락처를 등록하세요" : "송하인 거래처 연락처를 확인하세요",
      1,
      "client",
    );
  for (const ship of shipments) {
    const { recipient: r } = shipmentContext(state, ship);
    for (const item of r.items)
      if (
        item.productId &&
        item.variantId &&
        !order.confirmedAt &&
        !state.products.some(
          (p) =>
            p.id === item.productId &&
            !p.deletedAt &&
            p.active !== false &&
            !p.supersededBy &&
            p.variants.some((v) => v.id === item.variantId),
        )
      )
        if (!result.some((i) => i.itemId === item.id && i.kind === "MODEL"))
          result.push({
            ...operationalIssue(
              order,
              r,
              id,
              "MODEL",
              "등록된 상품과 옵션을 확인하세요",
              1,
              "product",
            ),
            itemId: item.id,
          });
    if (r.items.some((i) => !["STORE", "FACTORY"].includes(i.origin)))
      add(r, "ORIGIN", "발송지를 확인하세요", 1, "product");
    if (
      feeTotal(ship, r, order) === null &&
      !result.some(
        (i) =>
          i.recipientId === r.id &&
          i.itemId &&
          i.severity === "ACTION" &&
          ["MODEL", "MODEL_CHOICE", "ALIAS_CONFLICT", "QUANTITY_LINK", "QUANTITY_INVALID"].includes(
            i.kind,
          ),
      )
    )
      add(r, "FREIGHT", "배송 운임을 확인하세요", 2, "freight");
  }
  if (order.orderType === "RETAIL")
    return result.filter(
      (i) =>
        !["PRICE", "FREIGHT", "SENDER_NAME", "SENDER_ADDRESS", "SENDER_CONTACT"].includes(i.kind),
    );
  const a = groupAccount(state, id);
  if (!a?.bank.trim() || !a.number.trim() || !a.holder.trim())
    add(undefined, "ACCOUNT", "입금 계좌를 등록 / 선택하세요", 3, "account");
  if (group.needsNotice) add(undefined, "NOTICE", "변경된 금액 / 계좌 재안내 필요", 3, "account");
  return result;
}
export function stageIssues(state: State, id: string, next: number) {
  const { shipments, client } = groupContext(state, id),
    issues = workflowIssues(state, id)
      .filter((i) => blocking(i, next))
      .map(
        (i) =>
          (shipmentContext(
            state,
            shipments.find((s) => s.recipientId === i.recipientId) ?? shipments[0],
          ).recipient.name || "수취인") +
          ": " +
          i.title,
      );
  for (const s of shipments) {
    const { order, recipient } = shipmentContext(state, s),
      prefix = (recipient.name || "수취인") + ": ";
    if (order.orderType === "RETAIL") continue;
    if (next >= 2 && shipmentTotals(state, s).total === null && !issues.length)
      issues.push(prefix + "청구액 미확정");
    if (next >= 3 && s.step < 2 && shipmentFreightCode(order, recipient) !== "020")
      issues.push(prefix + "운임 적용 필요");
    if (next >= 4) {
      if (s.step < 3) issues.push(prefix + "계좌 안내 완료 필요");
      const b = paymentBalance(state, s);
      if (client.payment === "PREPAID" && b.due !== 0 && !s.legacyApproval)
        issues.push(prefix + "입금 부족 " + won(b.due));
    }
  }
  for (const ship of shipments)
    issues.push(
      ...saleIssues(state, {
        ...shipmentContext(state, ship).order,
        recipients: [shipmentContext(state, ship).recipient],
      }),
    );
  return [...new Set(issues)];
}

export function advanceGroup(
  input: State,
  id: string,
  actor = input.settings.operatorName?.trim() || "직원(이름 미설정)",
) {
  const state = reconcileWorkflow(input),
    { group, shipments, client, order } = groupContext(state, id);
  if (shipments.some((s) => s.transferred))
    throw Error("이미 엑셀 관리 목록으로 이관한 배송 건입니다.");
  const step = groupStep(state, id);
  if (step >= 4 && !group.needsNotice) throw Error("처리완료 버튼으로 이관하세요.");
  const next = group.needsNotice && step >= 2 ? 3 : step + 1;
  const issues = stageIssues(state, id, next);
  const blockingIssues =
    group.needsNotice && next === 3
      ? issues.filter((i) => !i.includes("변경된 금액 / 계좌 재안내 필요"))
      : issues;
  if (blockingIssues.length) throw Error(blockingIssues.join("\n"));
  if (order.orderType === "RETAIL") throw Error("소매 주문은 전용 작성 화면에서 접수하세요.");
  const at = now();
  if (next === 1 && order.receptionVersion === 1 && !order.confirmedAt) {
    order.confirmedAt = at;
    order.createdAt = at;
    order.receipt = { original: order.raw, at, actor, clientId: order.clientId, legacy: false };
    order.clientSnapshot = clone(client);
    for (const row of order.recipients)
      for (const item of row.items) {
        const source = item.sources?.find((s) => s.field === "product");
        if (
          item.manuallyConfirmed &&
          item.productId &&
          item.variantId &&
          source?.text &&
          order.raw.slice(source.start, source.end) === source.text
        )
          item.selectionEvidence = {
            expression: source.text,
            productId: item.productId,
            variantId: item.variantId,
          };
      }
    order.senderSnapshot = clone(senderFor(order, state));
    order.pricesLocked = true;
    order.status = "STATEMENT";
    const { confirmationSnapshot: _priorSnapshot, ...confirmedData } = clone(order);
    order.confirmationSnapshot = {
      at,
      raw: order.raw,
      client: clone(client),
      recipients: clone(order.recipients),
      data: confirmedData,
    };
  }
  if (next === 3) {
    const account = groupAccount(state, id)!;
    const amounts = Object.fromEntries(
      shipments.map((s) => [s.id, shipmentTotals(state, s).total!]),
    );
    group.notices.push({
      id: uid(),
      at,
      actor,
      shipmentIds: shipments.map((s) => s.id),
      amounts,
      total: sum(Object.values(amounts)),
      account: clone(account),
      message: groupMessages(state, id).payment,
    });
    group.needsNotice = false;
  }
  for (const s of shipments) {
    for (const review of s.rechecks ?? [])
      if (!review.resolvedAt && next >= review.fromStage) review.resolvedAt = at;
    if (next === 1) s.sender = clone(senderFor(order, state));
    if (next === 2) {
      const adjustmentContext = shipmentContext(state, s),
        recommended = freight(state, adjustmentContext.order, adjustmentContext.recipient).total,
        confirmed = feeTotal(s, adjustmentContext.recipient, adjustmentContext.order);
      if (
        state.shipping &&
        shipmentFreightCode(adjustmentContext.order, adjustmentContext.recipient) !== "020" &&
        !client.shippingFeeExcluded &&
        amount(recommended) &&
        amount(confirmed) &&
        recommended !== confirmed
      ) {
        const items = adjustmentContext.recipient.items.map((i) => ({
            productId: i.productId,
            variantId: i.variantId,
            model: i.name,
            quantity: i.quantity,
            origin: i.origin,
          })),
          last = state.shipping.adjustments?.filter((a) => a.shipmentId === s.id).at(-1);
        if (
          !last ||
          last.recommended !== recommended ||
          last.confirmed !== confirmed ||
          last.ruleVersion !== s.freightVersion ||
          JSON.stringify(last.items) !== JSON.stringify(items)
        ) {
          state.shipping.adjustments ??= [];
          state.shipping.adjustments.push({
            id: uid(),
            shipmentId: s.id,
            items,
            recommended,
            confirmed,
            actor,
            confirmedAt: at,
            ruleVersion: s.freightVersion,
          });
        }
      }
      s.chargeMode = "MANUAL";
      shipmentContext(state, s).recipient.shippingCharges = clone(s.charges);
      s.confirmedFreightVersion = s.freightVersion;
      s.appliedEpoch = state.shipping?.epoch ?? 1;
      const ctx = shipmentContext(state, s);
      s.appliedBundles = freight(state, ctx.order, ctx.recipient).bundles.map((b) => ({
        origin: b.origin,
        key: b.key,
        versions: clone(b.versions),
        description: b.description,
      }));
    }
    if (next === 3) s.billingSignature = billing(state, s);
    if (s.step < next) {
      s.step = next;
      s.completedAt[next as 1 | 2 | 3 | 4] = at;
    }
  }
  event(
    state,
    [
      "",
      "주문 확인 완료",
      "운임 적용",
      "계좌 안내 완료",
      client.payment === "POSTPAID" ? "후불 출고 승인" : "입금 확인 완료",
    ][next],
    shipments,
    actor,
    id,
    step,
    next,
  );
  return state;
}
export function undoGroup(
  input: State,
  id: string,
  actor = input.settings.operatorName?.trim() || "직원(이름 미설정)",
) {
  const state = reconcileWorkflow(input),
    { group, shipments } = groupContext(state, id),
    step = groupStep(state, id);
  if (shipments.some((s) => s.transferred))
    throw Error("엑셀 관리 목록에서 이관 복구를 먼저 진행하세요.");
  if (!step) throw Error("첫 단계입니다.");
  if (step === 4) {
    for (const s of shipments) {
      s.step = 3;
      s.legacyApproval = false;
    }
    revokeConfirmations(
      state,
      shipments.map((s) => s.id),
    );
    return state;
  }
  for (const s of shipments) {
    s.step = Math.min(s.step, step - 1);
    s.legacyApproval = false;
  }
  if (step <= 3 && group.notices.length) group.needsNotice = true;
  event(
    state,
    "이전 단계 취소",
    shipments,
    actor,
    id,
    step,
    step - 1,
    "입금 기록과 이전 완료 이력은 보존",
  );
  return state;
}
export function setShipmentFreight(
  input: State,
  id: string,
  origin: Origin,
  value: Price,
  actor = input.settings.operatorName?.trim() || "직원(이름 미설정)",
) {
  const state = reconcileWorkflow(input),
    s = state.workflow!.shipments.find((s) => s.id === id);
  if (!s || s.transferred) throw Error("수정할 배송 건을 확인하세요.");
  if (value !== null && !amount(value)) throw Error("운임은 원 단위 정수로 입력하세요.");
  if (!origins(shipmentContext(state, s).recipient).includes(origin))
    throw Error("이 배송 건의 출고지가 아닙니다.");
  const before = s.charges[origin];
  s.charges[origin] = value;
  shipmentContext(state, s).recipient.shippingCharges = { ...s.charges };
  s.chargeMode = "MANUAL";
  if (before !== value) downgrade(state, s, 1, "직원이 운임 변경");
  event(
    state,
    "배송 건 운임 수정",
    [s],
    actor,
    s.groupId,
    { origin, value: before },
    { origin, value },
  );
  return state;
}
export function setGroupAccount(
  input: State,
  id: string,
  accountId: string | undefined,
  actor = input.settings.operatorName?.trim() || "직원(이름 미설정)",
) {
  const state = reconcileWorkflow(input),
    { group, shipments } = groupContext(state, id);
  if (shipments.some((s) => s.transferred)) throw Error("이관한 묶음의 계좌는 변경할 수 없습니다.");
  if (accountId && !state.settings.accounts.some((a) => a.id === accountId))
    throw Error("등록된 계좌를 선택하세요.");
  group.accountMode = accountId === undefined ? "AUTO" : "MANUAL";
  group.accountId = accountId;
  const order = groupContext(state, id).order;
  order.groupAccounts = {
    ...order.groupAccounts,
    [id]: { mode: group.accountMode, id: accountId },
  };
  clearGroupMessages(state, id);
  for (const s of shipments) if (s.step >= 3) downgrade(state, s, 2, "입금 계좌 변경");
  event(state, "묶음 입금 계좌 변경", shipments, actor, id, undefined, accountId ?? "AUTO");
  return state;
}
export function detachShipment(
  input: State,
  id: string,
  actor = input.settings.operatorName?.trim() || "직원(이름 미설정)",
) {
  const state = reconcileWorkflow(input),
    s = state.workflow!.shipments.find((s) => s.id === id);
  if (!s || s.transferred) throw Error("현재 관리 중인 배송 건을 선택하세요.");
  const { group, shipments } = groupContext(state, s.groupId);
  if (shipments.length < 2) throw Error("이미 독립 관리 중입니다.");
  const account = groupAccount(state, group.id),
    old = s.groupId;
  const separated: OrderGroup = {
    ...clone(group),
    id: uid(),
    createdAt: now(),
    notices: [],
    needsNotice: group.notices.length > 0 || s.step >= 3,
    accountMode: account ? "MANUAL" : group.accountMode,
    accountId: account?.id ?? group.accountId,
  };
  state.workflow!.groups.push(separated);
  s.groupId = separated.id;
  if (group.notices.length || shipments.some((s) => s.step >= 3)) {
    group.needsNotice = true;
    group.accountMode = account ? "MANUAL" : group.accountMode;
    group.accountId = account?.id ?? group.accountId;
  }
  event(state, "묶음 해제", [s], actor, separated.id, old, separated.id);
  return state;
}
export function regroupShipment(
  input: State,
  id: string,
  targetId: string,
  ack = false,
  actor = input.settings.operatorName?.trim() || "직원(이름 미설정)",
) {
  const state = reconcileWorkflow(input),
    s = state.workflow!.shipments.find((s) => s.id === id);
  if (!s || s.transferred) throw Error("엑셀 이관 배송 건은 일반 다시 묶기에서 제외됩니다.");
  const old = groupContext(state, s.groupId),
    target = groupContext(state, targetId);
  if (old.group.id === targetId) throw Error("이미 같은 묶음입니다.");
  if (old.group.sourceId !== target.group.sourceId || old.group.dealerId !== target.group.dealerId)
    throw Error("같은 최초 발주서 / 거래처의 배송 건만 다시 묶을 수 있습니다.");
  if (
    target.shipments.some((x) => x.transferred) ||
    target.shipments.some((x) => x.step !== s.step)
  )
    throw Error("진행 단계가 같고 이관되지 않은 배송 건만 다시 묶을 수 있습니다.");
  if (accountKey(groupAccount(state, old.group.id)) !== accountKey(groupAccount(state, targetId)))
    throw Error("입금 계좌가 다른 묶음은 합칠 수 없습니다.");
  const warned =
    s.step >= 3 ||
    old.group.notices.length ||
    target.group.notices.length ||
    state.workflow!.payments.some((p) =>
      p.allocations.some(
        (a) => a.shipmentId === s.id || target.shipments.some((x) => x.id === a.shipmentId),
      ),
    );
  if (warned && !ack) throw Error("기존 안내 금액과 입금 배분을 확인한 뒤 다시 묶기를 승인하세요.");
  const before = s.groupId;
  s.groupId = targetId;
  if (warned) {
    old.group.needsNotice = true;
    target.group.needsNotice = true;
  }
  event(state, "다시 묶기", [s], actor, targetId, before, targetId, "배송 ID / 단계 / 입금 배분 유지");
  return state;
}
export function recordPayment(
  input: State,
  id: string,
  paidAmount: number,
  allocations: { shipmentId: string; amount: number }[],
  paidAt: string,
  memo = "",
  actor = input.settings.operatorName?.trim() || "직원(이름 미설정)",
) {
  const state = reconcileWorkflow(input),
    { group } = groupContext(state, id),
    account = groupAccount(state, id);
  if (
    !amount(paidAmount) ||
    paidAmount === 0 ||
    !account?.number.trim() ||
    !account.bank.trim() ||
    !account.holder.trim()
  )
    throw Error("실제 입금액과 입금 계좌를 확인하세요.");
  if (!paidAt || !Number.isFinite(Date.parse(paidAt))) throw Error("실제 입금 일시를 입력하세요.");
  if (new Set(allocations.map((a) => a.shipmentId)).size !== allocations.length)
    throw Error("배분 대상이 중복됩니다.");
  for (const a of allocations) {
    const s = state.workflow!.shipments.find((s) => s.id === a.shipmentId);
    if (!s || !amount(a.amount)) throw Error("입금 배분을 확인하세요.");
    if (
      shipmentContext(state, s).order.clientId !== group.dealerId ||
      accountKey(groupAccount(state, s.groupId)) !== accountKey(account)
    )
      throw Error("다른 거래처 / 계좌의 배송 건에 배분할 수 없습니다.");
  }
  if (sum(allocations.map((a) => a.amount)) > paidAmount)
    throw Error("배분액이 실제 입금액을 초과합니다.");
  const payment = {
    id: uid(),
    dealerId: group.dealerId,
    account: clone(account),
    amount: paidAmount,
    paidAt,
    recordedAt: now(),
    actor,
    memo,
    allocations: allocations.filter((a) => a.amount > 0).map((a) => ({ ...a, id: uid() })),
  };
  state.workflow!.payments.push(payment);
  event(
    state,
    "실제 입금 기록",
    state.workflow!.shipments.filter((s) => allocations.some((a) => a.shipmentId === s.id)),
    actor,
    id,
    undefined,
    payment,
  );
  return state;
}
export function processGroup(
  input: State,
  id: string,
  actor = input.settings.operatorName?.trim() || "직원(이름 미설정)",
) {
  const state = reconcileWorkflow(input),
    { shipments, group } = groupContext(state, id);
  if (shipments.every((s) => s.transferred)) return state;
  if (shipments.some((s) => s.transferred))
    throw Error("이미 일부가 이관되어 있습니다. 이관 상태를 먼저 확인하세요.");
  if (shipments.some((s) => s.step !== 4) || group.needsNotice)
    throw Error("네 단계와 변경 금액 재안내를 먼저 완료하세요.");
  const issues = stageIssues(state, id, 4);
  if (issues.length) throw Error(issues.join("\n"));
  for (const s of shipments) {
    const { recipient } = shipmentContext(state, s);
    for (const origin of origins(recipient)) {
      const key = "excel:" + s.id + ":" + origin;
      const existing = state.workflow!.queue.find((q) => q.id === key);
      if (existing && existing.status !== "CANCELLED") throw Error("이미 등록된 배송 건입니다.");
      const ctx = shipmentContext(state, s);
      const t = shipmentTotals(state, s);
      const entry = {
        id: key,
        shipmentId: s.id,
        origin,
        at: now(),
        actor,
        status: "QUEUED" as const,
        snapshot: {
          recipient: clone({
            ...recipient,
            items: recipient.items.filter((i) => i.origin === origin),
          }),
          sender: clone(s.sender ?? ctx.client),
          freightCode: shipmentFreightCode(ctx.order, ctx.recipient),
          total: t.total!,
          vat: t.vat!,
          subtotal: t.subtotal!,
          shipping: t.shipping!,
        },
      };
      if (existing) Object.assign(existing, entry);
      else state.workflow!.queue.push(entry);
    }
    s.transferred = true;
  }
  event(state, "처리완료 / 엑셀 관리 목록 이관", shipments, actor, id, undefined, {
    entries: clone(
      state.workflow!.queue.filter(
        (q) => shipments.some((s) => s.id === q.shipmentId) && q.status === "QUEUED",
      ),
    ),
  });
  return state;
}
export function restoreShipment(
  input: State,
  id: string,
  actor = input.settings.operatorName?.trim() || "직원(이름 미설정)",
) {
  const state = reconcileWorkflow(input),
    s = state.workflow!.shipments.find((s) => s.id === id);
  if (!s || !s.transferred) throw Error("이관된 배송 건을 선택하세요.");
  const queue = state.workflow!.queue.filter(
    (q) => q.shipmentId === id && q.status !== "CANCELLED",
  );
  if (queue.some((q) => q.status !== "QUEUED"))
    throw Error("이미 공장 전달 / 매장 발송한 건입니다. 변경 요청을 기록하세요.");
  for (const q of queue) q.status = "CANCELLED";
  s.transferred = false;
  event(state, "엑셀 이관 복구", [s], actor, s.groupId);
  return state;
}
export function recordChangeRequest(
  input: State,
  id: string,
  text: string,
  actor = input.settings.operatorName?.trim() || "직원(이름 미설정)",
) {
  const state = clone(input),
    s = state.workflow!.shipments.find((s) => s.id === id);
  if (!s || !text.trim()) throw Error("배송 건과 변경 요청 내용을 확인하세요.");
  state.workflow!.changeRequests.push({
    id: uid(),
    shipmentId: id,
    text: text.trim(),
    actor,
    at: now(),
  });
  event(state, "전달 후 변경 요청 기록", [s], actor, s.groupId, undefined, text);
  return state;
}
export function completeDelivery(
  input: State,
  id: string,
  actual: Partial<Record<Origin, number>>,
  actor = input.settings.operatorName?.trim() || "직원(이름 미설정)",
) {
  const state = reconcileWorkflow(input),
    s = state.workflow!.shipments.find((s) => s.id === id);
  if (!s || !s.transferred) throw Error("발송 처리한 배송 건을 선택하세요.");
  if (s.delivery) return state;
  const { order, recipient } = shipmentContext(state, s),
    os = origins(recipient);
  if (
    state.workflow!.queue.some(
      (q) => q.shipmentId === id && q.fileOnly === true && q.status === "EXPORTED",
    )
  )
    throw Error("실제 공장 전달 확인 후 배송 완료를 처리하세요.");
  if (
    state
      .workflow!.queue.filter((q) => q.shipmentId === id && q.status !== "CANCELLED")
      .some((q) => q.status === "QUEUED")
  )
    throw Error("공장 전달 또는 매장 발송 확인 후 배송 완료를 기록하세요.");
  for (const origin of os)
    if (!amount(actual[origin])) throw Error("출고지별 실제 택배 운임을 확인하세요.");
  const reco = freight(state, order, recipient),
    recordIds: string[] = [];
  for (const b of reco.bundles) {
    const charged = shipmentFreightCode(order, recipient) === "020" ? 0 : s.charges[b.origin];
    if (!amount(charged)) throw Error("청구 운임 확인 필요");
    const applied = s.latestRecipient
      ? undefined
      : s.appliedBundles?.find((x) => x.origin === b.origin);
    const basis = applied ? { ...b, key: applied.key, versions: applied.versions } : b;
    state.shipping = saveCombination(state.shipping!, basis, actual[b.origin]!, actual[b.origin]!);
    const combo = state.shipping.combinations.at(-1)!;
    combo.observedCharge = charged;
    combo.shipmentId = s.id;
    combo.verifiedAt = now();
    combo.epoch = s.appliedEpoch ?? state.shipping.epoch;
    combo.active = combinationCurrent(combo, state);
    combo.sampleCount =
      state.workflow!.deliveries.filter(
        (d) =>
          state.shipping!.combinations.find((c) => c.id === d.combinationId)?.key === combo.key &&
          d.version === (s.confirmedFreightVersion ?? reco.version),
      ).length + 1;
    recordIds.push(combo.id);
    state.workflow!.deliveries.push({
      id: uid(),
      shipmentId: s.id,
      recipientId: s.recipientId,
      origin: b.origin,
      at: now(),
      actor,
      items: b.items.map((i) => ({
        productId: i.productId!,
        variantId: i.variantId!,
        quantity: i.quantity!,
        shippingGroupId: state.products.find((p) => p.id === i.productId)?.shippingGroupId,
      })),
      bundles: null,
      charge: charged,
      actual: actual[b.origin]!,
      version: s.confirmedFreightVersion ?? reco.version,
      combinationId: combo.id,
    });
  }
  s.delivery = {
    at: now(),
    actor,
    actual,
    versions: Object.assign({}, ...reco.bundles.map((b) => b.versions)),
    recordIds,
  };
  event(state, "실제 배송 완료 / 운임 검증", [s], actor, s.groupId, undefined, s.delivery);
  return state;
}
export function markStoreSent(
  input: State,
  queueId: string,
  actor = input.settings.operatorName?.trim() || "직원(이름 미설정)",
) {
  const state = clone(input),
    q = state.workflow!.queue.find((q) => q.id === queueId);
  if (!q || q.origin !== "STORE" ||
    !["QUEUED", "EXPORTED"].includes(q.status))
    throw Error("매장 발송 대기 건을 선택하세요.");
  if (q.status === "EXPORTED" &&
    (!q.exportId || !state.exports.some((e) =>
      e.id === q.exportId && e.queueEntryIds?.includes(q.id)))) {
    throw Error("해당 매장 Excel 출력 이력을 확인할 수 없습니다.");
  }
  q.status = "STORE_SENT";
  q.fileOnly = false;
  q.exportedAt ??= now();
  event(
    state,
    "매장 발송 확인",
    state.workflow!.shipments.filter((s) => s.id === q.shipmentId),
    actor,
  );
  return state;
}
export function validateWorkflow(state: State, before?: State) {
  const w = state.workflow;
  if (!w) return;
  for (const rows of [
    w.sources,
    w.groups,
    w.shipments,
    w.payments,
    w.queue,
    w.events,
    w.deliveries,
    w.changeRequests,
  ])
    if (new Set(rows.map((r) => r.id)).size !== rows.length)
      throw Error("업무 기록 ID가 중복됩니다.");
  for (const s of w.shipments) {
    if (
      s.legacyArchived &&
      !state.orders.find((o) => o.id === s.orderId)?.recipients.some((r) => r.id === s.recipientId)
    )
      continue;
    const { order } = shipmentContext(state, s);
    if (
      order.orderType === "RETAIL" &&
      (!s.transferred ||
        s.step !== 4 ||
        w.groups.find((g) => g.id === s.groupId)?.notices.length ||
        w.payments.some((p) => p.allocations.some((a) => a.shipmentId === s.id)) ||
        w.confirmations?.some((c) => c.shipmentIds.includes(s.id)))
    )
      throw Error("소매 주문에는 입금 / 계좌 안내 단계를 만들 수 없습니다.");
    const group = w.groups.find((g) => g.id === s.groupId),
      source = w.sources.find((x) => x.id === s.sourceId);
    if (
      !group ||
      !source ||
      source.orderId !== order.id ||
      group.sourceId !== source.id ||
      group.dealerId !== order.clientId
    )
      throw Error("발주서 / 묶음 / 배송 건 연결 오류");
    if (!Number.isInteger(s.step) || s.step < 0 || s.step > 4) throw Error("잘못된 진행 단계");
    for (const value of Object.values(s.actualFreight ?? {}))
      if (value !== null && !amount(value)) throw Error("실제 출고 운임 금액 오류");
    for (const value of Object.values(s.charges))
      if (value !== null && !amount(value)) throw Error("운임 금액 오류");
  }
  for (const p of w.payments) {
    if (!amount(p.amount) || sum(p.allocations.map((a) => a.amount)) > p.amount)
      throw Error("입금액 / 배분액 오류");
    for (const a of p.allocations)
      if (
        !amount(a.amount) ||
        !w.shipments.some(
          (s) => s.id === a.shipmentId && shipmentContext(state, s).order.clientId === p.dealerId,
        )
      )
        throw Error("입금 배분 연결 오류");
  }
  for (const q of w.queue)
    if (!w.shipments.some((s) => s.id === q.shipmentId)) throw Error("엑셀 관리 배송 연결 오류");
  if (new Set(w.deliveries.map((d) => d.shipmentId + "|" + d.origin)).size !== w.deliveries.length)
    throw Error("같은 배송 건 / 출고지의 배송 완료 기록이 중복됩니다.");
  for (const c of w.confirmations ?? []) {
    if (
      !amount(c.amount) ||
      !w.groups.some((g) => g.id === c.groupId) ||
      c.allocations.some(
        (a) => !amount(a.amount) || !w.shipments.some((s) => s.id === a.shipmentId),
      )
    )
      throw Error("입금 확인 연결 / 금액 오류");
  }
  if (new Set((w.confirmations ?? []).map((c) => c.id)).size !== (w.confirmations ?? []).length)
    throw Error("입금 확인 기록 중복");
  if (before?.workflow) {
    for (const old of before.workflow.confirmations ?? []) {
      const current = w.confirmations?.find((c) => c.id === old.id);
      if (current && JSON.stringify(current) !== JSON.stringify(old)) {
        const removed = old.shipmentIds.filter((id) => !current.shipmentIds.includes(id));
        const expected = clone(old);
        expected.shipmentIds = old.shipmentIds.filter((id) => current.shipmentIds.includes(id));
        expected.allocations = old.allocations.filter((a) =>
          expected.shipmentIds.includes(a.shipmentId),
        );
        expected.amounts = Object.fromEntries(
          expected.shipmentIds.map((id) => [id, old.amounts?.[id] ?? 0]),
        );
        expected.amount = sum(Object.values(expected.amounts));
        if (
          !removed.length ||
          JSON.stringify(current) !== JSON.stringify(expected) ||
          removed.some((id) => {
            const s = w.shipments.find((s) => s.id === id);
            return !s || s.transferred || s.step >= 4;
          })
        )
          throw Error("확인 기록은 입금 확인 취소에서만 삭제할 수 있습니다.");
      }
      if (
        !current &&
        old.shipmentIds.some((id) => {
          const s = w.shipments.find((s) => s.id === id);
          return !s || s.transferred || s.step >= 4;
        })
      )
        throw Error("이관 전 입금 확인 취소에서만 기록을 삭제할 수 있습니다.");
    }
    for (const old of before.workflow.shipments) {
      const current = w.shipments.find((s) => s.id === old.id);
      if (
        !current ||
        ["sourceId", "orderId", "recipientId"].some(
          (k) =>
            (old as unknown as Record<string, unknown>)[k] !==
            (current as unknown as Record<string, unknown>)[k],
        )
      )
        throw Error("배송 건 고유 ID와 최초 연결은 보존해야 합니다.");
      for (const origin of ["FACTORY", "STORE"] as const) {
        if (
          JSON.stringify(old.actualFreight?.[origin]) ===
          JSON.stringify(current.actualFreight?.[origin])
        )
          continue;
        if (
          !Object.hasOwn(current.actualFreight ?? {}, origin) ||
          !w.events.some(
            (e) =>
              !before.workflow!.events.some((prior) => prior.id === e.id) &&
              e.action === "실제 출고 운임 입력" &&
              e.shipmentIds.includes(old.id) &&
              e.before === actualFreightOf(old, shipmentContext(before, old).recipient, origin) &&
              (e.after as { origin?: string; amount?: unknown })?.origin === origin &&
              (e.after as { amount?: unknown }).amount === current.actualFreight?.[origin],
          )
        )
          throw Error("실제 출고 운임의 수정 근거를 확인하세요.");
      }
      if (old.delivery && JSON.stringify(old.delivery) !== JSON.stringify(current.delivery))
        throw Error("배송 완료 이력은 보존해야 합니다.");
    }
    for (const old of before.workflow.groups)
      for (const notice of old.notices) {
        if (
          JSON.stringify(
            w.groups.find((g) => g.id === old.id)?.notices.find((n) => n.id === notice.id),
          ) !== JSON.stringify(notice)
        )
          throw Error("기존 계좌 안내 이력은 보존해야 합니다.");
      }
    for (const key of ["payments", "events", "deliveries", "sources", "changeRequests"] as const)
      for (const old of before.workflow[key]) {
        const current = w[key].find((x) => x.id === old.id);
        if (!current || JSON.stringify(current) !== JSON.stringify(old))
          throw Error("기존 입금 / 원문 / 배송 / 조작 이력은 변경하거나 삭제할 수 없습니다.");
      }
    for (const old of before.workflow.queue) {
      const current = w.queue.find((q) => q.id === old.id);
      if (
        !current ||
        current.shipmentId !== old.shipmentId ||
        current.origin !== old.origin ||
        (old.status !== "CANCELLED" &&
          JSON.stringify(current.snapshot) !== JSON.stringify(old.snapshot))
      )
        throw Error("엑셀 이관 연결과 확정 정보는 보존해야 합니다.");
    }
    for (const old of before.workflow.queue.filter(
      (q) => q.status === "EXPORTED" || q.status === "STORE_SENT",
    )) {
      const current = w.queue.find((q) => q.id === old.id)!;
      const unchanged = JSON.stringify(current) === JSON.stringify(old),
        metadataOnly =
          JSON.stringify({
            ...current,
            fileOnly: old.fileOnly,
            factoryDeliveredAt: old.factoryDeliveredAt,
          }) === JSON.stringify(old) &&
          old.fileOnly === true &&
          current.fileOnly === false &&
          !!current.factoryDeliveredAt &&
          w.events.some(
            (e) => e.action === "공장 전달 직원 확인" && e.shipmentIds.includes(old.shipmentId),
          ),
        reopened =
          old.fileOnly === true &&
          !old.factoryDeliveredAt &&
          current.status === "CANCELLED" &&
          w.events.some(
            (e) =>
              e.action === "전달 전 출력본 폐기 / 재작성" && e.shipmentIds.includes(old.shipmentId),
          ) &&
          state.exports.some((e) =>
            e.snapshots?.some(
              (q) => q.id === old.id && JSON.stringify(q.snapshot) === JSON.stringify(old.snapshot),
            ),
          );
      if (!unchanged && !metadataOnly && !reopened)
        throw Error("이미 전달한 엑셀 / 발송 기록은 보존해야 합니다.");
    }
  }
}

export function confirmGroupPayment(
  input: State,
  id: string,
  actor = input.settings.operatorName?.trim() || "직원(이름 미설정)",
) {
  const state = reconcileWorkflow(input),
    { shipments, group, client } = groupContext(state, id);
  if (client.payment === "POSTPAID") return advanceGroup(state, id, actor);
  if (shipments.every((s) => s.step === 4)) return state;
  if (groupStep(state, id) !== 3 || group.needsNotice) throw Error("계좌 안내를 먼저 완료하세요.");
  const issues = stageIssues(state, id, 3);
  if (issues.length) throw Error(issues.join("\n"));
  const total = groupTotals(state, id).total,
    notice = group.notices.at(-1);
  if (total === null || !notice) throw Error("확정 청구액과 안내 계좌가 필요합니다.");
  state.workflow!.confirmations ??= [];
  if (
    state.workflow!.confirmations.some(
      (c) =>
        c.groupId === id &&
        c.shipmentIds.some(
          (sid) =>
            !state.workflow!.events.some(
              (e) =>
                e.action === "입금 승인 재확인 필요" &&
                e.before === c.id &&
                e.shipmentIds.includes(sid),
            ),
        ),
    )
  )
    throw Error("이미 입금 확인한 묶음입니다.");
  state.workflow!.confirmations.push({
    id: uid(),
    groupId: id,
    dealerId: group.dealerId,
    shipmentIds: shipments.map((s) => s.id),
    amount: total,
    confirmedAt: now(),
    actor,
    announcedAccount: clone(notice.account),
    amounts: clone(notice.amounts),
    allocations: shipments.map((s) => ({
      shipmentId: s.id,
      amount: paymentBalance(state, s).due!,
    })),
  });
  return advanceGroup(state, id, actor);
}
