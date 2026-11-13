import { useState } from "react";
import { confirmDiscardDraft } from "./shared/editor-flow";
import type { Order, State } from "./types";
import { correctWorkingRaw } from "./working-raw";
import { Modal, Field } from "./ui";
export function WorkingRawDialog({
  state,
  order,
  onClose,
  onApply,
}: {
  state: State;
  order: Order;
  onClose: () => void;
  onApply: (state: State) => Promise<void>;
}) {
  const [text, setText] = useState(order.analysisRaw ?? order.raw),
    [reason, setReason] = useState(""),
    [preview, setPreview] = useState<State>(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const changed = text !== (order.analysisRaw ?? order.raw) || !!reason.trim();
  const closeDraft = () => void confirmDiscardDraft("원문 정정", changed, onClose, busy);
  const updated = preview?.orders.find((o) => o.id === order.id);
  return (
    <Modal title="원문 정정" onClose={closeDraft} busy={busy} draft={{ text, reason }}>
      <p>최초 접수 원문과 확정 스냅샷은 보존합니다. 작업용 원문만 다시 분석합니다.</p>
      <details>
        <summary>최초 접수 원문</summary>
        <pre>{order.receipt?.original ?? order.raw}</pre>
      </details>
      <Field label="작업용 원문">
        <textarea
          rows={12}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setPreview(undefined);
          }}
        />
      </Field>
      <Field label="정정 사유">
        <input
          value={reason}
          onChange={(e) => {
            setReason(e.target.value);
            setPreview(undefined);
          }}
        />
      </Field>
      {updated && (
        <section className="card">
          <h3>변경 비교</h3>
          <p>
            배송 건 {order.recipients.length} → {updated.recipients.length}
          </p>
          <p>
            이전:{" "}
            {order.recipients
              .map(
                (r) => `${r.name}: ${r.items.map((i) => i.name + " × " + i.quantity).join(", ")}`,
              )
              .join(" / ")}
          </p>
          <p>
            변경:{" "}
            {updated.recipients
              .map(
                (r) => `${r.name}: ${r.items.map((i) => i.name + " × " + i.quantity).join(", ")}`,
              )
              .join(" / ")}
          </p>
          <p>기존 배송 건의 삭제 / 추가와 품목 / 수량을 확인한 뒤 반영하세요.</p>
        </section>
      )}
      <p role="alert" className="form-error">
        {error}
      </p>
      <div className="product-edit-footer">
        <button onClick={closeDraft}>닫기</button>
        <button
          onClick={() => {
            try {
              setPreview(correctWorkingRaw(state, order, text, reason));
              setError("");
            } catch (e) {
              setError(String(e));
            }
          }}
        >
          재분석 / 변경 비교
        </button>
        <button
          className="primary"
          disabled={!preview || busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onApply(preview!);
              onClose();
            } catch (e) {
              setError(String(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          확인 후 반영
        </button>
      </div>
    </Modal>
  );
}
