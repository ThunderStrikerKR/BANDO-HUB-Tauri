/** Rust result for the order-detail financial footer.
 * A late IPC reply is discarded when the order, state, or draft changes.
 * No TypeScript business calculation runs as a fallback.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { businessCoreCall } from "../tauri-bridge";
import type { Order, Price, State, ValidationIssue } from "../types";

export type NativeOrderPreview = {
  orderId: string;
  shipmentCount: number;
  issues: ValidationIssue[];
  lineAmounts: Array<{ recipientId: string; itemId: string; amount: Price }>;
  total: Price;
  vatLabel: string;
};

export function useNativeOrderPreview(
  state: State,
  draft: Order,
  enabled = true,
) {
  const fingerprint = useMemo(
    () => JSON.stringify({ state, draft }),
    [state, draft],
  );
  const current = useRef({ state, draft });
  current.current = { state, draft };
  const [resolved, setResolved] = useState<{
    fingerprint: string;
    result: NativeOrderPreview;
  }>();
  const [failure, setFailure] = useState<{
    fingerprint: string;
    reason: string;
  }>();
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const payload = current.current;
    void businessCoreCall<NativeOrderPreview>(
      "rules", "preview_order", {
        state: payload.state,
        draft: payload.draft,
        orderId: payload.draft.id,
      },
    ).then((result) => {
      if (!cancelled) {
        setResolved({ fingerprint, result });
        setFailure(undefined);
      }
    }).catch((error) => {
      if (!cancelled) {
        setResolved(undefined);
        setFailure({ fingerprint, reason: String(error) });
      }
    });
    return () => { cancelled = true; };
  }, [enabled, fingerprint]);

  const ready = enabled && resolved?.fingerprint === fingerprint;
  return {
    ready,
    result: ready ? resolved!.result : undefined,
    error: enabled && failure?.fingerprint === fingerprint
      ? failure.reason
      : "",
  };
}
