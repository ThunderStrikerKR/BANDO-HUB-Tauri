import { customerModel } from "./matching.js";
import { renderAutomaticTemplate } from "./automatic-message-templates.js";
import type { Order, Settings, ValidationIssue } from "./types.js";

/** Only outgoing copy is grouped; original validation records remain independent. */
export function groupedCustomerQuestions(
  order: Order,
  issues: ValidationIssue[],
  additional = order.additionalQuestions ?? [],
  settings?: Settings,
) {
  const questions: string[] = [];
  for (const row of order.recipients) {
    const labels = new Set<string>(),
      messages = new Set<string>();
    for (const issue of issues.filter(
      (issue) => issue.recipientId === row.id && issue.severity === "ACTION",
    )) {
      const customKey = issue.kind === "NAME" ? "recipientName"
        : issue.kind === "ADDRESS" ? (row.address.trim() ? "addressDetail" : "addressMissing")
        : issue.kind === "CONTACT" ? "contactMissing"
        : ["QUANTITY_MISSING","QUANTITY_INVALID"].includes(issue.kind) ? "quantityMissing"
        : null;
      if (settings && customKey && settings.automaticMessageTemplates?.[customKey]) {
        const item = row.items.find(item=>item.id===issue.itemId);
        messages.add(renderAutomaticTemplate(settings,customKey as
          "recipientName"|"addressMissing"|"addressDetail"|"contactMissing"|"quantityMissing",{
          수취인:row.name || "수취인",상품명:customerModel(item?.name || "상품"),
        }).replace(new RegExp("^"+row.name.replace(/[.*+?^${}()|[\]\\]/g,"\\      if (issue.kind === "NAME") labels.add("수취인 성함");")+"님[, ]*"),""));
      }
      else if (issue.kind === "NAME") labels.add("수취인 성함");
      else if (issue.kind === "ADDRESS")
        labels.add(row.address.trim() ? "상세주소" : "배송지 주소");
      else if (issue.kind === "CONTACT") labels.add("연락처");
      else if (["QUANTITY_MISSING", "QUANTITY_INVALID"].includes(issue.kind)) {
        const item = row.items.find((item) => item.id === issue.itemId);
        if (item?.productId) labels.add(`${customerModel(item.name)} 수량`);
      } else if (issue.customer)
        messages.add(
          issue.customer.replace(
            new RegExp(`^${row.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}님[, ]*`),
            "",
          ),
        );
    }
    for (const question of additional)
      if (
        question.recipientId === row.id &&
        row.items.some(
          (item) =>
            item.id === question.itemId && (!item.productId || item.modelProposal?.required),
        )
      )
        messages.add(question.text.replace(`${row.name}님`, "").replace(/^[,\s]+/, ""));
    const text = [labels.size ? `${[...labels].join("와 ")} 확인 부탁드립니다.` : "", ...messages]
      .filter(Boolean)
      .join(" ");
    if (text) questions.push(`${row.name || "수취인"}님, ${text}`);
  }
  return questions;
}
