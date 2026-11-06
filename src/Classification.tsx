import { useState } from "react";
import { CategoriesPanel } from "./ManagementUI";
import { classifiedProducts, registryKey } from "./product-registry";
import type { NoticeSink } from "./shared/notices";
import type { Product, State } from "./types";
import { Field } from "./ui";
export function ClassificationFilters({
  state,
  major,
  minor,
  brand,
  onChange,
}: {
  state: State;
  major: string;
  minor: string;
  brand: string;
  onChange: (major: string, minor: string, brand: string) => void;
}) {
  const cats = state.categories ?? [],
    available = new Set(classifiedProducts(state, major, minor).map((p) => p.brandId));
  return (
    <>
      <select
        aria-label="상품 대분류"
        value={major}
        onChange={(e) => onChange(e.target.value, "", brand)}
      >
        <option value="">전체 대분류</option>
        {cats
          .filter((c) => !c.parentId && /[가-힣]/.test(c.name) && c.name !== "악세사리")
          .map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
      </select>
      <select
        aria-label="상품 소분류"
        value={minor}
        onChange={(e) => onChange(major, e.target.value, brand)}
      >
        <option value="">전체 소분류</option>
        {cats
          .filter((c) => c.parentId === major)
          .map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
      </select>
      <select
        aria-label="상품 브랜드"
        value={brand}
        onChange={(e) => onChange(major, minor, e.target.value)}
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
  return (
    <>
      <section className="card">
        <h2>브랜드 관리</h2>
        <p>
          공식명 / 한글명 / 검색 별칭을 직원이 확인해 연결합니다. 유사한 이름을 자동 병합하지 않습니다.
        </p>
        <div className="form-row">
          <input
            aria-label="브랜드 공식명"
            placeholder="공식 브랜드명"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <input
            aria-label="브랜드 한글명"
            placeholder="확인된 한글 표기"
            value={korean}
            onChange={(e) => setKorean(e.target.value)}
          />
          <input
            aria-label="브랜드 검색 별칭"
            placeholder="별칭 (쉼표 구분)"
            value={aliases}
            onChange={(e) => setAliases(e.target.value)}
          />
          <input
            aria-label="브랜드 확인 근거"
            placeholder="확인 근거 URL"
            value={evidence}
            onChange={(e) => setEvidence(e.target.value)}
          />
          <button
            onClick={async () => {
              try {
                if (!name.trim() || !/^https:\/\//.test(evidence))
                  throw Error("브랜드 공식명과 확인 근거 URL을 입력하세요.");
                if (
                  state.brands?.some(
                    (b) => b.id !== editing && registryKey(b.name) === registryKey(name),
                  )
                )
                  throw Error("동일 공식명이 있습니다. 기존 브랜드를 정정하세요.");
                const b = {
                  id: editing ?? crypto.randomUUID(),
                  name: name.trim(),
                  korean: korean.trim(),
                  aliases: aliases
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean),
                  evidenceUrl: evidence,
                };
                await onSave({
                  ...state,
                  brands: [...(state.brands ?? []).filter((b) => b.id !== editing), b],
                });
                setEditing(undefined);
                setName("");
                setKorean("");
                setAliases("");
                setEvidence("");
              } catch (e) {
                onNotice(String(e), "error");
              }
            }}
          >
            브랜드 저장
          </button>
        </div>
        {state.brands?.map((b) => (
          <p key={b.id}>
            {b.name} / {b.korean} / {b.aliases.join(", ")}{" "}
            <button
              onClick={() => {
                setEditing(b.id);
                setName(b.name);
                setKorean(b.korean);
                setAliases(b.aliases.join(","));
                setEvidence(b.evidenceUrl);
              }}
            >
              정정
            </button>
          </p>
        ))}
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
      <summary>브랜드 / 제조사 모델 / 여러 분류 연결</summary>
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
      <Field label="제조사 모델코드">
        <input
          value={product.manufacturerCode ?? ""}
          onChange={(e) => onChange({ ...product, manufacturerCode: e.target.value })}
        />
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
