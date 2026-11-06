import { useId } from "react";
import { useField } from "../ui/Field";
export function moveDate(value: string, delta: number) {
  const base = value || new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
  const date = new Date(base + "T12:00:00Z");
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}
export function DateNavigator({
  value,
  onChange,
  label,
  onClear,
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
  onClear?: () => void;
}) {
  const field = useField(),
    id = useId();
  return (
    <div className={onClear ? "date-navigator date-navigator-with-clear" : "date-navigator"}>
      <button aria-label={label + " 이전 날짜"} onClick={() => onChange(moveDate(value, -1))}>
        ‹
      </button>
      <input
        id={field?.id ?? id}
        aria-label={label}
        type="date"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <button aria-label={label + " 다음 날짜"} onClick={() => onChange(moveDate(value, 1))}>
        ›
      </button>
      {onClear && <button onClick={onClear}>전체 날짜</button>}
    </div>
  );
}
