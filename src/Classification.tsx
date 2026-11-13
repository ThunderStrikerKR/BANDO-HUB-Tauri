import { useState } from "react";
import { categoryFilterLevels } from "./category-filter-levels";
import { sameValue } from "./shared/draft";
import { requestEditorLeave, usePageLeaveGuard } from "./shared/page-leave";
import { CategoriesPanel } from "./ManagementUI";
import { classifiedProducts, type Brand } from "./product-registry";
import { businessCoreCall } from "./tauri-bridge";
import type { NoticeSink } from "./shared/notices";
import type { Product, State } from "./types";
import { Field } from "./ui";
import { Button } from "./ui/Button";
export function ClassificationFilters({
  state,
  category,
  brand,
  onChange,
}: {
  state: State;
  category: string;
  brand: string;
  onChange: (category: string, brand: string) => void;
}) {
  const levels = categoryFilterLevels(state.categories ?? [], category);
  const available = new Set(classifiedProducts(state, category).map((p) => p.brandId));
  return (
    <>
      <div className="product-category-filter" role="group" aria-label="상품 카테고리 필터">
        {levels.map((level) => (
          <select
            key={level.parentId ?? "category-root"}
            aria-label={`카테고리 ${level.depth + 1}단계`}
            value={level.selectedId}
            onChange={(event) =>
              onChange(event.target.value || level.parentId || "", brand)
            }
          >
            <option value="">{level.depth === 0 ? "전체 카테고리" : "현재 분류 전체"}</option>
            {level.children.map((child) => (
              <option key={child.id} value={child.id}>{child.name}</option>
            ))}
          </select>
        ))}
        {category && (
          <button type="button" onClick={() => onChange("", brand)}>
            카테고리 초기화
          </button>
        )}
      </div>
      <select
        aria-label="상품 브랜드"
        value={brand}
        onChange={(event) => onChange(category, event.target.value)}
      >
        <option value="">전체 브랜드</option>
        {state.brands
          ?.filter((b) => available.has(b.id) || b.id === brand)
          .map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
      </select>
    </>
  );
}
export function RegistrySettings({
  state,
  onSave,
  onNotice,
  categories = true,
}: {
  state: State;
  onSave: (s: State) => Promise<void>;
  onNotice: NoticeSink;
  categories?: boolean;
}) {
  const [name, setName] = useState(""),
    [korean, setKorean] = useState(""),
    [aliases, setAliases] = useState(""),
    [evidence, setEvidence] = useState(""),
    [editing, setEditing] = useState<string>();
  const [initialForm, setInitialForm] = useState({
    name:"",korean:"",aliases:"",evidence:"",editing:undefined as string|undefined,
  });
  const dirty = !sameValue({name,korean,aliases,evidence,editing},initialForm);
  const discard = () => {
    setName(initialForm.name);setKorean(initialForm.korean);setAliases(initialForm.aliases);
    setEvidence(initialForm.evidence);setEditing(initialForm.editing);
  };
  const saveBrand = async (): Promise<boolean> => {
    try {
      // Rust normalizes aliases, validates official evidence and prevents
      // cross-brand collisions. The existing onSave persists only that result.
      const { state: next } = await businessCoreCall<{ state: State }>(
        "catalog_clients", "upsert_brand", {
          state, editing, id: editing ?? crypto.randomUUID(),
          name, korean, aliases, evidence,
        },
      );
      await onSave(next);
      onNotice("브랜드 정보를 저장했습니다. 기존 연결 상품은 유지됩니다.","success");
      setEditing(undefined);setName("");setKorean("");setAliases("");setEvidence("");
      setInitialForm({name:"",korean:"",aliases:"",evidence:"",editing:undefined});
      return true;
    } catch (error) {
      onNotice(String(error),"error");
      return false;
    }
  };
  usePageLeaveGuard({label:"브랜드",hasChanges:()=>dirty,save:saveBrand,discard});
  const chooseBrand = async (brand: Brand) => {
    if (editing === brand.id) return;
    if (dirty) {
      const leave = await requestEditorLeave({
        label: "브랜드",
        hasChanges: () => dirty,
        save: saveBrand,
        discard,
      }, (message) => onNotice(message, "error"));
      if (!leave.proceed) return;
    }
    setEditing(brand.id);
    setName(brand.name);
    setKorean(brand.korean);
    setAliases(brand.aliases.join(","));
    setEvidence(brand.evidenceUrl);
    setInitialForm({name:brand.name,korean:brand.korean,aliases:brand.aliases.join(","),evidence:brand.evidenceUrl,editing:brand.id});
  };
  return (
    <>
      <section className="card registry-brand-manager">
        <h2>브랜드 관리</h2>
        <p>
          공식명 / 한글명 / 검색 별칭을 직원이 확인해 연결합니다. 유사한 이름을 자동 병합하지 않습니다.
        </p>
        <div className="registry-edit-form">
          <Field label="공식 브랜드명">
            <input aria-label="브랜드 공식명" placeholder="공식 브랜드명" value={name}
              onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="한글 표기">
            <input aria-label="브랜드 한글명" placeholder="확인된 한글 표기" value={korean}
              onChange={(e) => setKorean(e.target.value)} />
          </Field>
          <Field label="검색 별칭">
            <input aria-label="브랜드 검색 별칭" placeholder="별칭 (쉼표 구분)" value={aliases}
              onChange={(e) => setAliases(e.target.value)} />
          </Field>
          <Field label="확인 근거 URL">
            <input aria-label="브랜드 확인 근거" placeholder="확인 근거 URL" value={evidence}
              onChange={(e) => setEvidence(e.target.value)} />
          </Field>
          <div className="registry-edit-actions">
            <Button variant="primary" onClick={() => void saveBrand()}>브랜드 저장</Button>
          </div>
        </div>
        <div className="registry-list" role="list" aria-label="등록된 브랜드">
          {state.brands?.map((b) => (
            <div className="registry-row" role="listitem" key={b.id}>
              <div className="registry-row-info">
                <strong>{b.name}</strong>
                <span className="registry-row-meta">한글 표기: {b.korean || "없음"}</span>
                <span className="registry-row-meta">검색 별칭: {b.aliases.join(", ") || "없음"}</span>
              </div>
              <Button size="compact" onClick={() => void chooseBrand(b)}>정정</Button>
            </div>
          ))}
        </div>
      </section>
      {categories && <CategoriesPanel state={state} onSave={onSave} onError={onNotice} />}
    </>
  );
}
export function ProductClassification({
  state,
  product,
  onChange,
}: {
  state: State;
  product: Product;
  onChange: (p: Product) => void;
}) {
  return (
    <details>
      <summary>브랜드 / 여러 분류 연결</summary>
      <Field label="브랜드">
        <select
          value={product.brandId ?? ""}
          onChange={(e) => onChange({ ...product, brandId: e.target.value || undefined })}
        >
          <option value="">브랜드 미확인</option>
          {state.brands?.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
      </Field>
      <div className="category-paths">
        {state.categories
          ?.filter((c) => /[가-힣]/.test(c.name))
          .map((c) => (
            <label key={c.id}>
              <input
                type="checkbox"
                checked={product.categories?.includes(c.id) ?? false}
                onChange={(e) =>
                  onChange({
                    ...product,
                    categories: e.target.checked
                      ? [...(product.categories ?? []), c.id]
                      : (product.categories ?? []).filter((id) => id !== c.id),
                  })
                }
              />
              {c.parentId ? state.categories?.find((p) => p.id === c.parentId)?.name + " → " : ""}
              {c.name}
            </label>
          ))}
      </div>
    </details>
  );
}
