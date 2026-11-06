import { useEffect, useMemo, useState } from "react";
import {
  assignFamilyProduct,
  combineFamilies,
  familySummaries,
  renameFamily,
  setFamilyRepresentative,
} from "./model-family-editor";
import { registeredProducts } from "./product-models";
import { modelGroup, validateModelSettings } from "./model-families";
import type { Product, State } from "./types";

export function RepresentativeManager({
  state,
  onRefresh,
  query = "",
}: {
  state: State;
  onRefresh: () => Promise<void>;
  query?: string;
}) {
  const [draft, setDraft] = useState<State>(() => structuredClone(state));
  const [baseline, setBaseline] = useState<State>(() => structuredClone(state));
  const [selected, setSelected] = useState("");
  const [code, setCode] = useState("");
  const [productQuery, setProductQuery] = useState("");
  const [action, setAction] = useState<"merge" | "move" | "add" | null>(null);
  const [movingId, setMovingId] = useState("");
  const [destination, setDestination] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const groups = useMemo(() => familySummaries(draft), [draft]);
  const activeId = groups.some((g) => g.id === selected) ? selected : (groups[0]?.id ?? "");
  const active = groups.find((g) => g.id === activeId);
  const unsaved = JSON.stringify(draft.settings.modelFamilies ?? {}) !== JSON.stringify(baseline.settings.modelFamilies ?? {}) ||
    JSON.stringify(draft.settings.modelRepresentatives ?? {}) !== JSON.stringify(baseline.settings.modelRepresentatives ?? {});
  // Refresh untouched drafts when orders or products change elsewhere. Keep unsaved edits
  // intact; the server checks their original per-key values at save time.
  useEffect(() => {
    if (!unsaved) {
      setDraft(structuredClone(state));
      setBaseline(structuredClone(state));
    }
    // Only an incoming state change should reset a clean draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);
  const shownCode = code === "" ? active?.code || "" : code;
  const selectFamily = (id: string) => {
    setSelected(id);
    setCode("");
    setProductQuery("");
    setMessage("");
  };
  const update = (edit: (s: State) => State) => {
    try {
      setDraft(edit(draft));
      setMessage("");
    } catch (error) {
      setMessage(String(error));
    }
  };
  const commit = async () => {
    if (busy || !unsaved) return;
    setBusy(true);
    setMessage("");
    try {
      if (!window.bando?.patchSettings) throw Error("모델군 개별 저장 기능을 사용할 수 없습니다.");
      const fields = ["modelFamilies", "modelRepresentatives"] as const;
      const changes: Record<string, unknown> = {};
      const expected: Record<string, unknown> = {};
      for (const field of fields) {
        if (JSON.stringify(draft.settings[field] ?? {}) === JSON.stringify(baseline.settings[field] ?? {})) continue;
        changes[field] = draft.settings[field] ?? null;
        expected[field] = baseline.settings[field] ?? null;
      }
      if (!Object.keys(changes).length) return;
      const latest = await window.bando.load();
      const candidate = structuredClone(latest);
      if (Object.hasOwn(changes, "modelFamilies")) candidate.settings.modelFamilies = structuredClone(draft.settings.modelFamilies);
      if (Object.hasOwn(changes, "modelRepresentatives")) candidate.settings.modelRepresentatives = structuredClone(draft.settings.modelRepresentatives);
      validateModelSettings(candidate, latest);
      await window.bando.backup();
      const updated = await window.bando.patchSettings(changes, expected);
      setDraft(structuredClone(updated));
      setBaseline(structuredClone(updated));
      await onRefresh();
      setMessage("모델군 설정을 저장했습니다. 주문과 상품 데이터는 유지했습니다.");
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  };
  const search = query.toLocaleLowerCase().trim();
  const filtered = groups.filter(
    (g) =>
      !search ||
      g.code.toLocaleLowerCase().includes(search) ||
      g.members.some((p) => `${p.name} ${p.subtitle || ""}`.toLocaleLowerCase().includes(search)),
  );
  const catalog = registeredProducts(draft.products).filter(
    (p) =>
      productQuery.trim() &&
      `${p.name} ${p.subtitle || ""} ${p.code}`
        .toLocaleLowerCase()
        .includes(productQuery.trim().toLocaleLowerCase()) &&
      !active?.members.some((member) => member.id === p.id),
  );
  const chooseDestination = (mode: "move" | "merge" | "add", productId = "") => {
    const choices = groups.filter((g) => g.id !== (mode === "add" ? modelGroup(draft, draft.products.find((p) => p.id === productId)!).id : activeId));
    if (!choices.length) {
      setMessage("이동할 다른 모델군이 없습니다.");
      return;
    }
    setAction(mode);
    setMovingId(productId);
    setDestination(mode === "add" ? activeId : choices[0].id);
  };
  const applyAction = () => {
    if (!action || !active) return;
    try {
      const next = action === "merge"
        ? combineFamilies(draft, activeId, destination)
        : assignFamilyProduct(draft, movingId, action === "add" ? activeId : destination);
      setDraft(next);
      if (action === "merge") setSelected(destination);
      setMessage("");
      setAction(null);
    } catch (error) {
      setMessage(String(error));
    }
  };
  const details = (p: Product) => [p.name, p.subtitle].filter(Boolean).join(" / ");
  return (
    <section className="family-admin-workspace" aria-label="모델군 관리">
      <aside className="family-list-panel">
        <header className="family-list-heading">
          <h2>모델군 목록</h2>
          <p>기본 모델 코드에 따라 묶인 상품을 확인하고 잘못된 소속을 수정합니다.</p>
        </header>
        <div className="family-list-scroll">
          {filtered.map((g) => (
            <button
              key={g.id}
              type="button"
              className={"family-list-row" + (g.id === activeId ? " selected" : "")}
              onClick={() => selectFamily(g.id)}
            >
              <span>
                <strong>{g.code}</strong>
                <small>
                  {g.representative
                    ? `대표 상품: ${details(g.representative)}`
                    : "대표 상품 미지정"}
                </small>
              </span>
              <span className="family-member-count">{g.members.length}개 상품</span>
            </button>
          ))}
          {!filtered.length && <p className="muted">일치하는 모델군이 없습니다.</p>}
        </div>
      </aside>
      <div className="family-editor-panel">
        {active ? (
          <>
            <header className="family-editor-heading">
              <h2>{active.code}</h2>
              <button disabled={busy || groups.length < 2} onClick={() => chooseDestination("merge")}>다른 모델군과 합치기</button>
            </header>
            <div className="family-editor-scroll">
              <div className="family-field">
                <label htmlFor="family-code-input">기본 모델 코드</label>
                <div className="family-code-edit">
                  <input
                    id="family-code-input"
                    value={shownCode}
                    onChange={(event) => setCode(event.target.value)}
                  />
                  <button
                    disabled={!code.trim() || code.trim() === active.code || busy}
                    onClick={() => {
                      try {
                        setDraft(renameFamily(draft, activeId, code));
                        setCode("");
                        setMessage("");
                      } catch (error) { setMessage(String(error)); }
                    }}
                  >
                    코드 변경
                  </button>
                </div>
              </div>
              <div className="family-members-section">
                <div className="family-section-heading"><h3>소속 상품</h3><span>{active.members.length}개 상품</span></div>
                <div className="family-member-table">
                  {active.members.map((p) => (
                    <div className="family-member" key={p.id}>
                      <div className="family-member-name" title={details(p)}>
                        <strong>{p.name}</strong>
                        <span>{p.subtitle}</span>
                      </div>
                      <label className="family-representative-choice" title={p.variants.length !== 1 ? "여러 옵션이 있는 상품은 먼저 SKU를 분리하세요." : undefined}>
                        <input
                          type="radio"
                          name="family-representative-choice"
                          disabled={busy || p.variants.length !== 1}
                          checked={active.representative?.id === p.id}
                          onChange={() => update((s) => setFamilyRepresentative(s, activeId, p.id))}
                        />
                        대표
                      </label>
                      <button disabled={busy} onClick={() => chooseDestination("move", p.id)}>이동</button>
                    </div>
                  ))}
                  {!active.members.length && <p className="muted">소속 상품이 없습니다.</p>}
                </div>
                <p className="family-help">대표 상품은 같은 모델군의 상품 중에서 선택합니다. 옵션이 여러 개인 기존 상품은 SKU 정리가 필요합니다.</p>
                {draft.settings.modelRepresentatives?.[activeId] && (
                  <button
                    disabled={busy}
                    onClick={() => update((s) => setFamilyRepresentative(s, activeId, null))}
                  >
                    대표 지정 해제
                  </button>
                )}
              </div>
              <div className="family-members-section">
                <div className="family-section-heading"><h3>상품 검색 및 추가</h3></div>
                <input
                  aria-label="전체 등록 상품 검색"
                  placeholder="전체 등록 상품에서 상품명 또는 모델 코드 검색"
                  value={productQuery}
                  onChange={(event) => setProductQuery(event.target.value)}
                />
                <div className="family-search-results">
                  {catalog.slice(0, 30).map((p) => (
                    <div className="family-member" key={p.id}>
                      <div className="family-member-name">
                        <strong>{p.name}</strong><span>{p.subtitle}</span>
                        <small>현재 소속: {modelGroup(draft, p).code}</small>
                      </div>
                      <button disabled={busy} onClick={() => chooseDestination("add", p.id)}>이동</button>
                    </div>
                  ))}
                  {productQuery.trim() && !catalog.length && <p className="muted">검색 결과가 없습니다.</p>}
                </div>
              </div>
            </div>
            <footer className="family-editor-footer">
              <span className={message.startsWith("Error") ? "form-error" : "muted"} role="status">
                {message || (unsaved ? "저장하지 않은 변경사항 있음" : "변경사항 없음")}
              </span>
              <div className="family-footer-actions">
                <button disabled={!unsaved || busy} onClick={() => {setDraft(structuredClone(state));setBaseline(structuredClone(state));setCode("");setMessage("");}}>변경 취소</button>
                <button className="primary" disabled={!unsaved || busy} onClick={() => void commit()}>
                  {busy ? "저장 중" : "변경사항 저장"}
                </button>
              </div>
            </footer>
          </>
        ) : <p className="muted">등록된 모델군이 없습니다.</p>}
      </div>
      {action && active && (
        <div className="family-confirm-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setAction(null);
        }}>
          <div className="family-confirm-dialog" role="dialog" aria-modal="true" aria-label="모델군 변경">
            <header><h3>{action === "merge" ? "모델군 합치기" : "상품 소속 변경"}</h3></header>
            <p>
              {action === "merge"
                ? `${active.code} 모델군의 상품을 다른 모델군에 합칩니다. 기존 상품 및 주문 ID는 유지합니다.`
                : "상품 소속을 변경합니다. 다른 모델군에 중복 등록되지 않도록 저장합니다."}
            </p>
            {action !== "add" && (
              <label className="family-field">대상 모델군
                <select value={destination} onChange={(event) => setDestination(event.target.value)}>
                  {groups.filter((g) => g.id !== activeId).map((g) => <option key={g.id} value={g.id}>{g.code}</option>)}
                </select>
              </label>
            )}
            {action === "add" && <p>대상 모델군: {active.code}</p>}
            <footer>
              <button onClick={() => setAction(null)}>취소</button>
              <button className="primary" onClick={applyAction} disabled={busy}>확인</button>
            </footer>
          </div>
        </div>
      )}
    </section>
  );
}
