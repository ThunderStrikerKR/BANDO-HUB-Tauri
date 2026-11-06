import { useState } from "react";
import { confirmAction } from "./dialogs";
import {
  applyProductNameCleanup, previewProductNameCleanup,
  type ProductNameCleanupPreview,
} from "./product-name-cleanup";
import type { NoticeSink } from "./shared/notices";
import { useAsyncTask } from "./shared/useAsyncTask";
import type { State } from "./types";
import { Modal } from "./ui";

export function ProductNameCleanupPanel({
  onSave, onRefresh, onNotice,
}: {
  onSave: (state: State) => Promise<void>;
  onRefresh: () => Promise<void>;
  onNotice: NoticeSink;
}) {
  const { busy, run } = useAsyncTask(onNotice);
  const [preview, setPreview] = useState<ProductNameCleanupPreview>();
  const [accepted, setAccepted] = useState(false);
  const [filter, setFilter] = useState<"ALL" | "READY" | "HOLD">("ALL");
  const ready = preview?.rows.filter((r) => r.status === "READY") ?? [];
  const held = preview?.rows.filter((r) => r.status === "HOLD") ?? [];
  const start = () => void run(async () => {
    const current = await window.bando!.load();
    setPreview(previewProductNameCleanup(current));
    setAccepted(false);
  });
  const approve = () => void run(async () => {
    if (!preview || !accepted || ready.length === 0) return;
    if (!(await confirmAction(
      "확인된 " + ready.length + "개 상품의 이름과 설명만 정리할까요? 상품 ID, 옵션 및 가격은 그대로 유지하며 저장 전에 백업합니다."
    ))) return;
    const latest = await window.bando!.load();
    const { next, changed } = applyProductNameCleanup(latest, preview);
    await window.bando!.backup();
    await onSave(next);
    await onRefresh();
    setPreview(undefined);
    setAccepted(false);
    onNotice(changed + "개 상품명을 정리했습니다. 모델명이 불명확한 상품은 그대로 두었습니다.", "success");
  });
  return (
    <>
      <button type="button" disabled={busy} onClick={start}>상품명 정리</button>
      {preview && (
        <Modal title="상품명 및 상품설명 정리" busy={busy}
          onClose={() => { if (!busy) { setPreview(undefined); setAccepted(false); } }}>
          <p className="muted">
            반도스탠드 상품명 앞의 반복된 브랜드명과 용도 설명을 분리합니다.
            공식 원본 상품명은 별도로 유지하며 상품 ID, 가격, 옵션, 카테고리는 변경하지 않습니다.
          </p>
          <p>자동 정리 가능 {ready.length}건 / 수동 확인 필요 {held.length}건</p>
          <div className="actions">
            <button type="button" className={filter === "ALL" ? "primary" : ""}
              onClick={() => setFilter("ALL")}>전체</button>
            <button type="button" className={filter === "READY" ? "primary" : ""}
              onClick={() => setFilter("READY")}>정리 가능</button>
            <button type="button" className={filter === "HOLD" ? "primary" : ""}
              onClick={() => setFilter("HOLD")}>확인 필요</button>
          </div>
          <div className="bulk-diff" style={{ maxHeight: 380, overflowY: "auto" }}>
            <table>
              <thead><tr><th>기존 상품명</th><th>정리 후 상품명</th><th>정리 후 상품설명</th><th>판정</th></tr></thead>
              <tbody>
                {preview.rows.filter((row) => filter === "ALL" || row.status === filter)
                  .map((row) => (
                    <tr key={row.productId}>
                      <td>{row.oldName}</td>
                      <td>{row.newName}</td>
                      <td>{row.newDescription || "설명 없음"}</td>
                      <td>{row.status === "READY" ? "변경 가능" : "수동 확인"}<small>{row.reason}</small></td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
          <p className="muted">확인 필요 상품은 일괄 변경에서 제외됩니다. 상품 상세관리에서 직접 정리할 수 있습니다.</p>
          <label className="check">
            <input type="checkbox" checked={accepted} onChange={(event) => setAccepted(event.target.checked)}/>
            변경 전후를 확인했고, 정리 가능한 상품명과 상품설명만 수정하는 데 동의합니다.
          </label>
          <div className="row-end">
            <button type="button" disabled={busy} onClick={() => setPreview(undefined)}>취소</button>
            <button type="button" className="primary" disabled={busy || !accepted || ready.length === 0}
              onClick={approve}>백업 후 {ready.length}개 상품명 정리</button>
          </div>
        </Modal>
      )}
    </>
  );
}
