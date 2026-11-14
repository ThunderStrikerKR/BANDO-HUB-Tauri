import { useEffect, useRef, useState } from "react";
import { readableError } from "./errors";
import type { Price } from "./types";

/**
 * Inline price edits are staged until the user chooses Enter or Save.
 * Blur is not permission to change financial data, but must never discard
 * the staged text. Price writes still use the native revision/expected-value
 * protected setPrice operation provided by ProductManager.
 */
export function PriceCell({
  value,
  label,
  enabled,
  onSave,
  onPendingChange,
}: {
  value: Price;
  label: string;
  enabled: boolean;
  onSave: (value: Price, expected: Price) => Promise<void>;
  onPendingChange?: (pending: boolean) => void;
}) {
  const [editing, setEditing] = useState(false),
    [draft, setDraft] = useState(value === null ? "" : String(value)),
    [busy, setBusy] = useState(false),
    [status, setStatus] = useState(""),
    [error, setError] = useState("");
  const saving = useRef(false),
    expected = useRef(value),
    input = useRef<HTMLInputElement>(null),
    lastReportedPending = useRef(false);
  const pendingRef = useRef(onPendingChange);
  pendingRef.current = onPendingChange;

  const normalizedDraft = draft.replaceAll(",", "");
  const pending = editing && normalizedDraft !== (expected.current === null ? "" : String(expected.current));

  useEffect(() => {
    if (!editing) setDraft(value === null ? "" : String(value));
  }, [value, editing]);

  // Report only transitions, not every unedited cell on initial table mount.
  useEffect(() => {
    if (lastReportedPending.current === pending) return;
    lastReportedPending.current = pending;
    pendingRef.current?.(pending);
  }, [pending]);
  useEffect(() => () => {
    if (lastReportedPending.current) pendingRef.current?.(false);
  }, []);

  const cancel = () => {
    if (saving.current) return;
    setDraft(value === null ? "" : value.toLocaleString("ko-KR"));
    setEditing(false);
    setError("");
    setStatus("취소");
    input.current?.blur();
  };

  const save = async () => {
    if (!editing || saving.current) return;
    const text = draft.replaceAll(",", "");
    if (
      text !== "" &&
      (!/^(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(draft) || !Number.isSafeInteger(Number(text)))
    ) {
      setError("원 단위 정수를 입력하세요. 0 또는 빈칸은 미등록입니다.");
      setStatus("저장 실패");
      return;
    }
    const n = text === "" || Number(text) === 0 ? null : Number(text);
    if (n === expected.current) {
      setEditing(false);
      setError("");
      setStatus("변경 없음");
      return;
    }
    saving.current = true;
    setBusy(true);
    setStatus("저장 중");
    try {
      await onSave(n, expected.current);
      expected.current = n;
      setStatus(n === null ? "미등록으로 저장됨" : "저장됨");
      setError("");
      setEditing(false);
    } catch (e) {
      // Keep the original draft and expected price for an explicit retry.
      setError(readableError(e));
      setStatus("저장 실패");
    } finally {
      saving.current = false;
      setBusy(false);
    }
  };

  return (
    <div
      className={"price-cell" + (error ? " invalid" : "") + (pending ? " pending" : "")}
      data-locked={!enabled}
      data-price-pending={pending}
    >
      <input
        ref={input}
        aria-label={label}
        data-price-cell
        inputMode="numeric"
        readOnly={!enabled || busy}
        title={enabled
          ? "Enter 또는 저장 버튼으로 저장 / Esc 또는 취소 버튼으로 되돌리기 / 포커스 이동해도 입력 유지 (0은 미등록)"
          : "가격 수정 모드를 켜세요"}
        value={editing ? draft : value === null ? "" : value.toLocaleString("ko-KR")}
        placeholder="미등록"
        onFocus={(e) => {
          if (!enabled || busy) return;
          if (!editing) {
            expected.current = value;
            setDraft(value === null ? "" : value.toLocaleString("ko-KR"));
            setEditing(true);
            setStatus("");
            setError("");
          }
          e.currentTarget.select();
        }}
        onChange={(e) => {
          if (enabled && !busy) {
            setDraft(e.target.value);
            setError("");
            setStatus("");
          }
        }}
        onBlur={() => {
          // Focus changes must NOT silently save OR discard a price edit.
          if (saving.current || !editing) return;
          if (pending) setStatus("미저장 · Enter 또는 저장 버튼");
        }}
        onKeyDown={(e) => {
          if (!enabled || busy) return;
          if (e.key === "Enter") {
            e.preventDefault();
            void save();
          }
          if (e.key === "Escape") {
            e.preventDefault();
            cancel();
          }
        }}
      />
      {editing && (
        <span className="price-cell-actions">
          <button
            type="button"
            className="price-cell-save"
            aria-label={label + " 저장"}
            disabled={busy}
            onClick={() => void save()}
          >저장</button>
          <button
            type="button"
            className="price-cell-cancel"
            aria-label={label + " 취소"}
            disabled={busy}
            onClick={cancel}
          >취소</button>
        </span>
      )}
      <small role={error ? "alert" : "status"} title={error || status} aria-live="polite">
        {error || status}
      </small>
    </div>
  );
}
