import { categoryPath } from "./category-tree.js";
import type { Catalog, Category } from "./types.js";

/** Root identifiers are stable; legacy categories are never auto-reparented. */
export const CATALOG_ROOTS = [
  { id: "catalog-root:BANDOSTAND", name: "반도스탠드", catalog: "BANDOSTAND" },
  { id: "catalog-root:BANDOMALL", name: "반도몰", catalog: "BANDOMALL" },
] as const;

export function withCatalogRoots(categories: Category[] = []): Category[] {
  const roots: Category[] = CATALOG_ROOTS.filter(
    (root) => !categories.some((item) => item.id === root.id),
  ).map((root) => ({ id: root.id, name: root.name, parentId: null }));
  return [...categories, ...roots];
}

export function catalogFromCategory(categories: Category[], id: string): Catalog | undefined {
  const root = categoryPath(categories, id)[0];
  return CATALOG_ROOTS.find((row) => row.id === root?.id)?.catalog;
}

export function isCatalogRoot(id: string) {
  return CATALOG_ROOTS.some((root) => root.id === id);
}
