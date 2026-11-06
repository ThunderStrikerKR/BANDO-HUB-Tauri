import { useEffect, useRef, useState } from "react";
import { confirmAction, promptText } from "./dialogs";
import { clientCandidates, suggestClient, won } from "./domain";
import { colorLabel, productKey, registeredProducts } from "./product-models";
import type { NoticeSink } from "./shared/notices";
import { useAsyncTask } from "./shared/useAsyncTask";
import type { BulkPreview, CatalogReport, Client, State } from "./types";
import { Modal } from "./ui";
export const tierText = {
  wholesale: "도매",
  semi: "반도매",
  retail: "소매",
  special: "특수",
};
export function TierBadge({ client }: { client: Client }) {
  return <span className={"tag tier-" + client.tier}>{tierText[client.tier]}</span>;
}
export function ClientPicker({
  clients,
  selected,
  raw,
  onSelect,
  compact = false,
}: {
  clients: Client[];
  selected?: Client;
  raw: string;
  onSelect: (c: Client) => void;
  compact?: boolean;
}) {
  const [query, setQuery] = useState(""),
    [all, setAll] = useState(false),
    [popup, setPopup] = useState(false),
    [dismissed, setDismissed] = useState("");
  const selectRef = useRef(onSelect);
  selectRef.current = onSelect;
  const results = query ? clientCandidates(query, clients) : [],
    suggested = suggestClient(raw, clients),
    key = suggested
      .map((c) => c.id)
      .sort()
      .join("|");
  useEffect(() => {
    if (selected) {
      setPopup(false);
      return;
    }
    if (!key) {
      setPopup(false);
      setDismissed("");
      return;
    }
    if (query || all) return;
    const timer = setTimeout(() => {
      if (suggested.length === 1) {
        setPopup(false);
        selectRef.current(suggested[0]);
      } else if (key !== dismissed) setPopup(true);
    }, 500);
    return () => clearTimeout(timer);
  }, [raw, key, selected?.id, query, all, dismissed]);
  const choose = (c: Client) => {
    onSelect(c);
    setQuery("");
    setAll(false);
    setPopup(false);
  };
  const row = (c: Client) => (
    <button className="client-result" key={c.id} onClick={() => choose(c)}>
      <span>
        <b>{c.name}</b>
        <small>
          {c.address || "주소 미등록"} / {c.phone || "전화 미등록"}
        </small>
      </span>
      <TierBadge client={c} />
    </button>
  );
  return (
    <div className="client-picker">
      {!compact && (
        <div className="form-row">
          <input
            aria-label="거래처 통합 검색"
            placeholder="거래처명 / 송장 상호 / 주소 / 전화번호 검색"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button onClick={() => setAll(true)}>전체 거래처 목록</button>
        </div>
      )}
      {query && (
        <div className="client-results">
          {results.length ? (
            results.slice(0, 20).map(row)
          ) : (
            <p className="muted">검색 결과가 없습니다.</p>
          )}
        </div>
      )}
      {selected && (
        <div className="selected-client">
          <span>
            <b>{selected.name}</b>
            <small>{selected.address || "거래처 주소 미등록"}</small>
          </span>
          <TierBadge client={selected} />
        </div>
      )}
      {!selected && suggested.length > 1 && !popup && (
        <button className="client-choice-reopen" onClick={() => setPopup(true)}>
          거래처 후보 {suggested.length}곳 선택
        </button>
      )}
      {popup && !selected && suggested.length > 1 && (
        <Modal
          title="거래처 후보 선택"
          onClose={() => {
            setPopup(false);
            setDismissed(key);
          }}
        >
          <p>원문에 일치하는 거래처가 {suggested.length}곳입니다. 적용할 거래처를 선택하세요.</p>
          {suggested.map(row)}
        </Modal>
      )}
      {all && (
        <Modal title="전체 거래처 목록" onClose={() => setAll(false)}>
          <div className="client-chooser-list">{clients.filter((c) => !c.deletedAt).map(row)}</div>
        </Modal>
      )}
    </div>
  );
}
export function BulkTools({
  kind,
  onRefresh,
  onError,
  locked = false,
}: {
  locked?: boolean;
  kind: "prices" | "clients";
  onRefresh: () => Promise<void>;
  onError: NoticeSink;
}) {
  const { busy, run } = useAsyncTask(onError);
  const [preview, setPreview] = useState<BulkPreview | null>(null),
    [ack, setAck] = useState(false);
  return (
    <>
      <div className="actions">
        <button disabled={busy} onClick={() => run(async () => window.bando!.downloadSheet(kind))}>
          현재 목록 .xlsx 다운로드
        </button>
        <button
          disabled={busy || locked}
          onClick={() =>
            run(async () => {
              setPreview(await window.bando!.previewSheet(kind));
              setAck(false);
            })
          }
        >
          .xlsx 업로드 / 미리보기
        </button>
      </div>
      {preview && (
        <Modal title="엑셀 변경 미리보기" onClose={() => setPreview(null)}>
          <h3>변경 미리보기 / {preview.changes.length}건</h3>
          <p className="muted">빈칸은 기존 값을 유지합니다. 승인 시 먼저 DB를 백업합니다.</p>
          {preview.errors.map((e) => (
            <p className="warnings" key={e}>
              {e}
            </p>
          ))}
          <div className="bulk-diff">
            {preview.changes.map((c, i) => (
              <div className="diff-row" key={i}>
                <b>{c.label}</b>
                <p>
                  {c.before} → {c.after}
                </p>
                {c.warning && <p className="warnings">{c.warning}</p>}
              </div>
            ))}
          </div>
          <label className="check">
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> 변경
            내용과 중복 후보 / 공식 소매가 차이 경고를 확인했습니다.
          </label>
          <button
            disabled={busy || locked || !ack || !!preview.errors.length || !preview.changes.length}
            className="primary"
            onClick={() =>
              run(async () => {
                await window.bando!.approveSheet();
                await onRefresh();
                setPreview(null);
                onError("승인한 엑셀 변경을 저장했습니다.", "success");
              })
            }
          >
            백업 후 변경 승인
          </button>
        </Modal>
      )}
    </>
  );
}
export function CatalogPanel({
  state,
  onRefresh,
  onError,
}: {
  state: State;
  onRefresh: () => Promise<void>;
  onError: NoticeSink;
}) {
  const { busy, run } = useAsyncTask(onError);
  const [report, setReport] = useState<CatalogReport>(),
    [show, setShow] = useState(false);
  return (
    <section className="card">
      <div className="section-title">
        <h2>공식 카탈로그 수집 / 변경 검토</h2>
        <button
          disabled={busy}
          onClick={() =>
            run(async () => {
              setReport(await window.bando!.catalogReport());
              setShow(true);
            })
          }
        >
          전체 수집 결과 / 변경 검토
        </button>
      </div>
      <p className="muted">
        검증된 공개 상세페이지 수집본을 검토하고 승인합니다. 도매 / 반도매 / 특수 지정가와 이전 주문
        단가는 유지됩니다.
      </p>
      {show && report && (
        <>
          <div className="catalog-stats">
            <b>카테고리 {report.categories.length}개</b>
            <b>
              독립 모델 {report.products.length}개 / 원본{" "}
              {report.sourceProductCount ?? report.products.length}개
            </b>
            <b>
              등록 가능한 옵션{" "}
              {report.products.flatMap((p) => p.variants).filter((v) => v.retail !== null).length}개
            </b>
            <b>
              가격 확인 필요{" "}
              {report.products.flatMap((p) => p.variants).filter((v) => v.retail === null).length}개
            </b>
          </div>
          <small>{new Date(report.collectedAt).toLocaleString("ko-KR")} 수집본</small>
          <details>
            <summary>카테고리별 페이지 / 상품 수</summary>
            {report.categories.map((c) => (
              <p key={c.id}>
                {c.name} / {c.pages}페이지 / {c.ids.length}개 {c.errors.join(" / ")}
              </p>
            ))}
          </details>
          <div className="bulk-diff">
            <table>
              <thead>
                <tr>
                  <th>상품 / 색상 / 옵션</th>
                  <th>기존 소매가</th>
                  <th>수집 판매가</th>
                  <th>구분</th>
                </tr>
              </thead>
              <tbody>
                {report.products.flatMap((p) =>
                  p.variants.map((v) => {
                    const old = registeredProducts(state.products).find(
                      (x) => productKey(x) === productKey(p),
                    );
                    const ov = old?.variants.find(
                      (x) =>
                        x.siteOptionId === v.siteOptionId &&
                        x.color === v.color &&
                        (x.option ?? "") === (v.option ?? ""),
                    );
                    return (
                      <tr key={v.id}>
                        <td>
                          {p.code}
                          <small>
                            {p.subtitle} / {colorLabel(v.color)}
                          </small>
                        </td>
                        <td>{won(ov?.retail ?? null)}</td>
                        <td>{won(v.retail)}</td>
                        <td>
                          {old ? "기존 상품" : "신규"}
                          <small>{v.retailNote}</small>
                        </td>
                      </tr>
                    );
                  }),
                )}
              </tbody>
            </table>
          </div>
          {report.failures.map((f, i) => (
            <p className="warnings" key={i}>
              {f.productId || f.category}: {f.error}
            </p>
          ))}
          <button
            className="primary"
            disabled={busy}
            onClick={() =>
              run(async () => {
                if (
                  !(await confirmAction(
                    "수집 원본과 변경사항을 확인하셨습니까? 백업 후 승인한 소매가를 등록합니다.",
                  ))
                )
                  return;
                const result = await window.bando!.approveCatalog();
                await onRefresh();
                onError(`공식 상품 반영: 신규 ${result.created} / 갱신 ${result.updated}`);
                setShow(false);
              })
            }
          >
            백업 후 소매가 등록 승인
          </button>
        </>
      )}
    </section>
  );
}
export function BackupPanel({
  onRefresh,
  onError,
}: {
  onRefresh: () => Promise<void>;
  onError: NoticeSink;
}) {
  const [files, setFiles] = useState<string[]>([]);
  return (
    <section className="card settings">
      <h2>데이터 백업 및 복구</h2>
      <div className="actions">
        <button
          onClick={async () => {
            try {
              onError("백업 완료: " + (await window.bando!.backup()), "success");
              setFiles(await window.bando!.backups());
            } catch (e) {
              onError(String(e), "error");
            }
          }}
        >
          지금 백업
        </button>
        <button
          onClick={async () => {
            try {
              setFiles(await window.bando!.backups());
            } catch (e) {
              onError(String(e), "error");
            }
          }}
        >
          백업 목록
        </button>
      </div>
      {files.map((f) => (
        <div className="history" key={f}>
          <span>{f.split(/[\\/]/).pop()}</span>
          <button
            onClick={async () => {
              if (
                !(await confirmAction("현재 데이터를 먼저 백업한 뒤 선택한 시점으로 복구할까요?"))
              )
                return;
              try {
                await window.bando!.restore(f);
                await onRefresh();
                onError(
                  "백업을 복구했습니다. 기존 편집 화면 대신 주문 내역을 다시 열어 주세요.",
                  "success",
                );
              } catch (e) {
                onError(String(e), "error");
              }
            }}
          >
            이 백업으로 복구
          </button>
        </div>
      ))}
    </section>
  );
}
export function CategoriesPanel({
  state,
  onSave,
  onError,
}: {
  state: State;
  onSave: (s: State) => Promise<void>;
  onError: NoticeSink;
}) {
  const [name, setName] = useState(""),
    [parent, setParent] = useState("");
  const cats = state.categories ?? [];
  return (
    <section className="card">
      <h2>카테고리 / 하위 분류 관리</h2>
      <div className="form-row category-tools">
        <input
          aria-label="새 카테고리명"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="카테고리명"
        />
        <select
          aria-label="상위 카테고리"
          value={parent}
          onChange={(e) => setParent(e.target.value)}
        >
          <option value="">최상위 분류</option>
          {cats
            .filter((c) => !c.parentId)
            .map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
        </select>
        <button
          onClick={async () => {
            if (!name.trim()) return;
            if (
              !/[가-힣]/.test(name) ||
              name.trim() === "미분류" ||
              (!parent && name.trim() === "악세사리")
            ) {
              onError(
                "한글 분류명을 사용하세요. 미분류는 검토 상태이며, 스탠드 악세사리는 별도 대분류를 사용합니다.",
              );
              return;
            }
            if (cats.some((c) => c.name === name.trim() && c.parentId === (parent || null))) {
              onError("같은 분류가 있습니다.");
              return;
            }
            try {
              await onSave({
                ...state,
                categories: [
                  ...cats,
                  {
                    id: crypto.randomUUID(),
                    name: name.trim(),
                    parentId: parent || null,
                  },
                ],
              });
              setName("");
            } catch (e) {
              onError(String(e), "error");
            }
          }}
        >
          분류 추가
        </button>
      </div>
      <details>
        <summary>등록된 분류 {cats.length}개 / 이름 수정</summary>
        {cats.map((c) => (
          <div className="form-row category-row" key={c.id}>
            <span>
              {c.parentId ? "↳ " : ""}
              {c.name}
            </span>
            <button
              onClick={async () => {
                const value = await promptText("새 분류명", c.name);
                if (!value?.trim()) return;
                try {
                  await onSave({
                    ...state,
                    categories: cats.map((x) => (x.id === c.id ? { ...x, name: value.trim() } : x)),
                    products: state.products.map((p) =>
                      p.categories?.includes(c.id)
                        ? {
                            ...p,
                            category: p.category.replace(c.name, value.trim()),
                          }
                        : p,
                    ),
                  });
                } catch (e) {
                  onError(String(e), "error");
                }
              }}
            >
              이름 수정
            </button>
          </div>
        ))}
      </details>
    </section>
  );
}
