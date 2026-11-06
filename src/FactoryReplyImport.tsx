import { useRef, useState } from "react";
import { confirmAction } from "./dialogs";
import {
  applyFactoryReplyPreview, parseFactoryReplyWorkbook,
  type FactoryReplyPreview,
} from "./factory-reply-workbook";
import type { NoticeSink } from "./shared/notices";
import { useAsyncTask } from "./shared/useAsyncTask";
import type { State } from "./types";
import { Modal } from "./ui";

export function FactoryReplyImport({
  onSave, onRefresh, onNotice,
}: {
  onSave: (state: State) => Promise<void>;
  onRefresh: () => Promise<void>;
  onNotice: NoticeSink;
}) {
  const { busy, run } = useAsyncTask(onNotice);
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File>();
  const [review, setReview] = useState<FactoryReplyPreview>();
  const [accepted, setAccepted] = useState(false);
  const choose = (selected?: File) => {
    if (!selected) return;
    void run(async () => {
      setReview(undefined);
      setFile(undefined);
      setAccepted(false);
      const current = await window.bando!.load();
      const result = await parseFactoryReplyWorkbook(current, selected);
      setReview(result);
      setFile(selected);
    });
  };
  const commit = () => void run(async () => {
    if (!file || !review || !accepted) return;
    if (!(await confirmAction(
      "공장 회신 " + review.rows.length + "행을 등록할까요? 자동 일치 " +
      review.applied + "건만 운송장 및 실제 운임을 반영하고, 검토 필요 " +
      review.held + "건은 원래 값을 유지합니다."
    ))) return;
    const latest = await window.bando!.load();
    const { next, applied, held } = applyFactoryReplyPreview(latest, review);
    const api = window.bando!;
    if (!api.archiveFactoryReply) throw Error("공장 회신 원본 보관 기능이 이식되지 않았습니다.");
    await api.backup();
    // Rust compares the SHA-256 digest against the reviewed file ID.
    const archivedPath = await api.archiveFactoryReply(
      review.reply.id, Array.from(new Uint8Array(await file.arrayBuffer())),
    );
    const saved = next.factoryReplies?.find((r) => r.id === review.reply.id);
    if (!saved) throw Error("회신 이력 저장 대상이 없습니다.");
    saved.archivedPath = archivedPath;
    try {
      await onSave(next);
    } catch (error) {
      throw Error("회신 원본 파일은 보관됐으나 DB 반영에 실패했습니다. 재확인 후 다시 업로드하세요: " + String(error));
    }
    await onRefresh();
    setReview(undefined);
    setFile(undefined);
    setAccepted(false);
    onNotice("공장 회신 등록 완료. 자동 반영 " + applied + "건, 직원 확인 필요 " + held + "건입니다.", "success");
  });
  return (
    <section className="card factory-reply-import">
      <div className="section-title">
        <h2>공장 운송장 및 운임 회신</h2>
        <button type="button" disabled={busy} onClick={() => input.current?.click()}>
          공장 회신 Excel 업로드
        </button>
      </div>
      <p className="muted">
        로젠 회신 Excel의 Q열 운송장번호와 G열 실제 택배운임을 읽습니다.
        수하인 이름, 주소, 연락처가 공장 발송 건과 일치할 때만 자동 연결합니다.
        불일치와 충돌은 직원 확인 대상으로 보존합니다.
      </p>
      <input hidden ref={input} type="file"
        accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        onChange={(event) => {
          choose(event.currentTarget.files?.[0]);
          event.currentTarget.value = "";
        }}/>
      {review && (
        <Modal title="공장 회신 Excel 변경 검토" busy={busy}
          onClose={() => { if (!busy) { setReview(undefined); setFile(undefined); setAccepted(false); } }}>
          <p><strong>{review.reply.filename}</strong></p>
          <div className="catalog-stats">
            <b>회신 {review.rows.length}건</b>
            <b>자동 연결 {review.applied}건</b>
            <b>직원 확인 {review.held}건</b>
          </div>
          <div className="bulk-diff factory-reply-review">
            <table>
              <thead>
                <tr><th>Excel 행</th><th>수하인</th><th>운송장번호</th><th>실제 운임</th><th>결과</th></tr>
              </thead>
              <tbody>{review.rows.map((row) => (
                <tr key={row.row}>
                  <td>{row.row}</td>
                  <td>{row.name}</td>
                  <td>{row.tracking || "미입력"}</td>
                  <td>{row.actual === null ? "미확인" : row.actual.toLocaleString("ko-KR") + "원"}</td>
                  <td>{row.applied ? "자동 연결 가능" : row.issue || "직원 확인 필요"}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
          <p className="muted">원본 Excel은 앱 데이터 폴더에 보관합니다. 등록 후 충돌 건은 회신 이력에서 개별 검토할 수 있습니다.</p>
          <label className="check">
            <input type="checkbox" checked={accepted} onChange={(event) => setAccepted(event.target.checked)}/>
            변경될 운송장과 실제 운임을 확인했습니다. 보류 행은 변경하지 않습니다.
          </label>
          <div className="row-end">
            <button type="button" disabled={busy} onClick={() => { setReview(undefined); setFile(undefined); }}>취소</button>
            <button type="button" className="primary" disabled={busy || !accepted} onClick={commit}>
              DB 백업 후 회신 {review.rows.length}건 등록
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
