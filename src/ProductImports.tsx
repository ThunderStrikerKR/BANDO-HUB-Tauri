import { useState } from "react";
import { confirmAction } from "./dialogs";
import { won } from "./domain";
import { applyOfficialProductPreview, leafCategories } from "./official-product-import";
import type { NoticeSink } from "./shared/notices";
import { useAsyncTask } from "./shared/useAsyncTask";
import type { ImportPreview, OfficialLink, State } from "./types";
import { Field } from "./ui";

export function ProductImports({
  state, onSave, onNotice,
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
  const [links, setLinks] = useState<OfficialLink[] | null>(null);
  const [linkSearch, setLinkSearch] = useState("");
  const matchingLinks = (links ?? []).filter((link) =>
    (link.name + " " + link.url).toLocaleLowerCase()
      .includes(linkSearch.trim().toLocaleLowerCase()));

  const loadKnownLinks = () => void run(async () => {
    const records = await window.bando!.officialList();
    setLinks(records);
  });
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
    // The common save already applied the committed SQLite snapshot.
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
      <div className="actions">
        <button type="button" disabled={busy || !url.trim()} onClick={analyze}>
          공식 페이지 분석 / 미리보기
        </button>
        <button type="button" disabled={busy} onClick={loadKnownLinks}>
          내장 수집본에서 상품 찾기
        </button>
      </div>
      {links !== null && (
        <section className="official-product-preview" aria-label="내장 상품 링크 목록">
          <p className="muted">
            2026년 11월 1일에 저장된 카탈로그의 상품 링크 {links.length}개입니다.
            현재 홈페이지 전체 목록이 아닙니다. 선택 후 공식 페이지를 다시 분석하세요.
          </p>
          <Field label="수집본 상품 검색">
            <input value={linkSearch} onChange={(event) => setLinkSearch(event.target.value)}
              placeholder="상품명 또는 상품번호 검색" />
          </Field>
          <p className="muted">검색 결과 {matchingLinks.length}개 / 최대 40개 표시</p>
          <div className="official-link-results">
            {matchingLinks.slice(0, 40).map((link) => (
              <button type="button" key={link.url} disabled={busy}
                onClick={() => { setUrl(link.url); setPreview(undefined); setCategoryId(""); setLinks(null); }}>
                {link.name}
              </button>
            ))}
            {!matchingLinks.length && <p className="muted">검색 결과가 없습니다.</p>}
          </div>
          <button type="button" onClick={() => setLinks(null)}>목록 닫기</button>
        </section>
      )}
      {preview && (
        <div className="official-product-preview">
          <h4>{preview.product.name}</h4>
          <p>상품설명 (매장 참고): {preview.product.subtitle || "별도 설명 없음"}</p>
          <p>등록할 상품명: {preview.product.name}</p>
          <p>상품명 확인 근거: {preview.modelSource === "MODEL_FIELD" ? "공식 모델명" :
            preview.modelSource === "CUSTOM_CODE" ? "홈페이지 모델 표기" :
            preview.modelSource === "TITLE" ? "공식 상품명에서 추출 (확인 권장)" : "미확정"}</p>
          <p>공식 원본 상품명: {preview.product.originalName || "없음"}</p>
          <p>공식 상품 연동: {preview.product.siteId || "미연결"}</p>
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
          {!!preview.optionEvidence?.length && (
            <section className="official-option-evidence" aria-label="원본 선택 옵션 검토">
              <h5>공식 페이지에 표시된 선택 옵션</h5>
              <p className="muted">
                가방이나 바퀴의 포함 여부를 양쪽 모두 명시해야 합니다.
                아래 선택값은 판매 SKU 식별자 또는 확정된 옵션별 가격이 아닙니다.
                직접 확인 전까지 자동 반영하지 않습니다.
              </p>
              {preview.optionEvidence.map((group, index) => (
                <div key={index}>
                  <strong>{group.group} ({group.kind})</strong>
                  {group.values.length ? (
                    <ul>{group.values.map((option, optionIndex) => (
                      <li key={optionIndex}>{option.label || "표시명 확인 필요"}</li>
                    ))}</ul>
                  ) : <p className="warnings">동적으로 입력되는 옵션입니다. 홈페이지에서 직접 확인하세요.</p>}
                </div>
              ))}
            </section>
          )}
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
