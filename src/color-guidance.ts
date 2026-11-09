import { colorLabel, registeredProducts } from "./product-models.js";
import { renderAutomaticTemplate } from "./automatic-message-templates.js";
import type { Item, Product, State, Variant, Settings } from "./types.js";

export interface ColorGuidanceSuggestion { groupId: string; color: string }

function colorKey(value: string) { return colorLabel(value).trim().toLocaleLowerCase("ko"); }
function priceKey(v: Variant) { return JSON.stringify([v.wholesale,v.semi,v.retail]); }
export function validateColorGroupProducts(state: State, productIds: string[], representativeColor: string) {
  if (productIds.length < 2)
    throw Error("대표색상 그룹은 색상이 다른 독립 상품 2개 이상이 필요합니다.");
  const active = new Map(registeredProducts(state.products).map(p=>[p.id,p]));
  const products = productIds.map(id=>active.get(id));
  if (products.some(p=>!p || p.variants.length !== 1))
    throw Error("등록된 독립 판매 상품만 그룹에 추가하세요.");
  const members=products as Product[];
  const colors=members.map(p=>colorKey(p.variants[0].color));
  if (colors.some(value=>!value || ["단일","색상 미표기"].includes(value)))
    throw Error("실제 색상이 등록된 상품만 그룹에 추가하세요.");
  if (new Set(colors).size !== colors.length)
    throw Error("같은 색상 상품이 중복됐습니다. 다른 규격은 별도 그룹으로 관리하세요.");
  const first=members[0].variants[0];
  if ([first.wholesale,first.semi,first.retail].every(p=>p===null))
    throw Error("비교할 가격이 없는 상품은 대표색상 그룹으로 등록할 수 없습니다.");
  if (members.some(p=>priceKey(p.variants[0])!==priceKey(first)))
    throw Error("색상에 따라 가격이 다릅니다. 동일한 가격의 상품만 대표색상 그룹으로 등록하세요.");
  if (!colors.includes(colorKey(representativeColor)))
    throw Error("대표색상은 그룹에 등록된 상품의 실제 색상에서 선택하세요.");
}
function validGroup(state: State, ids: string[], color: string) {
  try { validateColorGroupProducts(state,ids,color); return true; }
  catch { return false; }
}

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
    validateColorGroupProducts(state,group.productIds,group.representativeColor);
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
  if (!validGroup(state,group.productIds,group.representativeColor)) return undefined;
  const color = colorLabel(group.representativeColor ?? "").trim();
  return color && !["단일","색상 미표기"].includes(color) ? {groupId,color} : undefined;
}

/** Created after employee selection only; customer notice, not a confirmation request. */
export function appliedDefaultColorNotice(item: Item, settings: Settings): string {
  const color = colorLabel(item.appliedDefaultColor?.color ?? "").trim();
  if (!color) return "";
  return renderAutomaticTemplate(settings,"colorDefault",{
    색상:color,상품명:item.name,
  });
}
