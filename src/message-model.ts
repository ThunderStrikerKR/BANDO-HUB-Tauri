import { paymentSignature } from "./automatic-message.js";
import { uid, validProductUrl } from "./domain.js";
import { hubMessages } from "./hub-messages.js";
import { customerModel } from "./matching.js";
import { groupedCustomerQuestions } from "./customer-questions.js";
import type { State } from "./types.js";
import { groupOrder, groupShipments, workflowIssues } from "./workflow.js";
export function recordCopy(input: State, gid: string, type: "REQUEST" | "PAYMENT", token: string) {
  const next = structuredClone(input);
  if (
    next.workflow!.events.some(
      (e) => e.action === "메시지 복사" && (e.after as { token?: string })?.token === token,
    )
  )
    return next;
  next.workflow!.events.push({
    id: uid(),
    at: new Date().toISOString(),
    actor: next.settings.operatorName || "직원",
    groupId: gid,
    shipmentIds: groupShipments(next, gid).map((s) => s.id),
    action: "메시지 복사",
    after: {
      type,
      token,
      ...(type === "PAYMENT" ? { signature: paymentSignature(input, gid) } : {}),
    },
  });
  return next;
}
export function requestCopied(state: State, gid: string) {
  return (
    groupOrder(state, gid).requestCopiedGroups?.includes(gid) ||
    (state.workflow?.events.some(
      (e) =>
        e.groupId === gid &&
        e.action === "메시지 복사" &&
        (e.after as { type?: string })?.type === "REQUEST",
    ) ??
      false)
  );
}
export function requestDraft(state: State, gid: string) {
  const o = groupOrder(state, gid),
    issues = workflowIssues(state, gid).filter(
      (i) => i.severity === "ACTION" && o.requestedIssueIds?.includes(i.issueId),
    ),
    outbound = structuredClone(issues),
    missing: string[] = [];
  for (const issue of outbound) {
    const r = o.recipients.find((r) => r.id === issue.recipientId),
      i = r?.items.find((i) => i.id === issue.itemId);
    let text = issue.customer;
    if (issue.kind === "MODEL_CONFIRM" && i) {
      if (validProductUrl(i.url))
        text =
          "요청하신 " +
          (i.modelProposal?.original.replace(/\d+\s*(?:개|대).*$/, "").trim() || "상품") +
          "는 " +
          customerModel(i.name) +
          " 상품으로 보내드리면 될까요?\n" +
          i.url;
      else missing.push("상품 링크 등록 필요");
    }
    if (issue.kind === "QUANTITY_MISSING")
      text =
        (r?.name || "수취인") +
        "님 " +
        customerModel(i?.name || "상품") +
        " 수량을 확인 부탁드립니다.";
    issue.customer = text;
  }
  const questions = groupedCustomerQuestions(o, outbound);
  return {
    text: questions.map((s, i) => `${i + 1}. ${s}`).join("\n\n"),
    missing,
  };
}
export function paymentDraft(state: State, gid: string) {
  const o = groupOrder(state, gid),
    m = hubMessages(o, state, gid);
  return {
    ...m,
    text: requestCopied(state, gid) ? m.payment.replace(/^안녕하세요\.\s*\n?/, "") : m.payment,
  };
}
