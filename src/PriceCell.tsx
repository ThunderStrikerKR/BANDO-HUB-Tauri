import { useEffect, useRef, useState } from "react";
import { readableError } from "./errors";
import type { Price } from "./types";
export function PriceCell({
  value,
  label,
  enabled,
  onSave,
}: {
  value: Price;
  label: string;
  enabled: boolean;
  onSave: (value: Price, expected: Price) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false),
    [draft, setDraft] = useState(value ? String(value) : ""),
    [status, setStatus] = useState(""),
    [error, setError] = useState("");
  const saving = useRef(false),
    cancelled = useRef(false),
    expected = useRef(value),
    input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!editing) setDraft(value ? String(value) : "");
  }, [value, editing]);
  const save = async () => {
    if (!enabled || !editing) return;
    if (cancelled.current) {
      cancelled.current = false;
      return;
    }
    if (saving.current) return;
    const text = draft.replaceAll(",", "");
    if (
      text !== "" &&
      (!/^(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(draft) || !Number.isSafeInteger(Number(text)))
    ) {
      setError("원 단위 정수를 입력하세요. 0 또는 빈칸은 미등록입니다.");
      setStatus("실패");
      return;
    }
    const n = text === "" || Number(text) === 0 ? null : Number(text);
    if (n === expected.current) {
      setEditing(false);
      return;
    }
    saving.current = true;
    setStatus("저장 중");
    try {
      await onSave(n, expected.current);
      setStatus(n === null ? "미등록으로 저장됨" : "저장됨");
      setError("");
      setEditing(false);
    } catch (e) {
      setError(readableError(e));
      setStatus("저장 실패");
    } finally {
      saving.current = false;
    }
  };
  return (
    <div className={"price-cell " + (error ? "invalid" : "")} data-locked={!enabled}>
      <input
        ref={input}
        aria-label={label}
        data-price-cell
        inputMode="numeric"
        readOnly={!enabled}
        title={enabled ? "Enter 저장 / Esc 취소 / 다른 곳 클릭 시 미저장 입력 폐기 (0은 미등록)" : "가격 수정 모드를 켜세요"}
        value={editing ? draft : value ? value.toLocaleString("ko-KR") : ""}
        placeholder="미등록"
        onFocus={(e) => {
          if (!enabled) return;
          if (!editing) {
            expected.current = value;
            setDraft(value ? value.toLocaleString("ko-KR") : "");
            setEditing(true);
            setStatus("");
          }
          e.currentTarget.select();
        }}
        onChange={(e) => {
          if (enabled) {
            setDraft(e.target.value);
            setError("");
          }
        }}
        onBlur={() => {
          // Focus changes are not permission to write a product price.
          if (saving.current || !editing) return;
          setDraft(value ? String(value) : "");
          setEditing(false);
          setError("");
          setStatus("");
        }}
        onKeyDown={(e) => {
          if (!enabled) return;
          if (e.key === "Enter") {
            e.preventDefault();
            void save();
          }
          if (e.key === "Escape") {
            cancelled.current = true;
            setDraft(value ? String(value) : "");
            setEditing(false);
            setError("");
            setStatus("취소");
            input.current?.blur();
          }
        }}
      />
      <small role={error ? "alert" : "status"} title={error || status} aria-live="polite">
        {error || status}
      </small>
    </div>
  );
}
