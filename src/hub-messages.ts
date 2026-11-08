import { messages, orderClient, totals, unassignedClient, validProductUrl, won } from "./domain.js";
import { groupedCustomerQuestions } from "./customer-questions.js";
import { customerModel } from "./matching.js";
import { colorLabel } from "./product-models.js";
import { colorGuidanceQuestion } from "./color-guidance.js";
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
        block.customer = customerModel(item.name) + " 상품으로 보내드리면 될까요?\n" + item.url;
      else {
        block.title = "상품 링크 등록 필요";
        optionsIssues.push("추천 상품의 실제 링크를 등록하세요.");
      }
    }
    blocks.push(block);
  }
  customer.push(
    ...groupedCustomerQuestions({ ...order, recipients }, blocks as ValidationIssue[]).map(
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
  const parts = ["안녕하세요.", ""];
  for (const [index, r] of recipients.entries()) {
    if (r.name.trim()) parts.push(r.name + "님");
    for (const i of r.items) {
      const product = state.products.find((p) => p.id === i.productId);
      const color =
        product?.colorStatus === "NOT_REQUIRED" || !i.color ? "" : " (" + colorLabel(i.color) + ")";
      parts.push(
        `${customerModel(i.name)}${color} * ${i.quantity ?? "?"}개 : ${i.unitPrice !== null && i.quantity !== null ? won(i.unitPrice * i.quantity) : !client.id ? "거래처 선택 후 단가 적용" : "판매가 확인 필요"}`,
      );
    }
    parts.push(
      shipmentFreightCode(order, r) === "020"
        ? "운임 : 후불"
        : "운임 : " + won(amounts[index].shipping),
    );
    if (shipmentVat(order, r)) parts.push("부가세 : " + won(amounts[index].vat));
    if (links.payment)
      for (const line of [
        ...new Set(
          r.items.filter((i) => i.url && validProductUrl(i.url)).map((i) => i.name + "\n" + i.url),
        ),
      ])
        parts.push(line);
    for (const i of r.items)
      if (i.quantityApproval?.quantity === 1 && i.quantity === 1 && i.quantityConfirmed === false)
        parts.push(
          (r.name || "수취인") +
            "님 " +
            customerModel(i.name) +
            " 상품은 수량을 1개로 보내드리겠습니다.",
        );
    parts.push("");
  }
  const vats = recipients.map((r) => shipmentVat(order, r)),
    mixed = vats.some(Boolean) && vats.some((v) => !v);
  parts.push(
    "합계 : " +
      (sum("total") === null ? "금액 확인 필요" : won(sum("total"))) +
      " 입니다." +
      (mixed ? " (배송 건별 부가세 적용)" : vats.some(Boolean) ? "" : " (부가세 별도)"),
  );
  const account = groupId ? groupAccount(state, groupId) : undefined;
  const accountLine = account
    ? `${account.bank} ${account.number} ${account.holder} 입니다.`
    : (generated.payment
        .split("\n")
        .find((line) => line.endsWith(" 입니다.") && !line.startsWith("합계")) ??
      "[입금 계좌 등록 필요]");
  parts.push("", accountLine);
  const paymentIssues = generated.paymentIssues.filter(
    (i) => !(amounts.every((a) => a.shipping !== null) && i === "운임 확인 필요"),
  );
  if (amounts.some((a) => a.shipping === null)) paymentIssues.push("배송 건별 운임 확인 필요");
  const colorQuestions = recipients.flatMap(r => r.items.map(colorGuidanceQuestion)).filter(Boolean);
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
      (customer.length || colorQuestions.length
        ? [...customer, ...colorQuestions].join("\n")
        : "주문 내용 확인 부탁드립니다.") +
      (optionLinks ? "\n\n" + optionLinks : ""),
    paymentIssues: [...new Set(paymentIssues)],
    customerCount: customer.length + colorQuestions.length,
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
