import { categoryPath } from "./category-tree.js";
import { withCatalogRoots } from "./category-roots.js";
import type { Category } from "./types.js";

export interface CategoryFilterLevel {
  depth: number;
  parentId: string | null;
  selectedId: string;
  children: Category[];
}

/** Every selected ancestor can expose one more dropdown; there is no depth cap.
 * Empty child-level selection means all products under its parent. */
export function categoryFilterLevels(categories: Category[], selectedId: string): CategoryFilterLevel[] {
  const all = withCatalogRoots(categories);
  const path = selectedId ? categoryPath(all, selectedId) : [];
  const selected = path.at(-1)?.id === selectedId ? path : [];
  const levels: CategoryFilterLevel[] = [];
  for (let depth = 0; depth <= selected.length; depth++) {
    const parentId = depth ? selected[depth - 1].id : null;
    const children = all.filter((category) =>
      (category.parentId ?? null) === parentId && category.active !== false,
    );
    if (!children.length && depth > 0) break;
    levels.push({
      depth, parentId,
      selectedId: selected[depth]?.id ?? "",
      children,
    });
  }
  return levels;
}
