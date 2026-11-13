import { registeredProducts } from "./product-models.js";
import { renderAutomaticTemplate } from "./automatic-message-templates.js";
import type { Item, Product, Settings, State } from "./types.js";

export interface RepresentativeModelSuggestion {
  groupId: string;
  productId: string;
  productName: string;
}

export function validateModelGroupProducts(
  state: State, productIds: string[], representativeProductId: string,
): void {
  if (!Array.isArray(productIds) || productIds.length < 2)
    throw Error("모델군에는 등록된 상품이 2개 이상 있어야 합니다.");
  if (new Set(productIds).size !== productIds.length)
    throw Error("모델군에 같은 상품을 중복 등록할 수 없습니다.");
  const active = new Map(registeredProducts(state.products)
    .filter(p => p.catalog !== "DEMO" && p.variants.every(v => v.source !== "DEMO"))
    .map(p => [p.id, p]));
  if (productIds.some(id => !active.has(id) || active.get(id)!.variants.length !== 1))
    throw Error("등록된 독립 판매 상품만 모델군에 추가할 수 있습니다.");
  if (!representativeProductId || !productIds.includes(representativeProductId))
    throw Error("모델군에 등록된 상품 중 하나를 대표모델로 지정하세요.");
}

/** Staff-created groups; price, size, top style and color never define membership. */
export function validateModelGroups(state: State): void {
  const groups = state.settings.colorGuidanceGroups ?? {};
  const names = new Set<string>();
  const members = new Set<string>();
  for (const [id, group] of Object.entries(groups)) {
    const name = group.name?.trim() ?? "";
    if (!id.trim() || !name) throw Error("모델군 이름을 입력하세요.");
    const key = name.toLocaleLowerCase("ko");
    if (names.has(key)) throw Error("모델군 이름이 중복됩니다.");
    names.add(key);
    if (group.representativeProductId) {
      validateModelGroupProducts(state, group.productIds, group.representativeProductId);
    } else {
      // Old saved color groups are preserved until staff chooses a specific SKU.
      if (!group.representativeColor)
        throw Error("기존 그룹도 대표모델을 직접 선택한 뒤 저장하세요.");
      const oldIds = group.productIds ?? [];
      if (oldIds.length < 2 || new Set(oldIds).size !== oldIds.length)
        throw Error("기존 그룹의 상품 연결을 확인하세요.");
    }
    for (const pid of group.productIds ?? []) {
      if (members.has(pid)) throw Error("상품은 하나의 모델군에만 등록할 수 있습니다.");
      members.add(pid);
    }
  }
}

/** Suggest only for an ambiguous candidate set entirely inside one saved group.
 * Selection is never automatic: the employee must explicitly accept the model. */
export function suggestGroupRepresentative(
  state: State, candidates: Product[],
): RepresentativeModelSuggestion | undefined {
  const ids = [...new Set(candidates.map(p => p.id))];
  if (ids.length < 2) return undefined;
  const active = new Set(registeredProducts(state.products).map(p => p.id));
  if (ids.some(id => !active.has(id))) return undefined;
  const matches = Object.entries(state.settings.colorGuidanceGroups ?? {}).filter(([, group]) =>
    !!group.representativeProductId &&
    ids.every(id => group.productIds?.includes(id)) &&
    ids.includes(group.representativeProductId));
  if (matches.length !== 1) return undefined;
  const [groupId, group] = matches[0];
  try {
    validateModelGroupProducts(state, group.productIds, group.representativeProductId!);
  } catch { return undefined; }
  const product = state.products.find(p => p.id === group.representativeProductId);
  return product ? { groupId, productId: product.id, productName: product.name } : undefined;
}

/** A notice is generated only after an employee explicitly applies the
 * representative product. Historical orders retain their recorded model name. */
export function appliedRepresentativeModelNotice(
  item: Item, settings: Pick<Settings, "automaticMessageTemplates"> = {},
): string {
  const selected = item.appliedRepresentativeModel;
  if (!selected || !item.productId || selected.productId !== item.productId) return "";
  const name = selected.productName?.trim() || item.name.trim();
  if (!name) return "";
  return renderAutomaticTemplate(settings, "modelRepresentative", { 상품명: name });
}
