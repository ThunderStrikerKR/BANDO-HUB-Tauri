import type { Notice } from "../shared/notices";
import { Button } from "../ui/Button";
import { useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
export function AppNotice({ notice, onDismiss }: { notice?: Notice; onDismiss: () => void }) {
  const [position, setPosition] = useState<{ left: number; top: number; maxWidth: number }>();
  useLayoutEffect(() => {
    const anchor = notice?.anchor;
    if (!anchor) {
      setPosition(undefined);
      return;
    }
    const update = () => {
      if (!anchor.isConnected) {
        onDismiss();
        return;
      }
      const box = anchor.getBoundingClientRect(),
        panel = anchor.closest("section,article,.desk-pane,.modal")?.getBoundingClientRect();
      const left = Math.max(panel?.left ?? 8, Math.min(box.left, innerWidth - 280));
      setPosition({
        left,
        top: Math.max(
          panel?.top ?? 0,
          Math.min(box.bottom + 4, (panel?.bottom ?? innerHeight) - 54),
        ),
        maxWidth: Math.min(420, (panel?.right ?? innerWidth) - left - 8),
      });
    };
    update();
    if (notice.tone === "error") anchor.classList.add("has-inline-notice");
    window.addEventListener("resize", update);
    document.addEventListener("scroll", update, true);
    return () => {
      anchor.classList.remove("has-inline-notice");
      window.removeEventListener("resize", update);
      document.removeEventListener("scroll", update, true);
    };
  }, [notice, onDismiss]);
  const content = notice ? (
    <div
      role={notice.tone === "error" ? "alert" : "status"}
      className={`app-notice notice-${notice.tone}${notice.anchor ? " inline-notice" : ""}`}
      style={notice.anchor ? position : undefined}
    >
      <span>{notice.message}</span>
      <Button size="compact" variant="quiet" aria-label="알림 닫기" onClick={onDismiss}>
        ×
      </Button>
    </div>
  ) : null;
  return content && notice?.anchor
    ? createPortal(content, notice.anchor.closest("dialog") ?? document.body)
    : content;
}
