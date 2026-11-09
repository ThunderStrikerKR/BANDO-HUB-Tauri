import { useRef, useState } from "react";
import { confirmAction } from "./dialogs";
import {
  applyClientWorkbook, exportClientWorkbook, previewClientWorkbook,
  type ClientWorkbookPreview,
} from "./client-workbook";
import type { NoticeSink } from "./shared/notices";
import { useAsyncTask } from "./shared/useAsyncTask";
import type { State } from "./types";
import { Modal } from "./ui";
import { HelpTooltip } from "./ui/HelpTooltip";

export function ClientWorkbookTools({
  onSave, onRefresh, onNotice,
}: {
  onSave: (value: State) => Promise<void>;
  onRefresh: () => Promise<void>;
  onNotice: NoticeSink;
}) {
  const { busy, run } = useAsyncTask(onNotice);
  const input = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<ClientWorkbookPreview>();
  const [fileName, setFileName] = useState("");
  const [accepted, setAccepted] = useState(false);
  const tally = {
    created: preview?.rows.filter((r) => r.status === "ADD").length ?? 0,
    updated: preview?.rows.filter((r) => r.status === "UPDATE").length ?? 0,
    unchanged: preview?.rows.filter((r) => r.status === "UNCHANGED").length ?? 0,
    held: preview?.rows.filter((r) => r.status === "HOLD").length ?? 0,
    error: preview?.rows.filter((r) => r.status === "ERROR").length ?? 0,
  };
  const download = () => void run(async () => {
    if (!window.bando?.saveClientWorkbook) throw Error("거래처 Excel 저장 기능을 지원하지 않습니다.");
    const current = await window.bando.load();
    const bytes = await exportClientWorkbook(current);
    const filename = await window.bando.saveClientWorkbook(bytes);
    if (filename) onNotice("현재 거래처 전체 목록을 저장했습니다: " + filename, "success");
  });
  const select = (file?: File) => {
    if (!file) return;
    void run(async () => {
      setPreview(undefined);
      setAccepted(false);
      const current = await window.bando!.load();
      const result = await previewClientWorkbook(current, file);
      setPreview(result);
      setFileName(file.name);
    });
  };
  const approve = () => void run(async () => {
    if (!preview || !accepted || tally.held || tally.error ||
      (!tally.created && !tally.updated)) return;
    if (!(await confirmAction(
      "거래처 신규 " + tally.created + "건과 수정 " + tally.updated +
      "건을 저장할까요? 기존 거래처, 주문과 특수 단가는 보존합니다."
    ))) return;
    const current = await window.bando!.load();
    const { next, created, updated } = applyClientWorkbook(current, preview);
    await window.bando!.backup();
    await onSave(next);
    await onRefresh();
    setPreview(undefined);
    setAccepted(false);
    onNotice("거래처 신규 " + created + "건, 수정 " + updated + "건 저장했습니다. 기존 주문과 특수 단가는 유지했습니다.", "success");
  });
  return (
    <div className="client-workbook-tools">
      <div className="actions">
        <button type="button" disabled={busy} onClick={download}>현재 거래처 전체 Excel 다운로드</button>
        <button type="button" disabled={busy} onClick={() => input.current?.click()}>
          Excel 업로드 / 전체 변경 검토
        </button>
        <HelpTooltip title="거래처 Excel 관리" purpose="거래처 목록을 Excel 파일로 보관하거나 여러 거래처를 한 번에 등록하고 수정할 수 있습니다." when="거래처 정보를 대량으로 관리할 때 사용합니다." steps={["현재 거래처 전체 Excel 다운로드를 눌러 기존 목록을 내려받습니다.", "Excel에서 거래처를 추가하거나 수정한 뒤 저장합니다.", "Excel 업로드 / 전체 변경 검토를 눌러 파일을 선택합니다.", "변경 내용을 확인하고 오류가 없을 때 승인합니다."]} result="신규 거래처는 등록되고 기존 거래처는 번호를 유지한 채 수정됩니다." caution="파일에서 누락한 기존 거래처는 삭제되지 않습니다. 중복이나 오류가 있으면 변경을 반영하지 않습니다." />
        <input ref={input} hidden type="file"
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          onChange={(event) => {
            select(event.currentTarget.files?.[0]);
            event.currentTarget.value = "";
          }}/>
      </div>

      {preview && (
        <Modal title="거래처 Excel 전체 변경 검토" busy={busy}
          onClose={() => { if (!busy) { setPreview(undefined); setAccepted(false); } }}>
          <p><strong>{fileName}</strong></p>
          <div className="catalog-stats">
            <b>신규 {tally.created}건</b>
            <b>수정 {tally.updated}건</b>
            <b>변경 없음 {tally.unchanged}건</b>
            <b>중복 의심 {tally.held}건</b>
            <b>오류 {tally.error}건</b>
          </div>
          {preview.missing > 0 && (
            <p className="warnings">
              현재 DB에만 있는 거래처 {preview.missing}건은 Excel에 없습니다.
              누락된 거래처는 삭제하거나 거래중지하지 않고 그대로 유지합니다.
            </p>
          )}
          <div className="bulk-diff client-workbook-preview">
            <table>
              <thead><tr><th>Excel 행</th><th>거래처</th><th>판정</th><th>수정 내용 / 검증 결과</th></tr></thead>
              <tbody>{preview.rows.slice(0, 500).map((row) => (
                <tr key={row.row}>
                  <td>{row.row}</td>
                  <td>{row.name}</td>
                  <td>{{ ADD: "신규", UPDATE: "수정", UNCHANGED: "변경 없음",
                    HOLD: "중복 의심", ERROR: "오류" }[row.status]}</td>
                  <td>{row.errors.join(" / ") || row.changes.join(" / ") || "변경 없음"}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
          {preview.rows.length > 500 && (
            <p className="muted">
              검토 표에는 첫 500행만 표시합니다. 저장 전 중복/오류 검사는 모든 행에 적용됩니다.
            </p>
          )}
          <label className="check">
            <input type="checkbox" checked={accepted}
              onChange={(event) => setAccepted(event.target.checked)}/>
            변경사항을 확인했습니다. 누락된 거래처는 보존하며, 신규 및 수정 행만 백업 후 반영합니다.
          </label>
          <div className="row-end">
            <button type="button" disabled={busy} onClick={() => setPreview(undefined)}>취소</button>
            <button type="button" className="primary"
              disabled={busy || !accepted || !!tally.error || !!tally.held ||
                (!tally.created && !tally.updated)}
              onClick={approve}>백업 후 신규 {tally.created}건 / 수정 {tally.updated}건 반영</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
