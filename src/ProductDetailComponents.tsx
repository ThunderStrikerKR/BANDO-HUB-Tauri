import { useState } from "react";
import { categoryPath } from "./category-tree";
import { CATALOG_ROOTS, withCatalogRoots } from "./category-roots";
import { Modal } from "./ui";
import type { Brand } from "./product-registry";
import type { Category } from "./types";

const normalize = (text: string) => text.normalize("NFKC").toLocaleLowerCase().replace(/[\s._-]/g, "");

/** One searchable field, one canonical brand ID. Free text never becomes a brand ID. */
export function BrandCombobox({
  brands,
  brandId,
  onChange,
}: {
  brands: Brand[];
  brandId?: string;
  onChange: (id?: string) => void;
}) {
  const current = brands.find((b) => b.id === brandId);
  const [text, setText] = useState(current?.name ?? "");
  const [open, setOpen] = useState(false);
  const result = brands.filter((b) =>
    !text.trim() || [b.name, b.korean, ...b.aliases].some((name) => normalize(name).includes(normalize(text))),
  );
  return (
    <div className="product-brand-combobox" onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
    }}>
      <input
        id="product-detail-brand"
        aria-label="제조사(브랜드)"
        aria-expanded={open}
        aria-controls="product-detail-brand-results"
        role="combobox"
        autoComplete="off"
        placeholder="브랜드 이름 또는 별칭 검색"
        value={text}
        onFocus={() => setOpen(true)}
        onChange={(event) => {
          setText(event.target.value);
          onChange(undefined);
          setOpen(true);
        }}
      />
      {open && (
        <div className="product-brand-results" id="product-detail-brand-results" role="listbox">
          <button type="button" role="option" aria-selected={!brandId} onClick={() => {
            setText("");onChange(undefined);setOpen(false);
          }}>브랜드 미지정</button>
          {result.map((brand) => (
            <button
              type="button"
              role="option"
              key={brand.id}
              aria-selected={brand.id === brandId}
              onClick={() => {setText(brand.name);onChange(brand.id);setOpen(false);}}
            >
              <strong>{brand.name}</strong>
              <small>{[brand.korean, ...brand.aliases].filter(Boolean).join(" / ")}</small>
            </button>
          ))}
          {!result.length && <p>검색 결과가 없습니다.</p>}
        </div>
      )}
    </div>
  );
}

export function ProductCategoryPicker({
  categories,
  onClose,
  onSelect,
}: {
  categories: Category[];
  onClose: () => void;
  onSelect: (id: string) => void;
}) {
  const cats = withCatalogRoots(categories);
  const [search, setSearch] = useState("");
  const [path, setPath] = useState<string[]>([]);
  const currentParent = path.at(-1) ?? null;
  const active = cats.filter((c) => c.active !== false);
  const all = active.filter((c) => {
    if (!search.trim()) return c.parentId === currentParent &&
      (currentParent !== null || CATALOG_ROOTS.some((root) => root.id === c.id));
    const text = categoryPath(cats, c.id).map((item) => item.name).join(" / ");
    return text.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()) &&
      CATALOG_ROOTS.some((root) => categoryPath(cats, c.id)[0]?.id === root.id);
  });
  return (
    <Modal title="카테고리 선택" onClose={onClose} className="category-picker-dialog">
      <div className="category-picker-content">
        <input
          autoFocus
          value={search}
          placeholder="카테고리 이름 또는 전체 경로 검색"
          aria-label="카테고리 검색"
          onChange={(event) => setSearch(event.target.value)}
        />
        <nav className="category-picker-breadcrumbs" aria-label="카테고리 경로">
          <button onClick={() => {setPath([]);setSearch("");}}>전체</button>
          {path.map((id, index) => {
            const node = cats.find((c) => c.id === id);
            return <button key={id} onClick={() => {setPath(path.slice(0, index + 1));setSearch("");}}>/ {node?.name}</button>;
          })}
        </nav>
        <div className="category-picker-options">
          {all.map((c) => {
            const descendants = active.filter((node) => node.parentId === c.id);
            const currentPath = categoryPath(cats, c.id).map((node) => node.name).join(" / ");
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => {
                  if (descendants.length) {
                    setPath(categoryPath(cats, c.id).map((node) => node.id));
                    setSearch("");
                  } else if (!CATALOG_ROOTS.some((root) => root.id === c.id)) onSelect(c.id);
                }}
              >
                <span>{search ? currentPath : c.name}</span>
                <small>{descendants.length ? "하위 분류 ›" : CATALOG_ROOTS.some((root) => root.id === c.id) ? "하위 분류 없음" : "선택"}</small>
              </button>
            );
          })}
          {!all.length && <p>선택 가능한 분류가 없습니다. 카테고리 관리에서 분류 소속을 먼저 확인하세요.</p>}
        </div>
        <p className="product-category-hint">최하위 분류만 선택할 수 있습니다.</p>
      </div>
    </Modal>
  );
}
