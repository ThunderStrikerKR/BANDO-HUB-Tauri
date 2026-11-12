import { useMemo, useState } from "react";
import { requestEditorLeave, requestPageLeave, usePageLeaveGuard } from "./shared/page-leave";
import { categoryPath, categoryProducts, changeCategory, deleteCategory, descendants } from "./category-tree";
import { CATALOG_ROOTS, catalogFromCategory, isCatalogRoot, withCatalogRoots } from "./category-roots";
import { Modal } from "./ui";
import { ManagementSearch } from "./ui/ManagementSearch";
import type { Category, State } from "./types";
import type { NoticeSink } from "./shared/notices";

export function CategoryManager({
  state,
  onSave,
  onNotice,
  query = "",
  onQueryChange,
}: {
  state: State;
  onSave: (s: State) => Promise<void>;
  onNotice: NoticeSink;
  query?: string;
  onQueryChange: (query: string) => void;
}) {
  const cats = useMemo(() => withCatalogRoots(state.categories), [state.categories]);
  const [selected, setSelected] = useState<string>(CATALOG_ROOTS[0].id);
  const [expanded, setExpanded] = useState<string[]>(CATALOG_ROOTS.map((root) => root.id));
  const [name, setName] = useState("");
  const [editorOpen, setEditorOpen] = useState(false);
  const [transferConfirmed, setTransferConfirmed] = useState(false);
  const [operation, setOperation] = useState<"add" | "move" | "delete" | null>(null);
  const [newName, setNewName] = useState("");
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const current = cats.find((c) => c.id === selected);
  const categoryCounts = useMemo(() => new Map(cats.map((c) => [c.id, categoryProducts({ ...state, categories: cats }, c.id).length])), [cats, state.products]);
  const categoryCount = (id: string) => categoryCounts.get(id) ?? 0;
  const children = (id: string) => cats.filter((c) => c.parentId === id);
  const directCount = (id: string) =>
    state.products.filter(
      (p) => !p.deletedAt && !p.supersededBy && p.categories?.includes(id),
    ).length;
  const parentName = (id: string) =>
    categoryPath(cats, id)
      .map((c) => c.name)
      .join(" / ");
  const legacy = cats.filter((c) => c.parentId === null && !isCatalogRoot(c.id));
  const q = query.trim().toLocaleLowerCase();
  const matches = (c: Category) =>
    parentName(c.id).toLocaleLowerCase().includes(q) ||
    [...descendants(cats, c.id)].some((id) =>
      cats.find((item) => item.id === id)?.name.toLocaleLowerCase().includes(q),
    );
  const select = (c: Category) => {
    setSelected(c.id);
    setName(c.name);
  };
  const save = async (next: State, success: string): Promise<boolean> => {
    setBusy(true);
    try {
      await onSave(next);
      onNotice(success, "success");
      setOperation(null);
      return true;
    } catch (error) {
      onNotice(String(error), "error");
      return false;
    } finally {
      setBusy(false);
    }
  };
  const renameDirty = !!current && editorOpen && !isCatalogRoot(current.id) &&
    name.trim() !== current.name.trim();
  const operationDirty = !!current && (
    (operation === "add" && !!newName.trim()) ||
    (operation === "move" && !!target && target !== (current.parentId ?? CATALOG_ROOTS[0].id))
  );
  const hasUnsaved = renameDirty || operationDirty;
  const saveChanges = async (): Promise<boolean> => {
    if (!current || !hasUnsaved) return true;
    const base = { ...state, categories: withCatalogRoots(state.categories) };
    try {
      if (operation === "add") {
        if (!newName.trim() || (directCount(current.id) > 0 && !transferConfirmed)) {
          onNotice("분류 이름과 상품 이전 확인을 완료해 주세요.", "error");
          return false;
        }
        return save(changeCategory(base, crypto.randomUUID(), newName, current.id,
          transferConfirmed && children(current.id).length === 0), "하위 분류를 추가했습니다.");
      }
      if (operation === "move") {
        const destinationCatalog = catalogFromCategory(base.categories, target);
        const linked = categoryProducts(state, current.id);
        if (destinationCatalog && linked.some((p) =>
          p.catalog && p.catalog !== "DEMO" && p.catalog !== destinationCatalog))
          throw Error("분류 소속이 다른 상품이 있습니다. 상품 연결을 먼저 확인하세요.");
        return save(changeCategory(base, current.id, current.name, target), "분류 위치를 변경했습니다.");
      }
      if (renameDirty)
        return save(changeCategory(base, current.id, name.trim(), current.parentId), "분류 이름을 변경했습니다.");
      return true;
    } catch (error) {
      onNotice(String(error), "error");
      return false;
    }
  };
  const discard = () => {
    setOperation(null);setEditorOpen(false);setName(current?.name ?? "");
    setNewName("");setTransferConfirmed(false);setTarget("");
  };
  usePageLeaveGuard({
    label: "카테고리",
    hasChanges: () => hasUnsaved,
    busy: () => busy,
    save: saveChanges,
    discard,
  });
  const closeEditor = async () => {
    if (renameDirty) {
      const leave = await requestEditorLeave({
        label: "카테고리 이름",
        hasChanges: () => renameDirty,
        save: async () => current ? save(
          changeCategory({ ...state, categories: withCatalogRoots(state.categories) },
            current.id, name.trim(), current.parentId),
          "분류 이름을 변경했습니다.") : true,
        discard: () => setName(current?.name ?? ""),
      }, (message) => onNotice(message, "error"));
      if (!leave.proceed) return;
    }
    setEditorOpen(false);
  };
  const closeOperation = async () => {
    if (operationDirty) {
      const leave = await requestEditorLeave({
        label: "카테고리 작업",
        hasChanges: () => operationDirty,
        save: saveChanges,
        discard: () => { setNewName(""); setTarget(""); setTransferConfirmed(false); },
      }, (message) => onNotice(message, "error"));
      if (!leave.proceed) return;
    }
    setOperation(null);
  };
  const begin = (kind: "add" | "move" | "delete") => {
    if (!current || (kind !== "add" && isCatalogRoot(current.id))) return;
    if (kind === "delete" && (directCount(current.id) > 0 || children(current.id).length > 0)) {
      onNotice("연결 상품이나 하위 분류가 있는 경우 먼저 소속을 정리하세요.", "error");
      return;
    }
    setNewName("");
    setTransferConfirmed(false);
    setTarget(current.parentId ?? CATALOG_ROOTS[0].id);
    setOperation(kind);
  };
  const renderNode = (c: Category, depth: number): React.ReactNode => {
    if (q && !matches(c)) return null;
    const branches = children(c.id);
    const open = expanded.includes(c.id) || !!q;
    return (
      <div key={c.id} role="treeitem" aria-expanded={branches.length ? open : undefined}>
        <button
          type="button"
          className={"catalog-map-row" + (selected === c.id ? " selected" : "") + (isCatalogRoot(c.id) ? " root" : "")}
          style={{ paddingLeft: 17 + depth * 24 }}
          aria-label={`${c.name}, 하위 포함 상품 ${categoryCount(c.id)}개`}
          onClick={() => {
            select(c);
            if (branches.length && !q) {
              setExpanded((old) => old.includes(c.id) ? old.filter((id) => id !== c.id) : [...old, c.id]);
            }
          }}
        >
          <span className="catalog-map-indicator" aria-hidden="true">{branches.length ? (open ? "⌄" : "›") : ""}</span>
          <span className="catalog-map-name">{c.name}</span>
          {branches.length > 0 && <span className="catalog-map-branches">하위 {branches.length}</span>}
          <span className="catalog-tree-count" title="하위 분류 포함 상품 수">{categoryCount(c.id)}</span>
        </button>
        {open && branches.length > 0 && <div role="group">{branches.map((child) => renderNode(child, depth + 1))}</div>}
      </div>
    );
  };
  const validTargets = current
    ? cats.filter(
        (c) =>
          c.active !== false &&
          c.id !== current.id &&
          !descendants(cats, current.id).has(c.id) &&
          !categoryPath(cats, c.id).some((a) => a.active === false),
      )
    : [];
  return (
    <section className="catalog-admin-workspace" aria-label="카테고리 관리">
      <section className="catalog-tree-panel" aria-label="카테고리 맵">
        <header className="catalog-panel-header">
          <div className="catalog-panel-titleline">
            <div>
              <h2>카테고리 맵</h2>
              <p className="muted">분류 행을 클릭하면 하위 구성이 접히거나 펼쳐집니다.</p>
            </div>
            <div className="catalog-map-actions">
              <button type="button" onClick={() => { setExpanded([]); }} disabled={busy}>전체 접기</button>
              <button type="button" onClick={() => setExpanded(cats.map((c) => c.id))} disabled={busy}>전체 펼치기</button>
              <button type="button" onClick={() => { if (current) { setName(current.name); setEditorOpen(true); } }} disabled={!current || busy}>선택 분류 편집</button>
              <button className="primary" onClick={() => begin("add")} disabled={!current || busy}>+ 하위 분류 추가</button>
            </div>
          </div>
          <div className="management-search-toolbar">
            <ManagementSearch label="상품 검색" placeholder="카테고리 이름 또는 전체 경로 검색"
              value={query} onChange={onQueryChange}/>
          </div>
          {current && <p className="catalog-map-selection">선택: {parentName(current.id)}</p>}
        </header>
        <div className="catalog-tree-scroll" role="tree" aria-label="카테고리 트리">
          {CATALOG_ROOTS.map((root) => cats.find((c) => c.id === root.id))
            .filter((c): c is Category => !!c)
            .map((c) => renderNode(c, 0))}
          {!!legacy.length && (
            <div className="catalog-legacy-review">
              <strong>상위 분류 소속 확인 ({legacy.length})</strong>
              <p>기존 분류의 소속은 자동으로 변경하지 않습니다. 선택 후 위치를 지정하세요.</p>
              {legacy.filter((c) => !q || matches(c)).map((c) => renderNode(c, 0))}
            </div>
          )}
        </div>
      </section>
      {editorOpen && <div className="catalog-map-editor-layer" role="presentation" onMouseDown={(event) => {
        if (event.target === event.currentTarget) void closeEditor();
      }}>
      <section className="catalog-detail-panel">
        {current ? (
          <>
            <header className="catalog-detail-heading">
              <div><h2>{current.name}</h2><p>{parentName(current.id)}</p></div>
              <button type="button" aria-label="편집 창 닫기" onClick={() => void closeEditor()}>닫기 ×</button>
            </header>
            <div className="catalog-detail-scroll">
              <div className="catalog-stats">
                <div><small>직접 연결 상품</small><strong>{directCount(current.id)}</strong></div>
                <div><small>하위 포함 상품</small><strong>{categoryCount(current.id)}</strong></div>
                <div><small>직속 하위 분류</small><strong>{children(current.id).length}</strong></div>
              </div>
              <label className="catalog-field">
                분류 이름
                <input
                  value={isCatalogRoot(current.id) ? current.name : name}
                  disabled={isCatalogRoot(current.id) || busy}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
              <div className="catalog-field">
                <span>상위 카테고리</span>
                <div className="catalog-location">
                  <span>{current.parentId ? parentName(current.parentId) : isCatalogRoot(current.id) ? "최상위" : "소속 확인 필요"}</span>
                  <button
                    onClick={() => begin("move")}
                    disabled={isCatalogRoot(current.id) || busy}
                  >
                    위치 변경
                  </button>
                </div>
              </div>
              {!isCatalogRoot(current.id) && !current.parentId && (
                <p className="catalog-explanation">
                  현재 최상위로 남아 있는 기존 분류입니다. 반도스탠드 또는 반도몰에 직접 소속을 지정하면 기존 분류 ID와 상품 연결은 유지됩니다.
                </p>
              )}
            </div>
            <footer className="catalog-detail-footer">
              <button
                className="danger"
                disabled={isCatalogRoot(current.id) || !!children(current.id).length || !!directCount(current.id) || busy}
                onClick={() => begin("delete")}
              >
                분류 삭제
              </button>
              <button
                className="primary"
                disabled={isCatalogRoot(current.id) || !name.trim() || name.trim() === current.name || busy}
                onClick={() =>
                  void save(
                    changeCategory(
                      { ...state, categories: withCatalogRoots(state.categories) },
                      current.id,
                      name.trim(),
                      current.parentId,
                    ),
                    "분류 이름을 변경했습니다.",
                  )
                }
              >
                변경사항 저장
              </button>
            </footer>
          </>
        ) : <p className="muted">수정할 카테고리를 선택하세요.</p>}
      </section>
      </div>}
      {operation && current && (
        <Modal
          className="category-operation-dialog"
          title={operation === "add" ? "하위 카테고리 추가" : operation === "move" ? "상위 카테고리 변경" : "분류 삭제 확인"}
          onClose={() => void closeOperation()}
          busy={busy}
        >
          <div className="category-operation-body">
            {operation === "add" ? (
              <>
                <p>생성 위치: {parentName(current.id)}</p>
                <label className="catalog-field">새 분류 이름
                  <input autoFocus value={newName} onChange={(event) => setNewName(event.target.value)} />
                </label>
                {directCount(current.id) > 0 && <label className="catalog-add-transfer">
                  <input type="checkbox" checked={transferConfirmed} onChange={(event) => setTransferConfirmed(event.target.checked)} />
                  <span>{children(current.id).length === 0
                    ? `직접 연결된 상품 ${directCount(current.id)}개를 새 하위 분류로 이전하는 데 동의합니다.`
                    : `기존 직접 연결 상품 ${directCount(current.id)}개는 현재 분류에 남습니다. 하위 분류 추가를 확인했습니다.`}</span>
                </label>}
              </>
            ) : operation === "move" ? (
              <>
                <p>분류 ID와 기존 상품 연결은 유지하고 상위 분류만 변경합니다.</p>
                <label className="catalog-field">이동할 상위 분류
                  <select value={target} onChange={(event) => setTarget(event.target.value)}>
                    {validTargets.map((c) => (
                      <option key={c.id} value={c.id}>{parentName(c.id)}</option>
                    ))}
                  </select>
                </label>
              </>
            ) : <p>{current.name} 분류를 삭제할까요? 상품과 하위 분류가 없어야 삭제할 수 있습니다.</p>}
            <div className="catalog-operation-actions">
              <button onClick={() => void closeOperation()}>취소</button>
              <button
                className={operation === "delete" ? "danger" : "primary"}
                disabled={busy || (operation === "add" && (!newName.trim() || (directCount(current.id) > 0 && !transferConfirmed))) || (operation === "move" && !target)}
                onClick={() => {
                  const base = { ...state, categories: withCatalogRoots(state.categories) };
                  if (operation === "add") {
                    try {
                      void save(changeCategory(base, crypto.randomUUID(), newName, current.id, transferConfirmed && children(current.id).length === 0), "하위 분류를 추가했습니다.");
                    } catch (error) { onNotice(String(error), "error"); }
                  } else if (operation === "move") {
                    try {
                      const destinationCatalog = catalogFromCategory(base.categories, target);
                      const linked = categoryProducts(state, current.id);
                      if (
                        destinationCatalog &&
                        linked.some((p) => p.catalog && p.catalog !== "DEMO" && p.catalog !== destinationCatalog)
                      ) throw Error("이 분류에는 이동할 최상위 구분과 다른 상품이 연결되어 있습니다. 상품 소속을 먼저 확인하세요.");
                      void save(changeCategory(base, current.id, current.name, target), "분류 위치를 변경했습니다.");
                    } catch (error) { onNotice(String(error), "error"); }
                  } else {
                    void (async () => {
                      await save(deleteCategory(base, current.id), "빈 분류를 삭제했습니다.");
                      setSelected(current.parentId ?? CATALOG_ROOTS[0].id);
                      setEditorOpen(false);
                    })();
                  }
                }}
              >
                {operation === "add" ? "분류 생성" : operation === "move" ? "위치 변경" : "분류 삭제"}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </section>
  );
}
