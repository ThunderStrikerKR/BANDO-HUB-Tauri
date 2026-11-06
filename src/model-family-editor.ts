import { groupMembers, modelGroup, representative, validateModelSettings } from "./model-families.js";
import { registeredProducts } from "./product-models.js";
import { modelKey } from "./matching.js";
import type { Product, State } from "./types.js";

export interface FamilySummary {
  id: string;
  code: string;
  members: Product[];
  representative?: Product;
}

/** Reflects explicit membership first and auto groups second, without duplicating products. */
export function familySummaries(state: State): FamilySummary[] {
  const groups = new Map<string, FamilySummary>();
  for (const product of registeredProducts(state.products)) {
    const group = modelGroup(state, product);
    if (!groups.has(group.id)) {
      groups.set(group.id, {
        id: group.id,
        code: group.code,
        members: groupMembers(state, group.id),
        representative: representative(state, group.id),
      });
    }
  }
  return [...groups.values()].sort((a, b) => a.code.localeCompare(b.code, "ko", { numeric: true }));
}

export function assignFamilyProduct(state: State, productId: string, destinationId: string) {
  const current = familySummaries(state);
  const source = current.find((g) => g.members.some((p) => p.id === productId));
  const dest = current.find((g) => g.id === destinationId);
  if (!source || !dest || source.id === dest.id) throw Error("다른 모델군을 선택하세요.");
  const next = structuredClone(state);
  const families = (next.settings.modelFamilies ??= {});
  // Materialize both memberships so later auto grouping cannot reattach a transferred product.
  const remaining = source.members.map((p) => p.id).filter((id) => id !== productId);
  if (remaining.length) families[source.id] = { code: source.code, productIds: remaining };
  else delete families[source.id];
  families[dest.id] = {
    code: dest.code,
    productIds: [...new Set([...dest.members.map((p) => p.id), productId])],
  };
  if (next.settings.modelRepresentatives?.[source.id]?.productId === productId)
    delete next.settings.modelRepresentatives[source.id];
  if (!remaining.length && next.settings.modelRepresentatives) delete next.settings.modelRepresentatives[source.id];
  validateModelSettings(next, state);
  return next;
}

export function combineFamilies(state: State, sourceId: string, destinationId: string) {
  const groups = familySummaries(state);
  const source = groups.find((g) => g.id === sourceId);
  const dest = groups.find((g) => g.id === destinationId);
  if (!source || !dest || sourceId === destinationId) throw Error("합칠 다른 모델군을 선택하세요.");
  const next = structuredClone(state);
  const families = (next.settings.modelFamilies ??= {});
  families[destinationId] = {
    code: dest.code,
    productIds: [...new Set([...dest.members, ...source.members].map((p) => p.id))],
  };
  delete families[sourceId];
  if (next.settings.modelRepresentatives) delete next.settings.modelRepresentatives[sourceId];
  validateModelSettings(next, state);
  return next;
}

export function renameFamily(state: State, id: string, code: string) {
  const name = code.trim();
  const groups = familySummaries(state);
  const current = groups.find((g) => g.id === id);
  if (!name || !current) throw Error("기본 모델 코드를 확인하세요.");
  if (groups.some((g) => g.id !== id && modelKey(g.code) === modelKey(name)))
    throw Error("다른 모델군에서 사용 중인 모델 코드입니다.");
  const next = structuredClone(state);
  (next.settings.modelFamilies ??= {})[id] = {
    code: name,
    productIds: current.members.map((p) => p.id),
  };
  validateModelSettings(next, state);
  return next;
}

export function setFamilyRepresentative(state: State, id: string, productId: string | null) {
  const group = familySummaries(state).find((g) => g.id === id);
  if (!group) throw Error("모델군을 찾을 수 없습니다.");
  const next = structuredClone(state);
  const mapping = (next.settings.modelRepresentatives ??= {});
  if (!productId) {
    delete mapping[id];
  } else {
    const product = group.members.find((p) => p.id === productId);
    if (!product) throw Error("선택한 상품은 이 모델군에 속하지 않습니다.");
    if (product.variants.length !== 1) {
      throw Error("옵션이 여러 개인 상품은 SKU를 먼저 개별 상품으로 정리해야 대표 상품으로 지정할 수 있습니다.");
    }
    mapping[id] = { productId, variantId: product.variants[0].id };
  }
  validateModelSettings(next, state);
  return next;
}
