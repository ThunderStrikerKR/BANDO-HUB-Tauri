import { messages, orderClient, recommendAccount, totals, unassignedClient, validProductUrl, won } from "./domain.js";
import { renderAutomaticTemplate } from "./automatic-message-templates.js";
import { groupedCustomerQuestions } from "./customer-questions.js";
import { customerModel } from "./matching.js";
import { colorLabel } from "./product-models.js";
import { appliedDefaultColorNotice } from "./color-guidance.js";
import type { Order, Price, State, ValidationIssue } from "./types.js";
import { orderIssues } from "./validation.js";
import {
  groupAccount,
  groupShipments,
  shipmentFreightCode,
  shipmentTotals,
  shipmentVat,
  workflowIssues,
} from "./workflow.js";
export interface StaffBlock extends Partial<ValidationIssue> {
  choices?: { label: string; value: string }[];
  recipientId: string;
  title: string;
  detail: string;
  customer?: string;
  linkKey?: string;
  itemId?: string;
}
export function hubMessages(
  order: Order,
  state: State,
  groupId?: string,
  links = { payment: false, options: false },
) {
  const optionsIssues: string[] = [];
  const client = orderClient(order, state) ?? unassignedClient,
    shipments = groupId ? groupShipments(state, groupId) : [],
    recipients = order.recipients.filter(
      (r) => !groupId || shipments.some((s) => s.recipientId === r.id),
    ),
    blocks: StaffBlock[] = [],
    customer: string[] = [];
  const validation = groupId ? workflowIssues(state, groupId) : orderIssues(order);
  for (const issue of validation.filter((i) => i.severity === "ACTION")) {
    const r = recipients.find((r) => r.id === issue.recipientId),
      item = r?.items.find((i) => i.id === issue.itemId);
    const block: StaffBlock = {
      ...issue,
      detail: issue.detail + (item?.recognitionReason ? " / " + item.recognitionReason : ""),
    };
    if (issue.kind === "MODEL_CONFIRM" && item) {
      if (validProductUrl(item.url))
        block.customer = renderAutomaticTemplate(state.settings,"modelConfirm",{
          상품명:customerModel(item.name),
        }) + "\n" + item.url;
      else {
        block.title = "상품 링크 등록 필요";
        optionsIssues.push("추천 상품의 실제 링크를 등록하세요.");
      }
    }
    blocks.push(block);
  }
  customer.push(
    ...groupedCustomerQuestions({ ...order, recipients }, blocks as ValidationIssue[],
      order.additionalQuestions ?? [], state.settings).map(
      (question, index) => `${index + 1}. ${question}`,
    ),
  );
  const generated = messages(
      { ...order, recipients },
      client,
      state.settings,
      { payment: false, options: false },
      state.products,
    ),
    amounts = recipients.map((r) => {
      const shipment = shipments.find((s) => s.recipientId === r.id);
      return shipment
        ? shipmentTotals(state, shipment)
        : totals(
            {
              ...order,
              recipients: [r],
              freightCode: shipmentFreightCode(order, r),
              applyVat: shipmentVat(order, r),
              shippingFee: client.shippingFeeExcluded
                ? 0
                : r.shippingCharges
                  ? Object.values(r.shippingCharges).every((v) => v !== null)
                    ? Object.values(r.shippingCharges).reduce<number>((n, v) => n + (v ?? 0), 0)
                    : null
                  : recipients.length === 1
                    ? order.shippingFee
                    : null,
              pricesLocked: false,
              vatAmount: null,
            },
            client,
          );
    });
  const sum = (field: "total" | "vat"): Price =>
    amounts.length && amounts.every((a) => a[field] !== null)
      ? amounts.reduce((n, a) => n + a[field]!, 0)
      : null;
  const parts = [renderAutomaticTemplate(state.settings,"paymentGreeting"), ""];
  for (const [index, r] of recipients.entries()) {
    if (r.name.trim()) parts.push(r.name + "님");
    for (const i of r.items) {
      const product = state.products.find((p) => p.id === i.productId);
      const color =
        product?.colorStatus === "NOT_REQUIRED" || !i.color ? "" : " (" + colorLabel(i.color) + ")";
      parts.push(renderAutomaticTemplate(state.settings,"paymentItem",{
        상품명:customerModel(i.name)+color,
        수량:String(i.quantity??"?"),
        금액:i.unitPrice !== null && i.quantity !== null
          ? won(i.unitPrice * i.quantity)
          : !client.id ? "거래처 선택 후 단가 적용" : "판매가 확인 필요",
      }));
      const notice = appliedDefaultColorNotice(i,state.settings);
      if (notice) parts.push(notice);
    }
    parts.push(renderAutomaticTemplate(state.settings,"paymentFreight",{
      운임:shipmentFreightCode(order, r)==="020" ? "후불" : won(amounts[index].shipping),
    }));
    if (shipmentVat(order, r))
      parts.push(renderAutomaticTemplate(state.settings,"paymentVat",{부가세:won(amounts[index].vat)}));
    if (links.payment)
      for (const line of [
        ...new Set(
          r.items.filter((i) => i.url && validProductUrl(i.url)).map((i) => i.name + "\n" + i.url),
        ),
      ])
        parts.push(line);
    for (const i of r.items)
      if (i.quantityApproval?.quantity === 1 && i.quantity === 1 && i.quantityConfirmed === false)
        parts.push(renderAutomaticTemplate(state.settings,"quantityOne",{
          수취인:r.name || "수취인",상품명:customerModel(i.name),
        }));
    parts.push("");
  }
  const vats = recipients.map((r) => shipmentVat(order, r)),
    mixed = vats.some(Boolean) && vats.some((v) => !v);
  parts.push(renderAutomaticTemplate(state.settings,"paymentTotal",{
    합계:sum("total")===null ? "금액 확인 필요" : won(sum("total")),
  })+(mixed ? " (배송 건별 부가세 적용)" : vats.some(Boolean) ? "" : " (부가세 별도)"));
  const account = (groupId ? groupAccount(state, groupId) : undefined)
    ?? recommendAccount(order,state.settings,state.products,client);
  const accountLine = account?.bank && account.number && account.holder
    ? renderAutomaticTemplate(state.settings,"paymentAccount",{
        은행명:account.bank,계좌번호:account.number,예금주:account.holder,
      })
    : "[입금 계좌 등록 필요]";
  parts.push("", accountLine);
  const paymentIssues = generated.paymentIssues.filter(
    (i) => !(amounts.every((a) => a.shipping !== null) && i === "운임 확인 필요"),
  );
  if (amounts.some((a) => a.shipping === null)) paymentIssues.push("배송 건별 운임 확인 필요");
  const colorNotices = recipients.flatMap(r => r.items.map(i=>appliedDefaultColorNotice(i,state.settings))).filter(Boolean);
  const optionLinks = links.options
    ? recipients
        .flatMap((r) => [
          ...new Set(
            r.items
              .filter((i) => i.url && validProductUrl(i.url))
              .map((i) => (r.name ? r.name + "님 / " : "") + i.name + "\n" + i.url),
          ),
        ])
        .join("\n")
    : "";
  return {
    validation,
    pass: blocks.length === 0 && paymentIssues.length === 0,
    blocks,
    payment: parts.join("\n"),
    options:
      (customer.length || colorNotices.length
        ? [...customer, ...colorNotices].join("\n")
        : renderAutomaticTemplate(state.settings,"optionsIntro")) +
      (optionLinks ? "\n\n" + optionLinks : ""),
    paymentIssues: [...new Set(paymentIssues)],
    customerCount: customer.length,
    mixedVat: mixed,
    optionsIssues,
  };
}
export const customerCopy = (text: string) =>
  text
    .split("\n")
    .filter((line) => !/^\s*\[.*\]\s*$/.test(line) && !/^\s*(?:PASS|NOT_PASS)\s*$/.test(line))
    .join("\n")
    .trim();
