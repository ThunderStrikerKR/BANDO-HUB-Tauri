import { useMemo, useState } from "react";
import { confirmAction } from "./dialogs";
import { applySkuSplit, previewSkuSplit, skuSplitCandidates } from "./sku-split";
import type { SkuSplitPreview } from "./sku-split";
import type { NoticeSink } from "./shared/notices";
import { useAsyncTask } from "./shared/useAsyncTask";
import type { State } from "./types";

export function SkuSplitPanel({
  state, onSave, onRefresh, onNotice,
}: {
  state: State;
  onSave: (state: State) => Promise<void>;
  onRefresh: () => Promise<void>;
  onNotice: NoticeSink;
}) {
  const { busy, run } = useAsyncTask(onNotice);
  const [query, setQuery] = useState("");
  const [preview, setPreview] = useState<SkuSplitPreview>();
  const candidates = useMemo(() => skuSplitCandidates(state), [state.products]);
  const results = candidates.filter((p) =>
    (p.name + " " + p.code + " " + (p.subtitle ?? "")).toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase())).slice(0, 80);
  const source = candidates.find((p) => p.id === preview?.sourceId);
  const review = (id: string) => void run(async () => {
    setPreview(previewSkuSplit(state, id));
  });
  const approve = () => void run(async () => {
    if (!preview || preview.blockers.length) return;
    if (!(await confirmAction(
      "선택한 원본 상품의 옵션을 별도 SKU로 분리할까요? 원본과 확정 주문은 보존하고 저장 전 DB를 백업합니다."
    ))) return;
    const latest = await window.bando!.load();
    const { next, created } = applySkuSplit(latest, preview);
    await window.bando!.backup();
    await onSave(next);
    await onRefresh();
    setPreview(undefined);
    onNotice(created + "개 SKU로 분리했습니다. 기존 옵션 ID와 가격은 유지했습니다.", "success");
  });
  return (
    <section className="card">
      <div className="section-title">
        <h3>복합 옵션 상품 SKU 분리</h3>
        <small>분리 대상 {candidates.length}개 / 자동 일괄 변경 없음</small>
      </div>
      <p className="muted">
        홈페이지에 없는 자체 상품에도 사용할 수 있습니다. 원본 상품과 확정된 주문은 보존합니다.
        분리할 상품을 선택한 뒤 주문, 별칭, 연결 정보의 영향을 확인하세요.
      </p>
      <input aria-label="복합 옵션 상품 검색" placeholder="모델코드 또는 상품명 검색"
        value={query} onChange={(event) => setQuery(event.target.value)}/>
      <div className="sku-split-list">
        {results.map((product) => (
          <div className="sku-split-list-row" key={product.id}>
            <span>{product.name} <small>옵션 {product.variants.length}개</small></span>
            <button type="button" disabled={busy} onClick={() => review(product.id)}>분리 검토</button>
          </div>
        ))}
        {!results.length && <p className="muted">분리 대상이 없습니다.</p>}
      </div>
      {preview && source && (
        <div className="sku-split-preview">
          <h4>{source.name} / SKU 분리 검토</h4>
          <p>
            분리할 옵션 {preview.rows.length}개 / 진행 주문 {preview.affectedOrders}건 /
            확정 주문 유지 {preview.historicalOrders}건 / 별칭 {preview.affectedAliases}개 /
            사이트 연결 {preview.affectedLinks}개
          </p>
          <div className="bulk-diff">
            <table>
              <thead><tr><th>옵션 ID</th><th>색상 및 옵션</th><th>도매가</th><th>반도매가</th><th>소매가</th></tr></thead>
              <tbody>{preview.rows.map((row) => (
                <tr key={row.variantId}>
                  <td>{row.variantId}</td>
                  <td>{row.color} / {row.option || "옵션 없음"}</td>
                  <td>{row.wholesale?.toLocaleString("ko-KR") ?? "미등록"}</td>
                  <td>{row.semi?.toLocaleString("ko-KR") ?? "미등록"}</td>
                  <td>{row.retail?.toLocaleString("ko-KR") ?? "미등록"}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
          {preview.blockers.map((message, i) => <p key={i} className="warnings">{message}</p>)}
          {!preview.blockers.length && <p className="muted">옵션 연결 검증을 통과했습니다. 승인 시 원본은 보관되며 별도 SKU가 생성됩니다.</p>}
          <div className="actions">
            <button type="button" disabled={busy} onClick={() => setPreview(undefined)}>검토 닫기</button>
            <button type="button" className="primary" disabled={busy || preview.blockers.length > 0}
              onClick={approve}>백업 후 선택한 상품 분리</button>
          </div>
        </div>
      )}
    </section>
  );
}
