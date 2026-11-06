import { useCallback, useEffect, useRef, useState } from "react";
import { readableError } from "../errors";
import type { Notice, NoticeSink } from "./notices";
export function useNotice() {
  const [notice, setNotice] = useState<Notice>(),
    serial = useRef(0),
    lastTarget = useRef<HTMLElement | undefined>(undefined);
  useEffect(() => {
    const track = (event: Event) => {
      if (event.target instanceof HTMLElement)
        lastTarget.current =
          event.target.closest<HTMLElement>("input,textarea,select,button") ?? event.target;
    };
    document.addEventListener("pointerdown", track, true);
    document.addEventListener("focusin", track, true);
    return () => {
      document.removeEventListener("pointerdown", track, true);
      document.removeEventListener("focusin", track, true);
    };
  }, []);
  const notify = useCallback<NoticeSink>((message, tone = "info") => {
    const text = readableError(message);
    const system =
      tone === "error" &&
      /저장.*(?:실패|오류)|(?:실패|오류).*저장|SQLite|데이터베이스|DB|시스템|네트워크|통신|충돌|연결 오류|not defined|Cannot read|IPC|state:save|disk|SQLITE/i.test(
        text,
      );
    const target = lastTarget.current?.isConnected
      ? lastTarget.current
      : document.activeElement instanceof HTMLElement
        ? document.activeElement
        : undefined;
    const anchor = system
      ? undefined
      : (target?.closest<HTMLElement>("input,textarea,select,button,section,article,.desk-pane") ??
        document.querySelector<HTMLElement>(".source-pane") ??
        undefined);
    setNotice((previous) =>
      !message
        ? undefined
        : previous?.tone === tone && previous.message === text && previous.anchor === anchor
          ? previous
          : { message: text, tone, id: ++serial.current, anchor },
    );
  }, []);
  const dismiss = useCallback(() => setNotice(undefined), []);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(
      dismiss,
      notice.tone === "success" ? 3000 : notice.anchor ? 5000 : 8000,
    );
    const clear = (event: Event) => {
      if (notice.anchor && event.target instanceof Element && !event.target.closest(".app-notice"))
        dismiss();
    };
    document.addEventListener("input", clear, true);
    document.addEventListener("change", clear, true);
    document.addEventListener("pointerdown", clear, true);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("input", clear, true);
      document.removeEventListener("change", clear, true);
      document.removeEventListener("pointerdown", clear, true);
    };
  }, [notice, dismiss]);
  return { notice, notify, dismiss };
}
