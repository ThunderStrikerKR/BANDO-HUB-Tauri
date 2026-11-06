import type { Category, State } from "./types.js";
export function categoryPath(cats: Category[], id: string): Category[] {
  const result: Category[] = [],
    seen = new Set<string>();
  while (id) {
    if (seen.has(id)) throw Error("카테고리가 순환합니다.");
    seen.add(id);
    const c = cats.find((c) => c.id === id);
    if (!c) break;
    result.unshift(c);
    id = c.parentId ?? "";
  }
  return result;
}
export function descendants(cats: Category[], id: string) {
  return new Set(
    cats.filter((c) => categoryPath(cats, c.id).some((p) => p.id === id)).map((c) => c.id),
  );
}
export function categoryProducts(s: State, id: string) {
  const ids = descendants(s.categories ?? [], id);
  return s.products.filter(
    (p) => !p.deletedAt && !p.supersededBy && p.categories?.some((c) => ids.has(c)),
  );
}
export function validateCategories(s: State, before?: State) {
  const cats = s.categories ?? [];
  if (new Set(cats.map((c) => c.id)).size !== cats.length) throw Error("카테고리 ID가 중복됩니다.");
  for (const c of cats) {
    if (!c.name.trim() || (c.parentId && !cats.some((p) => p.id === c.parentId)))
      throw Error("카테고리 이름과 상위를 확인하세요.");
    categoryPath(cats, c.id);
  }
  for (const p of s.products) {
    const old = before?.products.find((x) => x.id === p.id);
    if (!old || JSON.stringify(old.categories) === JSON.stringify(p.categories)) continue;
    for (const id of p.categories ?? []) {
      const c = cats.find((c) => c.id === id);
      if (!c) continue; // Legacy catalog identifiers are retained until explicitly reclassified.
      if (
        categoryPath(cats, id).some((p) => p.active === false) ||
        cats.some((x) => x.parentId === id && p.categories?.includes(x.id) === false)
      )
        throw Error("활성 최하위 카테고리에 배정하세요.");
    }
  }
}
export function changeCategory(
  input: State,
  id: string,
  name: string,
  parentId: string | null,
  transfer = false,
) {
  const s = structuredClone(input),
    cats = (s.categories ??= []);
  if (
    !name.trim() ||
    cats.some((c) => c.id !== id && c.parentId === parentId && c.name === name.trim())
  )
    throw Error("분류 이름을 확인하세요.");
  const isNew = !cats.some((c) => c.id === id);
  const affected =
    isNew && parentId && !cats.some((c) => c.parentId === parentId)
      ? s.products.filter((p) => p.categories?.includes(parentId))
      : [];
  if (affected.length && !transfer)
    throw Error(`기존 상품 ${affected.length}개 이전 확인이 필요합니다.`);
  if (isNew) cats.push({ id, name: name.trim(), parentId });
  else Object.assign(cats.find((c) => c.id === id)!, { name: name.trim(), parentId });
  for (const p of affected) p.categories = p.categories!.map((c) => (c === parentId ? id : c));
  const oldAncestors = new Set(
      categoryPath(input.categories ?? [], id)
        .slice(0, -1)
        .map((c) => c.id),
    ),
    moved = descendants(input.categories ?? [], id);
  for (const p of s.products) {
    if (!isNew && p.categories?.some((c) => moved.has(c)))
      p.categories = p.categories.filter((c) => !oldAncestors.has(c));
    if (affected.some((x) => x.id === p.id))
      p.categories = p.categories?.filter((c) => !cats.some((x) => x.parentId === c));
  }
  for (const p of s.products)
    if (p.categories?.length)
      p.category = categoryPath(cats, p.categories.at(-1)!)
        .map((c) => c.name)
        .join(" > ");
  validateCategories(s, input);
  return s;
}
export function deleteCategory(input: State, id: string, destination = "") {
  const s = structuredClone(input),
    cats = s.categories ?? [];
  if (cats.some((c) => c.parentId === id)) throw Error("하위 카테고리를 먼저 이동하세요.");
  const current = cats.find((c) => c.id === id);
  if (!current) throw Error("분류를 찾을 수 없습니다.");
  if (destination) {
    const target = cats.find((c) => c.id === destination);
    if (
      !target ||
      target.id === id ||
      target.parentId !== current.parentId ||
      target.active === false ||
      cats.some((c) => c.parentId === destination)
    )
      throw Error("같은 상위의 활성 최하위 분류를 선택하세요.");
  }
  s.categories = cats.filter((c) => c.id !== id);
  for (const p of s.products)
    if (p.categories?.includes(id)) {
      p.categories = [
        ...new Set(
          p.categories
            .filter((c) => !categoryPath(cats, id).some((x) => x.id === c))
            .concat(destination ? [destination] : []),
        ),
      ];
      p.category = p.categories.length
        ? categoryPath(s.categories, p.categories.at(-1)!)
            .map((c) => c.name)
            .join(" > ")
        : "미분류";
    }
  validateCategories(s, input);
  return s;
}
