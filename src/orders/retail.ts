import { companyClient, companyParty } from "../order-types.js";
import { retailIssues } from "./retail-validation.js";
import { processGroup, reconcileWorkflow, rootGroupId } from "../workflow.js";
import { newReception } from "./reception.js";
import type { Order, Recipient, State } from "../types.js";
export function newRetailOrder(): Order {
  return {
    ...newReception("", "RETAIL"),
    recipients: [
      {
        id: crypto.randomUUID(),
        name: "",
        address: "",
        mobile: "",
        phone: "",
        note: "",
        items: [],
        dispatchOrigin: "FACTORY",
      },
    ],
  };
}
export function confirmRetail(input: State, draft: Order) {
  if (
    draft.orderType !== "RETAIL" ||
    draft.confirmedAt ||
    input.orders.some((o) => o.id === draft.id)
  )
    throw Error("신규 소매 주문만 접수할 수 있습니다.");
  const problems = retailIssues(draft, input);
  if (problems.length) throw Error(problems.join("\n"));
  const order = structuredClone(draft),
    at = new Date().toISOString(),
    actor = input.settings.operatorName || "직원";
  order.clientId = "";
  order.raw = "";
  order.clientSnapshot = companyParty(input.settings);
  order.senderSnapshot = companyClient(input.settings);
  order.recipients.forEach((row: Recipient) => {
    row.vatDefault = false;
    row.items.forEach((item) => {
      item.unitPrice = null;
      item.origin = row.dispatchOrigin!;
    });
  });
  order.confirmedAt = at;
  order.createdAt = at;
  order.updatedAt = at;
  order.paid = true;
  order.status = "QUEUED";
  order.pricesLocked = true;
  order.applyVat = false;
  order.vatAmount = null;
  order.shippingFee = null;
  order.receipt = { original: "", at, actor, clientId: "", legacy: false };
  order.confirmationSnapshot = {
    at,
    raw: "",
    client: structuredClone(order.clientSnapshot),
    recipients: structuredClone(order.recipients),
    data: structuredClone(order),
  };
  let next = reconcileWorkflow(input, order);
  const shipments = next.workflow!.shipments.filter((s) => s.orderId === order.id);
  for (const ship of shipments) {
    ship.step = 4;
    ship.completedAt = { 1: at };
    ship.sender = structuredClone(order.senderSnapshot);
  }
  next.workflow!.events.push({
    id: crypto.randomUUID(),
    at,
    actor,
    action: "주문 확인 완료",
    groupId: rootGroupId(order),
    shipmentIds: shipments.map((s) => s.id),
    after: { orderType: "RETAIL", externallyPaid: true },
  });
  next = processGroup(next, rootGroupId(order), actor);
  return next;
}
