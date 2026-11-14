/** Native Rust is authoritative for the factory notification and review UI.
 * No fallback to TS conflict amounts or resolved/needs-review calculations.
 */
import { useEffect, useState } from "react";
import { businessCoreCall } from "./tauri-bridge";
import type { State } from "./types";

export type NativeFactoryReplyRow = {
  row: number;
  resolved: boolean;
  hasLaterResolution: boolean;
  confirmation: string | null;
  confirmationError: string | null;
};
export type NativeFactoryReplyRecord = {
  id: string;
  needsReview: boolean;
  notificationLabel: string;
  rows: NativeFactoryReplyRow[];
};
export function useNativeFactoryReplyReview(state: State | undefined) {
  const [resolved, setResolved] = useState<{
    state: State;
    records: NativeFactoryReplyRecord[];
  }>();
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    setError("");
    if (!state) {
      setResolved(undefined);
      return () => { active = false; };
    }
    void businessCoreCall<{ records: NativeFactoryReplyRecord[] }>(
      "output", "project_factory_reply_review", { state },
    ).then(({ records }) => {
      if (active) setResolved({ state, records });
    }).catch((cause) => {
      if (active) {
        setResolved(undefined);
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    });
    return () => { active = false; };
  }, [state]);
  const records = state && resolved?.state === state ? resolved.records : undefined;
  return { records, error, ready: !!records };
}
