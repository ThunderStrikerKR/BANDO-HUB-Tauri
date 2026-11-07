import { useRef, useState } from "react";
import { confirmAction } from "./dialogs";
import {
  applyProductSyncWorkbook,
  exportProductSyncWorkbook,
  previewProductSyncWorkbook,
  type ProductSyncPreview,
} from "./product-sync-workbook";
import type { NoticeSink } from "./shared/notices";
import { useAsyncTask } from "./shared/useAsyncTask";
import type { State } from "./types";
import { Modal } from "./ui";

export function ProductSyncWorkbookTools({
  onSave, onRefresh, onNotice,
}: {
  onSave: (state: State) => Promise<void>;
  onRefresh: () => Promise<void>;
  onNotice: NoticeSink;
}) {
  const { busy, run } = useAsyncTask(onNotice);
  const filePicker = useRef<HTMLInputElement>(null);
  const [review, setReview] = useState<ProductSyncPreview>();
  const [filename, setFilename] = useState("");
  const [approved, setApproved] = useState(false);
  const [filter, setFilter] = useState<"ALL" | "UPDATE" | "ADD" | "ERROR">("ALL");
  const counts = { add: 0, update: 0, unchanged: 0, hold: 0, error: 0 };
  for (const row of review?.rows ?? []) {
    if (row.status === "ADD") counts.add++;
    if (row.status === "UPDATE") counts.update++;
    if (row.status === "UNCHANGED") counts.unchanged++;
    if (row.status === "HOLD") counts.hold++;
    if (row.status === "ERROR") counts.error++;
  }
  const download = () => void run(async () => {
    if (!window.bando?.saveProductSyncWorkbook) throw Error("상품 전체 Excel 저장 기능이 준비되지 않았습니다.");
    const state = await window.bando.load();
    const bytes = await exportProductSyncWorkbook(state);
    const destination = await window.bando.saveProductSyncWorkbook(bytes);
    if (destination) onNotice("독립 상품 및 가격 전체 목록을 저장했습니다: " + destination, "success");
  });
  const choose = (file?: File) => {
    if (!file) return;
    void run(async () => {
      setApproved(false);
      setReview(undefined);
      const state = await window.bando!.load();
      const result = await previewProductSyncWorkbook(state, file);
      setReview(result);
      setFilename(file.name);
      setFilter("ALL");
    });
  };
  const commit = () => void run(async () => {
    if (!review || !approved || counts.error || counts.hold || (!counts.add && !counts.update)) return;
    if (!(await confirmAction(
      "상품 정보 수정 " + review.updatedProducts + "개, 신규 상품 " + review.createdProducts +
      "개, 옵션 신규 " + review.createdOptions + "개, 수정 " + review.updatedOptions +
      "개를 반영할까요? Excel에서 누락된 항목은 유지합니다."
    ))) return;
    const state = await window.bando!.load();
    const result = applyProductSyncWorkbook(state, review);
    await window.bando!.backup();
    await onSave(result.next);
    await onRefresh();
    onNotice("상품 Excel 변경사항을 저장했습니다. 기존 데이터는 백업했습니다.", "success");
    setReview(undefined);
    setApproved(false);
  });
  return (
    <>
      <div className="actions">
        <button type="button" disabled={busy} onClick={download}>현재 상품 전체 Excel 다운로드</button>
        <button type="button" disabled={busy} onClick={() => filePicker.current?.click()}>
          Excel 업로드 / 전체 변경 검토
        </button>
        <input hidden ref={filePicker} type="file"
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          onChange={(event) => {
            choose(event.currentTarget.files?.[0]);
            event.currentTarget.value = "";
          }}/>
      </div>
      {review && (
        <Modal title="상품 전체 Excel 변경 검토" busy={busy}
          onClose={() => { if (!busy) { setReview(undefined); setApproved(false); } }}>
          <p><strong>{filename}</strong></p>
          <div className="catalog-stats">
            <b>신규 {counts.add}건</b>
            <b>수정 {counts.update}건</b>
            <b>변경 없음 {counts.unchanged}건</b>
            <b>보류 {counts.hold}건</b>
            <b>오류 {counts.error}건</b>
          </div>
          {(review.missingProducts > 0 || review.missingOptions > 0) && (
            <p className="warnings">
              Excel에서 누락된 기존 상품 {review.missingProducts}개와 옵션 {review.missingOptions}개는
              삭제하거나 판매중지하지 않고 그대로 유지합니다.
            </p>
          )}
          <div className="actions">
            {(["ALL", "ADD", "UPDATE", "ERROR"] as const).map((value) => (
              <button key={value} type="button" className={filter === value ? "primary" : ""}
                disabled={busy} onClick={() => setFilter(value)}>
                {{ ALL: "전체", ADD: "신규", UPDATE: "수정", ERROR: "오류" }[value]}
              </button>
            ))}
          </div>
          <div className="bulk-diff product-full-workbook-review">
            <table>
              <thead><tr><th>시트</th><th>행</th><th>상품 또는 옵션</th><th>판정</th><th>변경 및 사유</th></tr></thead>
              <tbody>{review.rows.filter((r) => filter === "ALL" ||
                (filter === "ERROR" ? r.status === "HOLD" || r.status === "ERROR" : r.status === filter))
                .slice(0, 500).map((row, i) => (
                  <tr key={row.sheet + ":" + row.row + ":" + i}>
                    <td>{row.sheet}</td>
                    <td>{row.row}</td>
                    <td>{row.name}</td>
                    <td>{{ ADD: "신규", UPDATE: "수정", UNCHANGED: "변경 없음",
                      HOLD: "보류", ERROR: "오류" }[row.status]}</td>
                    <td>{row.errors.join(" / ") || row.changes.join(" / ") || "변경 없음"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {review.rows.length > 500 && <p className="muted">표에는 최대 500행을 표시하며 모든 행을 검증합니다.</p>}
          <p className="muted">
            홈페이지 등록 여부와 관계없이 신규 등록 및 수정할 수 있습니다.
            상품 ID, 옵션 ID, 기존 주문, 이미지와 홈페이지 연결 정보는 보호됩니다.
          </p>
          <label className="check">
            <input type="checkbox" checked={approved}
              onChange={(event) => setApproved(event.target.checked)}/>
            Excel 변경사항과 오류를 확인했고, 누락 행은 보존한 채 변경사항만 반영하는 데 동의합니다.
          </label>
          <div className="row-end">
            <button type="button" disabled={busy} onClick={() => setReview(undefined)}>취소</button>
            <button type="button" className="primary"
              disabled={busy || !approved || counts.error > 0 || counts.hold > 0 ||
                (!counts.add && !counts.update)}
              onClick={commit}>백업 후 상품 변경사항 반영</button>
          </div>
        </Modal>
      )}
    </>
  );
}
