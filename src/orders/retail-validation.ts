import { saleIssues } from "../sale-status.js";
import { companySenderMissing } from "../order-types.js";
import { orderIssues } from "../validation.js";
import type { Order, State } from "../types.js";
export function retailIssues(order: Order, state: State) {
  const issues = orderIssues(order)
    .filter((i) => i.severity === "ACTION")
    .map((i) => i.title);
  for (const row of order.recipients) {
    if (!["FACTORY", "STORE"].includes(row.dispatchOrigin ?? ""))
      issues.push("출고지를 선택하세요.");
    if (
      row.actualFreight !== undefined &&
      row.actualFreight !== null &&
      (!Number.isSafeInteger(row.actualFreight) || row.actualFreight < 0)
    )
      issues.push("실제 출고 운임을 확인하세요.");
    for (const item of row.items) {
      if (
        !state.products.some(
          (p) =>
            p.active !== false &&
            !p.deletedAt &&
            !p.supersededBy &&
            p.id === item.productId &&
            p.variants.some((v) => v.id === item.variantId),
        )
      )
        issues.push("등록된 상품과 옵션을 선택하세요.");
      if (item.quantityConfirmed !== true) issues.push("상품 수량을 직접 확정하세요.");
    }
  }
  issues.push(...companySenderMissing(state.settings), ...saleIssues(state, order));
  return [...new Set(issues)];
}
