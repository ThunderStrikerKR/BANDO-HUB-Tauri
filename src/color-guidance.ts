import { colorLabel, registeredProducts } from "./product-models.js";
import type { Item, Product, State } from "./types.js";

export interface ColorGuidanceSuggestion { groupId: string; color: string }

/** Never build groups from product codes: staff membership alone is authoritative. */
export function validateColorGuidance(state: State) {
  const groups = state.settings.colorGuidanceGroups ?? {};
  const names = new Set<string>(), members = new Set<string>();
  const active = new Set(registeredProducts(state.products).map(p => p.id));
  for (const [id,group] of Object.entries(groups)) {
    const name = group.name?.trim();
    const color = colorLabel(group.representativeColor ?? "").trim();
    if (!id.trim() || !name || !color || ["단일","색상 미표기"].includes(color))
      throw Error("그룹 이름과 대표색상을 직접 입력하세요.");
    const key = name.toLocaleLowerCase("ko");
    if (names.has(key)) throw Error("그룹 이름이 중복됩니다.");
    names.add(key);
    if (!group.productIds?.length || group.productIds.length !== new Set(group.productIds).size)
      throw Error("그룹에 중복 없이 실제 상품을 등록하세요.");
    for (const productId of group.productIds) {
      if (!active.has(productId)) throw Error("활성 판매 상품만 추가할 수 있습니다.");
      if (members.has(productId)) throw Error("같은 상품을 여러 그룹에 등록할 수 없습니다.");
      members.add(productId);
    }
  }
}

/** Only suggest when every exact candidate belongs to one explicitly saved group. */
export function suggestGroupColor(state: State, candidates: Product[]): ColorGuidanceSuggestion | undefined {
  const ids = [...new Set(candidates.map(p => p.id))];
  if (!ids.length) return undefined;
  const active = new Set(registeredProducts(state.products).map(p => p.id));
  if (ids.some(id => !active.has(id))) return undefined;
  const matches = Object.entries(state.settings.colorGuidanceGroups ?? {}).filter(([,g]) =>
    g.productIds?.length && ids.every(id=>g.productIds.includes(id)));
  if (matches.length !== 1) return undefined;
  const [groupId,group] = matches[0];
  const color = colorLabel(group.representativeColor ?? "").trim();
  return color && !["단일","색상 미표기"].includes(color) ? {groupId,color} : undefined;
}

/** Created after employee selection only; customer notice, not a confirmation request. */
export function appliedDefaultColorNotice(item: Item): string {
  const color = colorLabel(item.appliedDefaultColor?.color ?? "").trim();
  if (!color) return "";
  return "별도 색상 지정이 없어 " + item.name + " 상품은 기본색상 " +
    color + "으로 접수했습니다.";
}
