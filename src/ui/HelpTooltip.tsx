import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

export type HelpTooltipText = {
  purpose: string;
  when?: string;
  steps?: string[];
  result?: string;
  caution?: string;
};

/**
 * Mouse-only help. Hovering for 500ms previews it; clicking pins it until
 * the next action outside the help (including keyboard input or page scroll).
 */
export function HelpTooltip({ title, purpose, when, steps, result, caution }: HelpTooltipText & { title: string }) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const hoverOpening = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closing = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pinned = useRef(false);
  const [open, setOpen] = useState(false);

  const cancelHoverOpen = () => {
    if (hoverOpening.current !== null) clearTimeout(hoverOpening.current);
    hoverOpening.current = null;
  };
  const cancelClose = () => {
    if (closing.current !== null) clearTimeout(closing.current);
    closing.current = null;
  };
  const dismiss = () => {
    pinned.current = false;
    cancelHoverOpen();
    cancelClose();
    setOpen(false);
  };
  const scheduleClose = () => {
    if (pinned.current) return;
    cancelClose();
    closing.current = setTimeout(() => {
      closing.current = null;
      if (!pinned.current) setOpen(false);
    }, 180);
  };
  const previewOnHover = () => {
    cancelClose();
    if (open || pinned.current || hoverOpening.current !== null) return;
    hoverOpening.current = setTimeout(() => {
      hoverOpening.current = null;
      setOpen(true);
    }, 500);
  };
  const leaveTrigger = () => {
    cancelHoverOpen();
    scheduleClose();
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
    const outsidePointer = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && !button.contains(target) && !help.contains(target))
        dismiss();
    };
    // Keyboard navigation and typing should never activate or retain mouse help.
    const keyboardAction = () => dismiss();
    const otherInput = (event: Event) => {
      if (event.target instanceof Node && !help.contains(event.target)) dismiss();
    };
    const onScroll = (event: Event) => {
      if (pinned.current && !(event.target instanceof Node && help.contains(event.target))) {
        dismiss();
      } else {
        position();
      }
    };
    const onWheel = (event: WheelEvent) => {
      if (pinned.current && !(event.target instanceof Node && help.contains(event.target)))
        dismiss();
    };
    const onResize = () => dismiss();
    document.addEventListener("pointerdown", outsidePointer, true);
    document.addEventListener("keydown", keyboardAction, true);
    document.addEventListener("input", otherInput, true);
    document.addEventListener("change", otherInput, true);
    document.addEventListener("wheel", onWheel, true);
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("pointerdown", outsidePointer, true);
      document.removeEventListener("keydown", keyboardAction, true);
      document.removeEventListener("input", otherInput, true);
      document.removeEventListener("change", otherInput, true);
      document.removeEventListener("wheel", onWheel, true);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onScroll, true);
      if (help.matches(":popover-open")) help.hidePopover();
    };
  }, [open]);

  useEffect(() => () => {
    cancelHoverOpen();
    cancelClose();
  }, []);

  return (
    <span className="help-tooltip-anchor">
      <button
        ref={trigger}
        type="button"
        tabIndex={-1}
        className="help-tooltip-trigger"
        aria-label={title + " 도움말"}
        aria-describedby={open ? id : undefined}
        aria-expanded={open}
        onMouseEnter={previewOnHover}
        onMouseLeave={leaveTrigger}
        onClick={(event) => {
          // Keyboard-generated click events have detail 0. Help is mouse-only.
          if (event.detail === 0) return;
          cancelHoverOpen();
          cancelClose();
          if (pinned.current) dismiss();
          else {
            pinned.current = true;
            setOpen(true);
          }
          event.currentTarget.blur();
        }}
      >?</button>
      {createPortal(
        <div
          id={id}
          ref={panel}
          popover="manual"
          role="tooltip"
          className="help-tooltip-panel"
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
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
