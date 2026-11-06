import type { ReactNode } from "react";
import { useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { usePendingChanges } from "../shared/pending-changes";
const modalStack: HTMLDialogElement[] = [];
export function pauseModalLayer() {
  const el = modalStack.at(-1);
  el?.close();
  return () => {
    if (el?.isConnected && modalStack.at(-1) === el && !el.open) el.showModal();
  };
}
export function Modal({
  title,
  children,
  onClose,
  busy = false,
  draft,
  className,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  busy?: boolean;
  draft?: unknown;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null),
    close = useRef(onClose);
  const initial = useRef(JSON.stringify(draft));
  usePendingChanges(draft !== undefined && JSON.stringify(draft) !== initial.current);
  close.current = () => {
    if (!busy) onClose();
  };
  useLayoutEffect(() => {
    const el = ref.current!,
      previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    modalStack.at(-1)?.close();
    modalStack.push(el);
    el.showModal();
    return () => {
      const top = modalStack.at(-1) === el;
      modalStack.splice(modalStack.indexOf(el), 1);
      el.close();
      if (top) {
        const parent = modalStack.at(-1);
        if (parent?.isConnected && !parent.open) parent.showModal();
        if (previous?.isConnected && (!parent || parent.contains(previous)))
          previous.focus({ preventScroll: true });
      }
    };
  }, []);
  return createPortal(
    <dialog
      ref={ref}
      className={"app-modal-layer" + (className ? " " + className : "")}
      aria-busy={busy || undefined}
      aria-label={title}
      aria-modal="true"
      onCancel={(e) => {
        e.preventDefault();
        close.current();
      }}
    >
      <section className="modal">
        <header>
          <h2>{title}</h2>
          <button disabled={busy} onClick={() => close.current()}>
            닫기 ×
          </button>
        </header>
        <fieldset role="presentation" className="modal-fields" disabled={busy}>
          {children}
        </fieldset>
      </section>
    </dialog>,
    document.body,
  );
}
