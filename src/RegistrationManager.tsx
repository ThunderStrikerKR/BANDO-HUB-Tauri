import { useState } from "react";
import type { RegistrationRow } from "./product-registry";
import type { NoticeSink } from "./shared/notices";
import { useAsyncTask } from "./shared/useAsyncTask";
import { Modal } from "./ui";
export function RegistrationManager({
  onRefresh,
  onNotice,
}: {
  onRefresh: () => Promise<void>;
  onNotice: NoticeSink;
}) {
  const { busy, run } = useAsyncTask(onNotice);
  const [open, setOpen] = useState(false),
    [preview, setPreview] = useState<{
      fingerprint: string;
      rows: RegistrationRow[];
    }>(),
    [approved, setApproved] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>엑셀 대량 등록</button>
      {open && (
        <Modal busy={busy} title="상품 엑셀 대량 등록" onClose={() => setOpen(false)}>
          <p>실제 판매 구성 하나를 한 행으로 작성하세요. 기존 상품과 가격은 덮어쓰지 않습니다.</p>
          <div className="actions">
            <button
              disabled={busy}
              onClick={() => void run(() => window.bando!.registrationTemplate())}
            >
              등록 양식 다운로드
            </button>
            <button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  setPreview((await window.bando!.registrationPreview()) ?? undefined);
                  setApproved(false);
                })
              }
            >
              파일 업로드 / 검증
            </button>
            <button
              disabled={busy}
              onClick={() => void run(() => window.bando!.registrationResults())}
            >
              등록 결과 다운로드
            </button>
          </div>
          {preview && (
            <>
              <p>
                등록 가능 {preview.rows.filter((r) => r.status === "READY").length} / 오류{" "}
                {preview.rows.filter((r) => r.status === "ERROR").length} / 중복 후보{" "}
                {preview.rows.filter((r) => r.status === "DUPLICATE").length} / 보류{" "}
                {preview.rows.filter((r) => r.status === "HOLD").length}
              </p>
              <div className="registration-preview">
                <table>
                  <thead>
                    <tr>
                      <th>행</th>
                      <th>상품</th>
                      <th>판정</th>
                      <th>사유 / 연결 후보</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.rows.map((r) => (
                      <tr key={r.row}>
                        <td>{r.row}</td>
                        <td>{r.values["최종 등록명"] || "상품명 없음"}</td>
                        <td>
                          {
                            {
                              READY: "등록 가능",
                              ERROR: "오류",
                              DUPLICATE: "중복 후보",
                              HOLD: "보류",
                            }[r.status]
                          }
                        </td>
                        <td>
                          {r.errors.join(" / ") || r.duplicateIds.join(", ") || r.values["비고"]}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <label className="check">
                <input
                  type="checkbox"
                  checked={approved}
                  onChange={(e) => setApproved(e.target.checked)}
                />{" "}
                등록 가능한 행과 명시한 기존 상품 연결을 확인했습니다. 오류 / 보류 행은 등록하지
                않습니다.
              </label>
              <button
                className="primary"
                disabled={
                  busy ||
                  !approved ||
                  !preview.rows.some(
                    (r) =>
                      r.status === "READY" ||
                      (r.status === "DUPLICATE" && r.values["기존 상품 연결 ID"]),
                  )
                }
                onClick={() =>
                  void run(async () => {
                    const result = await window.bando!.registrationCommit(preview.fingerprint);
                    await onRefresh();
                    setPreview(undefined);
                    onNotice(
                      `상품 ${result.created}개 등록 / 신규 생성 제외 ${result.skipped}행`,
                      "success",
                    );
                  })
                }
              >
                확인한 데이터 등록
              </button>
            </>
          )}
        </Modal>
      )}
    </>
  );
}
