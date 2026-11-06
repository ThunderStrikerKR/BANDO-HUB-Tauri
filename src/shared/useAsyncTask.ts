import { useCallback, useEffect, useRef, useState } from "react";
import { useNoticeSink } from "./NoticeContext";
import type { NoticeSink } from "./notices";
import { createTaskGate } from "./task-gate";
export function useAsyncTask(onError?: NoticeSink) {
  const notify = useNoticeSink();
  const gate = useRef(createTaskGate()),
    mounted = useRef(true),
    report = useRef(onError ?? notify);
  report.current = onError ?? notify;
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const run = useCallback(async <T>(action: () => T | Promise<T>) => {
    if (gate.current.busy) return { ok: false as const, reason: "busy" as const };
    if (mounted.current) setBusy(true);
    const result = await gate.current.run(action);
    if (mounted.current) {
      setBusy(false);
      if (!result.ok && result.reason === "error")
        report.current(result.message ?? "작업을 완료하지 못했습니다.", "error");
    }
    return result;
  }, []);
  return { busy, run };
}
