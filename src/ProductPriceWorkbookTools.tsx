import { useRef, useState } from "react";
import { exportPriceWorkbook, previewPriceWorkbook } from "./product-price-xlsx";
import { useAsyncTask } from "./shared/useAsyncTask";
import type { NoticeSink } from "./shared/notices";
import type { BulkPreview, State } from "./types";
import { Modal } from "./ui";

export function ProductPriceWorkbookTools({ state, onSave, onRefresh, onNotice, locked }:{
  state: State;
  onSave: (state: State) => Promise<void>;
  onRefresh: () => Promise<void>;
  onNotice: NoticeSink;
  locked: boolean;
}) {
  const { busy, run } = useAsyncTask(onNotice);
  const input = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<BulkPreview>();
  const [sourceRevision, setSourceRevision] = useState<number>();
  const [ack, setAck] = useState(false);
  const download = () => void run(async () => {
    const bytes = await exportPriceWorkbook(state);
    if (!window.bando?.saveProductWorkbook) throw Error("가격표 저장 기능이 준비되지 않았습니다.");
    const path = await window.bando.saveProductWorkbook(bytes);
    if (path) onNotice("상품 가격표를 저장했습니다: " + path, "success");
  });
  const select = (file?: File) => {
    if (!file) return;
    void run(async () => {
      setPreview(undefined);
      setAck(false);
      const result = await previewPriceWorkbook(state, file);
      setPreview(result);
      setSourceRevision(state.revision);
    });
  };
  const approve = () => void run(async () => {
    if (!preview?.products || preview.errors.length || !preview.changes.length || !ack) return;
    if (state.revision !== sourceRevision) throw Error("검증 후 상품 데이터가 변경되었습니다. 가격표를 다시 업로드해 주세요.");
    await window.bando!.backup();
    await onSave({ ...state, products: preview.products });
    await onRefresh();
    setPreview(undefined);
    setAck(false);
    onNotice(`상품 가격 ${preview.changes.length}건을 저장했습니다. 기존 데이터는 백업했습니다.`, "success");
  });
  return <>
    <div className="actions">
      <button type="button" disabled={busy} onClick={download}>현재 가격표 .xlsx 다운로드</button>
      <button type="button" disabled={busy || locked} onClick={() => input.current?.click()}>.xlsx 업로드 / 검증</button>
      <input ref={input} type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden
        onChange={(event) => { select(event.currentTarget.files?.[0]); event.currentTarget.value = ""; }}/>
    </div>
    {preview && <Modal title="가격표 변경 미리보기" busy={busy} onClose={() => setPreview(undefined)}>
      <div className="product-price-xlsx-preview">
        <h3>변경 {preview.changes.length}건 / 검증 오류 {preview.errors.length}건</h3>
        <p className="muted">빈칸은 원래 가격을 유지합니다. 승인 시 상품 데이터 백업 후 변경합니다.</p>
        {preview.errors.length > 0 && <div className="product-price-xlsx-errors">{preview.errors.map((e, i) => <p key={i}>{e}</p>)}</div>}
        <div className="product-price-xlsx-changes">{preview.changes.map((change, i) => <div key={i} className="diff-row">
          <b>{change.label}</b><p>{change.before} → {change.after}</p>
          {change.warning && <p className="warnings">{change.warning}</p>}
        </div>)}</div>
        <label className="check"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)}/>
          검증한 가격 변경과 공식 소매가 차이를 확인했습니다.
        </label>
        <div className="row-end"><button type="button" onClick={() => setPreview(undefined)}>취소</button>
          <button type="button" className="primary" disabled={busy || locked || !ack || !!preview.errors.length || !preview.changes.length} onClick={approve}>백업 후 변경 승인</button>
        </div>
      </div>
    </Modal>}
  </>;
}
