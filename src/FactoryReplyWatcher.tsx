import { useEffect, useRef } from "react";
import { processWatchedFactoryReply } from "./factory-reply-auto";
import type { NoticeSink } from "./shared/notices";

const SCAN_INTERVAL_MS = 5_000;

/** Mounted outside individual pages so changing tabs does not stop reception.
 * A saved reception draft is never replaced: while the UI has unsaved changes
 * or another save is in progress, the watcher simply postpones DB commits.
 */
export function FactoryReplyWatcher({
  enabled, paused, onRefresh, onNotice,
}: {
  enabled: boolean;
  paused: boolean;
  onRefresh: () => Promise<void>;
  onNotice: NoticeSink;
}) {
  const latest = useRef({ enabled, paused, onRefresh, onNotice });
  latest.current = { enabled, paused, onRefresh, onNotice };
  const running = useRef(false);
  const lastError = useRef("");

  useEffect(() => {
    const tick = async () => {
      const api = window.bando;
      if (running.current || !api?.factoryReplyWatchScan
          || !latest.current.enabled || latest.current.paused) return;
      running.current = true;
      try {
        const files = await api.factoryReplyWatchScan();
        for (const file of files) {
          if (latest.current.paused || !latest.current.enabled) break;
          const result = await processWatchedFactoryReply(api, file);
          if (result.duplicate) continue;
          await latest.current.onRefresh();
          lastError.current = "";
          if (result.invalid) {
            latest.current.onNotice(
              "공장 회신 " + file.filename + ": Excel 형식 오류를 회신 이력에 보류했습니다.",
              "error",
            );
          } else {
            latest.current.onNotice(
              "공장 회신 " + file.filename + ": 자동 반영 " + result.applied +
                "건, 직원 확인 " + result.held + "건",
              result.held ? "error" : "success",
            );
          }
          if (result.archiveWarning) {
            latest.current.onNotice(
              "회신 원본과 DB는 보존했으나 Excel 보관함 사본 생성은 실패했습니다: " +
                result.archiveWarning, "error",
            );
          }
        }
      } catch (error) {
        const message = String(error);
        if (message !== lastError.current) {
          lastError.current = message;
          latest.current.onNotice("공장 회신 자동 감시: " + message, "error");
        }
      } finally {
        running.current = false;
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), SCAN_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);
  return null;
}
