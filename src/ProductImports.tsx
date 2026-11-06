import { useState } from "react";
import { confirmAction } from "./dialogs";
import { won } from "./domain";
import { applyOfficialProductPreview, leafCategories } from "./official-product-import";
import type { NoticeSink } from "./shared/notices";
import { useAsyncTask } from "./shared/useAsyncTask";
import type { ImportPreview, State } from "./types";
import { Field } from "./ui";

export function ProductImports({
  state, onSave, onRefresh, onNotice,
}: {
  state: State;
  onSave: (s: State) => Promise<void>;
  onRefresh: () => Promise<void>;
  onNotice: NoticeSink;
}) {
  const { busy, run } = useAsyncTask(onNotice);
  const [url, setUrl] = useState("");
  const [preview, setPreview] = useState<ImportPreview>();
  const [categoryId, setCategoryId] = useState("");

  const analyze = () => void run(async () => {
    setPreview(undefined);
    setCategoryId("");
    const result = await window.bando!.previewImport(url.trim());
    setPreview(result);
  });
  const apply = () => void run(async () => {
    if (!preview?.canApply) return;
    const title = preview.existingId ? "기존 상품의 공식 소매가만 변경" : "새 상품 등록";
    if (!(await confirmAction(title + "을 진행할까요? 도매가와 반도매가는 수정하지 않습니다."))) return;
    const latest = await window.bando!.load();
    const result = applyOfficialProductPreview(latest, preview, categoryId || undefined);
    // Keep a consistent copy of user data before changing the canonical state.
    await window.bando!.backup();
    await onSave(result.next);
    await onRefresh();
    setPreview(undefined);
    onNotice(result.created
      ? "공식 상품을 새로 등록했습니다. 미등록 단가와 옵션은 상품 상세에서 확인하세요."
      : "확인된 공식 소매가를 갱신했습니다. 기존 도매가와 반도매가는 유지했습니다.",
    "success");
  });

  const categories = preview
    ? leafCategories(state, preview.product.catalog ?? "BANDOSTAND")
    : [];
  return (
    <section className="card">
      <h3>공식 홈페이지 상품 가져오기</h3>
      <Field label="공식 상품 상세페이지 URL">
        <input
          value={url}
          onChange={(event) => { setUrl(event.target.value); setPreview(undefined); }}
          placeholder="https://bandostand.com/product/.../상품번호/"
        />
      </Field>
      <button type="button" disabled={busy || !url.trim()} onClick={analyze}>
        공식 페이지 분석 / 미리보기
      </button>
      {preview && (
        <div className="official-product-preview">
          <h4>{preview.product.name}</h4>
          <p>모델코드: {preview.product.code}</p>
          <p>원본 상품번호: {preview.product.siteId}</p>
          <p>공식 소매가: {won(preview.product.variants[0]?.retail ?? null)}</p>
          <p>
            {preview.existingId
              ? "기존 상품과 원본 상품번호가 일치합니다. 단일 옵션 소매가만 갱신합니다."
              : "신규 상품 후보입니다. 카테고리를 선택한 후 승인할 수 있습니다."}
          </p>
          {preview.warnings.map((warning, index) => (
            <p key={index} className={preview.canApply ? "muted" : "warnings"}>{warning}</p>
          ))}
          {preview.canApply && !preview.existingId && (
            <Field label="등록할 카테고리">
              <select value={categoryId} onChange={(event) => setCategoryId(event.target.value)}>
                <option value="">카테고리 선택</option>
                {categories.map((cat) => (
                  <option key={cat.id} value={cat.id}>{cat.label}</option>
                ))}
              </select>
            </Field>
          )}
          {!preview.canApply && (
            <p className="warnings">
              해당 상품은 자동 반영을 제한했습니다. 색상과 선택 옵션을 확인한 뒤 상품 상세관리 또는
              Excel 대량 등록으로 입력하세요.
            </p>
          )}
          {preview.canApply && !preview.existingId && categories.length === 0 && (
            <p className="warnings">
              현재 상품군에 선택 가능한 최하위 카테고리가 없습니다.
              카테고리 관리에서 먼저 하위 분류를 구성하세요.
            </p>
          )}
          <div className="actions">
            <button type="button" onClick={() => setPreview(undefined)} disabled={busy}>
              미리보기 닫기
            </button>
            <button type="button" className="primary" onClick={apply}
              disabled={busy || !preview.canApply || (!preview.existingId && !categoryId)}>
              {preview.existingId ? "공식 소매가 반영" : "신규 상품 등록"}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
