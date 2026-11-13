import { useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from "react";
import { ClassificationFilters } from "./Classification";
import { validProductUrl } from "./domain";
import { internalModel } from "./matching";
import { classifiedProducts } from "./product-registry";
import { searchProducts } from "./product-search";
import { useAsyncTask } from "./shared/useAsyncTask";
import type { Product, State } from "./types";
import { Modal } from "./ui";
export function ProductSearchDialog({
  state,
  clientId,
  onChoose,
  onClose,
  surface: Surface = Modal,
}: {
  state: State;
  clientId?: string;
  onChoose: (p: Product) => void;
  onClose: () => void;
  surface?: ComponentType<{ title: string; children: ReactNode; onClose: () => void }>;
}) {
  const { run: openLink } = useAsyncTask();
  const [query, setQuery] = useState(""),
    [category, setCategory] = useState(""),
    [brand, setBrand] = useState(""),
    input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const classifiedIds = useMemo(
    () => new Set(classifiedProducts(state, category, "", brand).map((p) => p.id)),
    [state.products, state.categories, category, brand],
  );
  const rows = useMemo(
    () =>
      searchProducts(state, query, clientId).filter(
        (p) =>
          p.catalog !== "DEMO" &&
          !p.variants.some((v) => v.source === "DEMO") &&
          classifiedIds.has(p.id),
      ),
    [state, query, clientId, category, brand],
  );
  return (
    <Surface title="상품 검색" onClose={onClose}>
      <div className="product-search-top">
        <input
          ref={input}
          aria-label="추가 상품 검색"
          placeholder="브랜드 / 상품명 / 모델 / 별칭 검색"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="manager-filters">
        <ClassificationFilters
          state={state}
          category={category}
          brand={brand}
          onChange={(nextCategory, nextBrand) => {
            setCategory(nextCategory);
            setBrand(nextBrand);
          }}
        />
      </div>
      <div className="product-search-results">
        {rows.slice(0, 100).map((p) => (
          <article key={p.id}>
            <button onClick={() => onChoose(p)}>
              <b>{internalModel(p.name)}</b>
              <span>{p.subtitle || p.specification}</span>
              <small>선택</small>
            </button>
            {validProductUrl(p.variants[0]?.url ?? "") && (
              <button
                onClick={() => void openLink(() => window.bando!.openProduct(p.variants[0].url))}
              >
                상세보기 ↗
              </button>
            )}
          </article>
        ))}
        {!rows.length && <p>검색 결과가 없습니다.</p>}
      </div>
    </Surface>
  );
}
