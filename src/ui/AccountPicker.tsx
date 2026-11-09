import { useEffect, useId, useRef, useState } from "react";
import type { Account } from "../types";
import { HelpTooltip, type HelpTooltipText } from "./HelpTooltip";
export function AccountPicker({
  label,
  accounts,
  value,
  onChange,
  emptyLabel = "계좌 선택",
  help,
}: {
  label: string;
  accounts: Account[];
  value: string;
  onChange: (id: string) => void;
  emptyLabel?: string;
  help?: HelpTooltipText;
}) {
  const [open, setOpen] = useState(false),
    [active, setActive] = useState(0),
    root = useRef<HTMLDivElement>(null),
    id = useId();
  const [above, setAbove] = useState(false);
  const options = [
    { id: "", text: emptyLabel },
    ...accounts
      .filter((a) => a.bank.trim() && a.number.trim() && a.holder.trim())
      .map((a) => ({ id: a.id, text: `${a.bank} ${a.number} ${a.holder}` })),
  ];
  const chosen = options.find((o) => o.id === value);
  const show = () => {
    setActive(
      Math.max(
        0,
        options.findIndex((o) => o.id === value),
      ),
    );
    setAbove(innerHeight - (root.current?.getBoundingClientRect().bottom ?? 0) < 240);
    setOpen(true);
  };
  const choose = (index: number) => {
    onChange(options[index].id);
    setOpen(false);
    root.current?.querySelector("button")?.focus();
  };
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);
  return (
    <div className="account-picker" ref={root}>
      <span id={id + "-label"}>{label} {help && <HelpTooltip title={label} {...help} />}</span>
      <button
        type="button"
        role="combobox"
        aria-labelledby={id + "-label"}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-activedescendant={open ? id + "-" + active : undefined}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setOpen(false);
            return;
          }
          if (e.key === "Tab") {
            setOpen(false);
            return;
          }
          if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
            e.preventDefault();
            if (!open) {
              show();
              return;
            }
            setActive(
              e.key === "Home"
                ? 0
                : e.key === "End"
                  ? options.length - 1
                  : Math.max(
                      0,
                      Math.min(options.length - 1, active + (e.key === "ArrowDown" ? 1 : -1)),
                    ),
            );
          }
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            if (open) choose(active);
            else show();
          }
        }}
      >
        <span>{chosen?.text ?? emptyLabel}</span>
        <span aria-hidden="true">⌄</span>
      </button>
      {open && (
        <div
          id={id}
          role="listbox"
          aria-label={label}
          className={"account-options" + (above ? " above" : "")}
        >
          {options.map((o, index) => (
            <button
              type="button"
              role="option"
              id={id + "-" + index}
              aria-selected={o.id === value}
              className={index === active ? "focused" : ""}
              tabIndex={-1}
              key={o.id}
              onPointerMove={() => setActive(index)}
              onClick={() => choose(index)}
            >
              {o.text}
              {o.id === value && <span aria-hidden="true"> ✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
