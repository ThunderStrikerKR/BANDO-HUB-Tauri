import type { Item, Product, Settings, State } from "./types.js";
import { productModelNames } from "./product-name-match.js";

export type ProvisionalProductNotices = Record<string, string>;

export function validateProvisionalProductNotices(state: State) {
  const notices = state.settings.provisionalProductNotices ?? {};
  if (Object.keys(notices).length > 5000)
    throw Error("잠정 상품 안내문 등록 한도를 초과했습니다.");
  const ids = new Set(state.products.map(p => p.id));
  for (const [productId, text] of Object.entries(notices)) {
    if (!ids.has(productId)) throw Error("등록된 상품에만 안내문을 연결할 수 있습니다.");
    if (typeof text !== "string" || !text.trim() || [...text].length > 2000)
      throw Error("안내문은 1자 이상 2000자 이하로 입력하세요.");
  }
}

const escapeRegExp = (text: string) => text.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");

/** "709" is explicit only for 709, not for 709-1 or 709G. Never infer from grouping. */
export function originalStatesChosenCode(expression: string, product: Product): boolean {
  const codes = productModelNames(product);
  return codes.some(code =>
    [...new Set([code.trim(), code.trim().replace(/^BD[\s-]*/i, "")])]
      .filter(Boolean)
      .some(variant => {
        const pattern = variant.split(/\s+/).map(escapeRegExp).join("\\s*");
        return new RegExp("(^|[^A-Za-z0-9])" + pattern + "(?=$|[^A-Za-z0-9-])", "i")
          .test(expression);
      }),
  );
}

/** Intentionally scoped to staff resolution evidence. A regular sale never triggers it. */
export function provisionalProductNotice(item: Item, state: State): string {
  if (!item.productId || !item.variantId) return "";
  const evidence = item.selectionEvidence;
  if (!evidence || evidence.productId !== item.productId ||
      evidence.variantId !== item.variantId) return "";
  const product = state.products.find(p => p.id === item.productId);
  if (!product || originalStatesChosenCode(evidence.expression, product)) return "";
  return state.settings.provisionalProductNotices?.[product.id]?.trim() ?? "";
}
