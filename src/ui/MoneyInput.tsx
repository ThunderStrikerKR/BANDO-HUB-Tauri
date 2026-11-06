import { useState } from "react";
import { useField } from "./Field";
export function MoneyInput({
  value,
  onChange,
  label,
  id,
  placeholder = "확인 필요",
}: {
  value: number | null;
  onChange: (value: number | null) => void;
  label?: string;
  id?: string;
  placeholder?: string;
}) {
  const field = useField();
  const [editing, setEditing] = useState(false);
  return (
    <input
      className="money-input"
      id={id ?? field?.id}
      aria-label={label ?? field?.label}
      inputMode="numeric"
      placeholder={placeholder}
      value={value === null ? "" : editing ? String(value) : value.toLocaleString("ko-KR")}
      onFocus={() => setEditing(true)}
      onBlur={() => setEditing(false)}
      title="원 단위 정수 입력"
      onChange={(event) => {
        const text = event.target.value.replaceAll(",", "");
        if (!/^\d*$/.test(text)) return;
        const amount = text === "" ? null : Number(text);
        if (amount === null || Number.isSafeInteger(amount)) onChange(amount);
      }}
    />
  );
}
