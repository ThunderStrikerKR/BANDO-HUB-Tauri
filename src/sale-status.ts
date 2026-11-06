import type { Product, State, Order } from "./types.js";
export const SALE_STATES = ["판매중", "품절", "판매준비중", "판매중지"] as const;
export function saleProblem(p: Product | undefined) {
  if (!p || p.deletedAt || p.supersededBy || p.active === false) return "판매중지";
  return !p.saleStatus ||
    p.saleStatus === "판매중" ||
    p.saleStatus === "SELLING" ||
    p.saleStatus === "판매 표시"
    ? ""
    : p.saleStatus;
}
export function saleIssues(s: State, o: Order) {
  return o.recipients.flatMap((r) =>
    r.items.flatMap((i) => {
      if (!i.productId) return [];
      const problem = saleProblem(s.products.find((p) => p.id === i.productId));
      return problem ? [`${r.name || "수취인"}: ${i.name} / ${problem} — 판매 상태 확인 필요`] : [];
    }),
  );
}
