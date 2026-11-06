import { useState } from "react";
import { Modal } from "./ui";

type AuditRow = {
  id: string;
  orderId: string;
  record: Record<string, unknown>;
};
const text = (value: unknown) => (typeof value === "string" ? value : "");
const isCorrection = (id: string) =>
  id.startsWith("correction:") || id.startsWith("legacy-correction:");

export function ReceiptArchive() {
  const [rows, setRows] = useState<AuditRow[]>();
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const filtered = (rows ?? []).filter((row) =>
    JSON.stringify(row).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  );
  const open = async () => {
    if (loading) return;
    setLoading(true);
    setError("");
    try {
      setRows(await window.bando!.receiptArchive());
    } catch (cause) {
      setError(String(cause));
    } finally {
      setLoading(false);
    }
  };
  return (
    <section className="card">
      <h2>접수 원문 감사 보관함</h2>
      <p>
        주문 확인 완료 시 최초 원문을 보존하고, 이후 작업용 원문 정정을 따로 기록합니다.
        확정 전 분석 초안은 감사 기록에 포함하지 않습니다.
      </p>
      <button type="button" disabled={loading} onClick={() => void open()}>
        {loading ? "기록 조회 중…" : "감사 기록 열기"}
      </button>
      {error && <p className="warnings" role="alert">{error}</p>}
      {rows && (
        <Modal title="접수 원문 감사 보관함" onClose={() => setRows(undefined)}>
          <input
            aria-label="접수 감사 기록 검색"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="원문 / 담당자 / 주문 ID 검색"
          />
          <p>{filtered.length}건 조회</p>
          <div style={{ maxHeight: "60vh", overflowY: "auto" }}>
            {filtered.map((row) => (
              <details key={row.id}>
                <summary>
                  {row.orderId} / {text(row.record.at)} /{" "}
                  {text(row.record.actor) || "담당자 미확인"} /{" "}
                  {isCorrection(row.id) ? "원문 정정" : "최초 접수"}
                  {row.record.verified === false ? " (과거 자료 / 독립 감사 미확인)" : ""}
                </summary>
                {isCorrection(row.id) ? (
                  <>
                    <p>정정 전 작업용 원문</p>
                    <pre>{text(row.record.before)}</pre>
                    <p>정정 후 작업용 원문</p>
                    <pre>{text(row.record.after)}</pre>
                    <p>정정 사유: {text(row.record.reason) || "과거 기록 / 사유 미확인"}</p>
                  </>
                ) : (
                  <>
                    <p>최초 접수 원문</p>
                    <pre>{text(row.record.original)}</pre>
                  </>
                )}
              </details>
            ))}
            {filtered.length === 0 && <p>조회 조건에 맞는 감사 기록이 없습니다.</p>}
          </div>
        </Modal>
      )}
    </section>
  );
}
