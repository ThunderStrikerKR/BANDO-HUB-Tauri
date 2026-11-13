import { itemFromProduct, normalizeColor, orderClient, uid } from "./domain.js";
import { aliasProblems, saveAlias } from "./matching.js";
import { validateColorGroupProducts } from "./color-guidance.js";
import { validateModelGroupProducts } from "./model-groups.js";
import type { Order, State } from "./types.js";
export function resolveProduct(
  state: State,
  order: Order,
  rid: string,
  iid: string,
  productId: string,
  scope: "once" | "client" | "common",
  needsCustomer: boolean,
  variantId?: string,
  defaultColorGroupId?: string,
) {
  let next = structuredClone(state);
  const o = structuredClone(order),
    r = o.recipients.find((r) => r.id === rid),
    i = r?.items.find((i) => i.id === iid),
    p = next.products.find(
      (p) => p.id === productId && p.active !== false && !p.deletedAt && !p.supersededBy,
    ),
    c = orderClient(o, next);
  if (!r || !i || !p || !c) throw Error("거래처 / 수취인 / 등록 상품을 확인하세요.");
  const changedProduct = i.productId !== p.id || (!!variantId && i.variantId !== variantId);
  const old = {
    id: i.id,
    raw: i.raw,
    sources: i.sources,
    quantityConfirmed: i.quantityConfirmed,
    quantityApproval: i.quantityApproval,
  };
  const v = variantId ? p.variants.find((v) => v.id === variantId) : p.variants[0];
  if (!v) throw Error("실제 상품 옵션을 선택하세요.");
  let appliedDefaultColor: {groupId:string;color:string} | undefined;
  let appliedRepresentativeModel: {groupId:string;productId:string;productName:string} | undefined;
  if (defaultColorGroupId) {
    const group = next.settings.colorGuidanceGroups?.[defaultColorGroupId];
    if (!group || !group.productIds.includes(p.id)) {
      throw Error("대표모델 그룹과 선택 상품이 일치하지 않습니다.");
    }
    if (group.representativeProductId !== undefined) {
      validateModelGroupProducts(next,group.productIds,group.representativeProductId);
      if (group.representativeProductId !== p.id || p.variants.length !== 1 ||
          p.variants[0].id !== v.id) {
        throw Error("지정한 대표모델과 실제 선택 상품이 일치하지 않습니다.");
      }
      appliedRepresentativeModel = {groupId:defaultColorGroupId,productId:p.id,productName:p.name};
    } else {
      // Old already-approved color groups remain readable for historical orders.
      if (!group.representativeColor ||
          normalizeColor(group.representativeColor) !== normalizeColor(v.color) ||
          (i.color && !["색상 미표기", "단일"].includes(i.color))) {
        throw Error("기존 기본색상과 선택 상품이 일치하지 않습니다.");
      }
      validateColorGroupProducts(next,group.productIds,group.representativeColor);
      appliedDefaultColor = {groupId:defaultColorGroupId,color:v.color};
    }
  }
  delete i.pendingAlias;
  const chosen = itemFromProduct(p, c, v.color, i.quantity);
  Object.assign(i, chosen, old, {
    manuallyConfirmed: true,
    temporary: false,
    match: { kind: "NAME", term: p.name, productIds: [p.id] },
  });
  i.selectionEvidence = {
    expression:
      old.sources?.find((s) => s.field === "product")?.text ||
      old.raw.replace(/\s*\d+\s*(개|대).*$/, "").trim(),
    productId: p.id,
    variantId: v.id,
  };
  if (appliedDefaultColor) i.appliedDefaultColor = appliedDefaultColor;
  else delete i.appliedDefaultColor;
  if (appliedRepresentativeModel) i.appliedRepresentativeModel = appliedRepresentativeModel;
  else delete i.appliedRepresentativeModel;
  if (r.dispatchOrigin) i.origin = r.dispatchOrigin;
  if (changedProduct) delete i.quantityApproval;
  if (needsCustomer) {
    i.modelProposal = { original: old.raw, required: true };
    i.issues.push("추천 상품 고객 확인 필요");
  } else delete i.modelProposal;
  if (scope !== "once") {
    const text = old.raw.replace(/\s*(?:\d+)\s*(?:개|대|세트|ea).*$/i, "").trim();
    const record = {
      id: uid(),
      text,
      productId: p.id,
      variantId: v.id,
      clientId: scope === "common" ? null : c.id,
      createdAt: new Date().toISOString(),
      actor: next.settings.operatorName || "직원",
    };
    if (needsCustomer) {
      const errors = aliasProblems(record, next.aliases, next.products);
      if (errors.length) throw Error(errors.join("\n"));
      i.pendingAlias = record;
    } else next = saveAlias(next, record);
  }
  return { state: next, order: o };
}

export function confirmProposedProduct(state: State, order: Order, rid: string, iid: string) {
  let next = structuredClone(state);
  const o = structuredClone(order),
    i = o.recipients.find((r) => r.id === rid)?.items.find((i) => i.id === iid);
  if (!i?.modelProposal?.required) throw Error("고객 확인 대기 품목을 선택하세요.");
  if (i.pendingAlias) next = saveAlias(next, i.pendingAlias);
  delete i.pendingAlias;
  i.modelProposal.required = false;
  i.issues = i.issues.filter((t) => t !== "추천 상품 고객 확인 필요");
  return { state: next, order: o };
}
