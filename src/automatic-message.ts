import { validProductUrl } from "./domain.js";
import { appliedDefaultColorNotice } from "./color-guidance.js";
import { hubMessages } from "./hub-messages.js";
import { groupAccount, groupOrder, groupStep, workflowIssues } from "./workflow.js";
import type { State } from "./types.js";
export function automaticMessage(state: State, gid: string) {
  const order = groupOrder(state, gid),
    issues = workflowIssues(state, gid).filter(
      (i) => i.severity === "ACTION" && i.blockingStage <= 1,
    ),
    lines: string[] = [];
  let requiresCustomerResponse = false;
  for (const row of order.recipients) {
    const labels = issues
      .filter((i) => i.recipientId === row.id)
      .flatMap((i) => {
        if (i.kind === "ADDRESS") return ["배송지 주소"];
        if (i.kind === "CONTACT") return ["연락처"];
        if (i.kind === "NAME") return ["수취인명"];
        if (/QUANTITY/.test(i.kind))
          return [(row.items.find((item) => item.id === i.itemId)?.name || "상품") + " 수량"];
        if (
          [
            "MODEL",
            "MODEL_CHOICE",
            "ALIAS_CONFLICT",
            "CATEGORY_CONFLICT",
            "OPTION",
            "MODEL_CONFIRM",
            "ITEM",
          ].includes(i.kind)
        )
          return [(row.items.find((item) => item.id === i.itemId)?.name || "상품") + " 모델 / 옵션"];
        return [];
      });
    const colorNotices = row.items.map(appliedDefaultColorNotice).filter(Boolean);
    if (labels.length || colorNotices.length) {
      if (labels.length) requiresCustomerResponse = true;
      const links = row.items
        .filter((i) => i.modelProposal?.required && validProductUrl(i.url))
        .map((i) => i.name + "\n" + i.url);
      lines.push(
        [
          ...(labels.length ? [`${lines.length + 1}. ${row.name || "수취인"}님: ${[...new Set(labels)].join(", ")}`] : []),
          ...new Set(links),
          ...colorNotices,
        ].join("\n"),
      );
    }
  }
  const payment = hubMessages(order, state, gid, { payment: true, options: false });
  const phase = groupStep(state, gid) >= 2 && !requiresCustomerResponse ? "payment" : "request";
  const text =
    phase === "payment"
      ? payment.payment.replace(/^안녕하세요[.。]?\s*/, "")
      : lines.length
        ? lines.join("\n\n") + "\n\n위 내용 확인 부탁드립니다."
        : "";
  return { phase, text, paymentIssues: payment.paymentIssues };
}
export const withGreeting = (text: string) =>
  /^안녕하세요 반도스탠드입니다\./.test(text.trimStart())
    ? text
    : "안녕하세요 반도스탠드입니다.\n\n" + text;
export function paymentSignature(state: State, gid: string) {
  const order = groupOrder(state, gid);
  return JSON.stringify({
    text: hubMessages(order, state, gid, { payment: true, options: false }).payment,
    account: groupAccount(state, gid),
    items: order.recipients.map((r) =>
      r.items.map((i) => [i.productId, i.variantId, i.quantity, i.unitPrice]),
    ),
  });
}
export function paymentWasCopied(state: State, gid: string) {
  const signature = paymentSignature(state, gid);
  return (
    state.workflow?.events.some(
      (e) =>
        e.groupId === gid &&
        e.action === "메시지 복사" &&
        (e.after as { type?: string; signature?: string })?.type === "PAYMENT" &&
        (e.after as { signature?: string }).signature === signature,
    ) ?? false
  );
}
