import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

type HelpTooltipProps = {
  title: string;
  purpose: string;
  when?: string;
  steps?: string[];
  result?: string;
  caution?: string;
};

/**
 * Beginner-friendly help. Native popover keeps the full explanation above
 * modal dialogs and scrolling panels instead of clipping it.
 */
export function HelpTooltip({ title, purpose, when, steps, result, caution }: HelpTooltipProps) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const closing = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [open, setOpen] = useState(false);

  const cancelClose = () => {
    if (closing.current !== null) clearTimeout(closing.current);
    closing.current = null;
  };
  const scheduleClose = () => {
    cancelClose();
    closing.current = setTimeout(() => setOpen(false), 180);
  };

  useEffect(() => {
    if (!open) return;
    const button = trigger.current, help = panel.current;
    if (!button || !help) return;

    const position = () => {
      const rect = button.getBoundingClientRect();
      const width = Math.min(360, Math.max(220, window.innerWidth - 24));
      help.style.width = width + "px";
      const height = help.getBoundingClientRect().height;
      const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12));
      const below = rect.bottom + 8 + height <= window.innerHeight - 12;
      help.style.left = left + "px";
      help.style.top = (below ? rect.bottom + 8 : Math.max(12, rect.top - height - 8)) + "px";
    };

    if (!help.matches(":popover-open")) help.showPopover();
    position();
    const dismiss = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && !button.contains(target) && !help.contains(target))
        setOpen(false);
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        event.stopPropagation();
      }
    };
    document.addEventListener("pointerdown", dismiss, true);
    document.addEventListener("keydown", keydown, true);
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => {
      document.removeEventListener("pointerdown", dismiss, true);
      document.removeEventListener("keydown", keydown, true);
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
      if (help.matches(":popover-open")) help.hidePopover();
    };
  }, [open]);

  useEffect(() => () => {
    if (closing.current !== null) clearTimeout(closing.current);
  }, []);

  return (
    <span className="help-tooltip-anchor">
      <button
        ref={trigger}
        type="button"
        className="help-tooltip-trigger"
        aria-label={title + " 도움말"}
        aria-describedby={open ? id : undefined}
        aria-expanded={open}
        onPointerEnter={() => { cancelClose(); setOpen(true); }}
        onPointerLeave={scheduleClose}
        onFocus={() => { cancelClose(); setOpen(true); }}
        onBlur={scheduleClose}
        onClick={() => { cancelClose(); setOpen(true); }}
      >?</button>
      {createPortal(
        <div
          id={id}
          ref={panel}
          popover="manual"
          role="tooltip"
          className="help-tooltip-panel"
          onPointerEnter={cancelClose}
          onPointerLeave={scheduleClose}
          onFocus={cancelClose}
          onBlur={scheduleClose}
        >
          <strong className="help-tooltip-title">{title}</strong>
          <p>{purpose}</p>
          {when && <><b>언제 사용하나요?</b><p>{when}</p></>}
          {!!steps?.length && <><b>사용 방법</b><ol>{steps.map((step, index) => <li key={index}>{step}</li>)}</ol></>}
          {result && <><b>사용하면 어떻게 되나요?</b><p>{result}</p></>}
          {caution && <><b>알아둘 점</b><p>{caution}</p></>}
        </div>,
        document.body,
      )}
    </span>
  );
}
