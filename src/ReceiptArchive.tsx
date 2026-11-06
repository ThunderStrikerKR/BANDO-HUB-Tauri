import { useState } from "react";
import { Modal } from "./ui";
export function ReceiptArchive() {
  const [rows, setRows] =
      useState<{ id: string; orderId: string; record: Record<string, unknown> }[]>(),
    [query, setQuery] = useState(""),
    [error, setError] = useState("");
  return (
    <section className="card">
      <h2>접수 원문 감사 보관함</h2>
      <p>
        정식 접수된 주문의 최초 원문과 이후 정정 기록을 별도로 보관합니다. 날짜는 카카오톡 전송 시각이
        아닌 반도허브 접수 시각입니다.
      </p>
      <button onClick={() => {
        setError("");
        void window.bando!.receiptArchive().then(setRows).catch((e) => setError(String(e)));
      }}>
        감사 기록 열기
      </button>
      {error && <p className="warnings" role="alert">{error}</p>}
      {rows && (
        <Modal title="접수 원문 감사 보관함" onClose={() => setRows(undefined)}>
          <input
            aria-label="접수 감사 기록 검색"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="원문 / 직원 / 주문 ID 검색"
          />
          {rows
            .filter((r) => JSON.stringify(r).includes(query))
            .map((r) => (
              <details key={r.id}>
                <summary>
                  {r.orderId} / {String(r.record.at ?? "")} / {" "}
                  {String(r.record.actor ?? "직원 미확인")} / {" "}
                  {r.id.startsWith("correction:") ? "정정 요청 기록" : "최초 접수"}
                </summary>
                <pre>{String(r.record.original ?? r.record.after ?? "")}</pre>
                {!!r.record.reason && <p>사유: {String(r.record.reason)}</p>}
              </details>
            ))}
        </Modal>
      )}
    </section>
  );
}
