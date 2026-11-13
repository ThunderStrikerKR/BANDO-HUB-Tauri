import { useRef, useState } from "react";
import { confirmAction } from "./dialogs";
import { businessCoreCall } from "./tauri-bridge";
import {
  exportRegistrationTemplate,
  previewRegistrationWorkbook,
  type RegistrationWorkbookPreview,
} from "./product-registration-xlsx";
import type { NoticeSink } from "./shared/notices";
import { useAsyncTask } from "./shared/useAsyncTask";
import type { State } from "./types";
import { Modal } from "./ui";

export function RegistrationManager({
  state, onSave, onNotice,
}: {
  state: State;
  onSave: (value: State) => Promise<void>;
  onRefresh: () => Promise<void>;
  onNotice: NoticeSink;
}) {
  const { busy, run } = useAsyncTask(onNotice);
  const fileInput = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<RegistrationWorkbookPreview>();
  const [approved, setApproved] = useState(false);
  const lastBatch = state.registrationBatches?.at(-1);
  const [source, setSource] = useState("");
  const close = () => { if (!busy) { setOpen(false); setPreview(undefined); setApproved(false); } };
  const download = (bytes: number[]) =>
    window.bando!.saveRegistrationWorkbook!("양식", bytes);
  const createTemplate = () => void run(async () => {
    const path = await download(await exportRegistrationTemplate(state));
    if (path) onNotice("상품 등록 양식을 저장했습니다: " + path, "success");
  });
  const chooseFile = (file?: File) => {
    if (!file) return;
    void run(async () => {
      setPreview(undefined);
      setApproved(false);
      const current = await window.bando!.load();
      setPreview(await previewRegistrationWorkbook(current, file));
      setSource(file.name);
    });
  };
  const commit = () => void run(async () => {
    if (!preview || !approved) return;
    const count = preview.rows.filter((row) => row.status === "READY").length;
    if (!count) return;
    if (!(await confirmAction(
      "검증한 신규 상품 " + count +
      "개를 등록할까요? 먼저 DB를 백업하고 기존 상품과 가격은 유지합니다."
    ))) return;
    const current = await window.bando!.load();
    const result = await businessCoreCall<{ next: State; created: number; skipped: number }>(
      "catalog_clients", "prepare_registration_commit", {
        state: current, preview, actor: current.settings.operatorName ?? "관리자",
        now: new Date().toISOString(), batchId: crypto.randomUUID(),
      },
    );
    // Abort the registration if a consistent SQLite backup cannot be created.
    await window.bando!.backup();
    // Existing revision-checked application save performs SQLite validation atomically.
    await onSave(result.next);
    // The common save already applied the committed SQLite snapshot.
    setPreview(undefined);
    setApproved(false);
    onNotice("신규 상품 " + result.created + "개 등록, 미등록 " + result.skipped + "행. 기존 가격은 유지했습니다.", "success");
  });
  return <>
    <button type="button" onClick={() => setOpen(true)}>엑셀 대량 등록</button>
    {open && <Modal busy={busy} title="상품 엑셀 대량 등록" onClose={close}>
      <p>판매 구성 하나당 한 행을 입력합니다. 기존 상품과 가격은 자동 변경하지 않습니다.</p>
      <div className="actions">
        <button type="button" disabled={busy} onClick={createTemplate}>등록 양식 다운로드</button>
        <button type="button" disabled={busy} onClick={() => fileInput.current?.click()}>파일 업로드 / 검증</button>
        <input ref={fileInput} hidden type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          onChange={(event) => {
            chooseFile(event.currentTarget.files?.[0]);
            event.currentTarget.value = "";
          }}/>
      </div>
      {lastBatch && (
        <details className="registration-result-history">
          <summary>
            최근 등록 결과 / 성공 {lastBatch.createdIds.length}개 /
            중복 {lastBatch.rows.filter((r) => r.status === "DUPLICATE").length}개 /
            오류 {lastBatch.rows.filter((r) => r.status === "ERROR").length}개 /
            보류 {lastBatch.rows.filter((r) => r.status === "HOLD").length}개
          </summary>
          <p className="muted">{lastBatch.at} / 작업자 {lastBatch.actor}</p>
          <div className="registration-preview">
            <table>
              <thead><tr><th>행</th><th>상품</th><th>결과</th><th>사유 / 중복 상품</th></tr></thead>
              <tbody>
                {lastBatch.rows.map((row) => (
                  <tr key={row.row}>
                    <td>{row.row}</td>
                    <td>{row.values["최종 등록명"] || "상품명 없음"}</td>
                    <td>{{ READY:"등록 완료", ERROR:"오류", DUPLICATE:"중복", HOLD:"보류" }[row.status]}</td>
                    <td>{row.errors.join(" / ") || row.duplicateIds.join(", ") || "정상"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
      {preview && <>
        <p><strong>{source}</strong> / 등록 가능 {preview.rows.filter((r) => r.status === "READY").length}행
          / 오류 {preview.rows.filter((r) => r.status === "ERROR").length}행
          / 중복 {preview.rows.filter((r) => r.status === "DUPLICATE").length}행
          / 보류 {preview.rows.filter((r) => r.status === "HOLD").length}행
        </p>
        <div className="registration-preview">
          <table>
            <thead><tr><th>행</th><th>상품</th><th>판정</th><th>검증 결과</th></tr></thead>
            <tbody>{preview.rows.map((row) => <tr key={row.row}>
              <td>{row.row}</td><td>{row.values["최종 등록명"] || "상품명 없음"}</td>
              <td>{{ READY:"등록 가능", ERROR:"오류", DUPLICATE:"중복", HOLD:"보류" }[row.status]}</td>
              <td>{row.errors.join(" / ") || row.duplicateIds.join(", ") || "정상"}</td>
            </tr>)}</tbody>
          </table>
        </div>
        <label className="check">
          <input type="checkbox" checked={approved} onChange={(e) => setApproved(e.target.checked)}/>
          등록 가능한 행만 추가하고 오류, 중복, 보류 행은 등록하지 않는 데 동의합니다.
        </label>
        <div className="row-end">
          <button type="button" disabled={busy} onClick={() => setPreview(undefined)}>취소</button>
          <button type="button" className="primary" disabled={busy || !approved ||
            !preview.rows.some((row) => row.status === "READY")} onClick={commit}>
            검증한 신규 상품 등록
          </button>
        </div>
      </>}
    </Modal>}
  </>;
}
