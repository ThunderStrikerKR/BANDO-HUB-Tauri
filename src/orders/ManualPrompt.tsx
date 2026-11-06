import { useLayoutEffect, useRef, type ReactNode } from "react";

/** A local layer: the manual workspace stays mounted and Kakao remains outside it. */
export function ManualPrompt({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const root = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    root.current
      ?.querySelector<HTMLElement>("[data-autofocus], button:not(:disabled), input:not(:disabled)")
      ?.focus({ preventScroll: true });
    return () => {
      requestAnimationFrame(() => previous?.isConnected && previous.focus({ preventScroll: true }));
    };
  }, []);
  return (
    <div className="manual-completion-backdrop">
      <section
        ref={root}
        className="manual-completion"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }
          if (event.key === "Tab") {
            const nodes = Array.from(
              event.currentTarget.querySelectorAll<HTMLElement>(
                "button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href]",
              ),
            );
            const index = nodes.indexOf(document.activeElement as HTMLElement);
            event.preventDefault();
            nodes[(index + (event.shiftKey ? -1 : 1) + nodes.length) % nodes.length]?.focus({
              preventScroll: true,
            });
          }
        }}
      >
        <h3>{title}</h3>
        {children}
      </section>
    </div>
  );
}
