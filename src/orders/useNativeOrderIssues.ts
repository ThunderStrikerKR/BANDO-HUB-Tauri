/** Authoritative compiled Rust orderIssues projection for staff review.
 * The legacy TS hubMessages/validation functions must not decide live
 * approval state. Discard any response for an older draft fingerprint.
 */
import { useEffect, useMemo, useState } from "react";
import { businessCoreCall } from "../tauri-bridge";
import type { Order, ValidationIssue } from "../types";

export function useNativeOrderIssues(draft: Order) {
  const fingerprint = useMemo(() => JSON.stringify(draft), [draft]);
  const [resolved, setResolved] = useState<{
    fingerprint: string;
    issues: ValidationIssue[];
  }>();
  const [failure, setFailure] = useState<{
    fingerprint: string;
    reason: string;
  }>();
  useEffect(() => {
    let cancelled = false;
    void businessCoreCall<{ issues: ValidationIssue[] }>(
      "rules", "order_issues", { order: draft },
    ).then(({ issues }) => {
      if (!cancelled) {
        setResolved({ fingerprint, issues });
        setFailure(undefined);
      }
    }).catch((error) => {
      if (!cancelled) {
        setResolved(undefined);
        setFailure({ fingerprint, reason: String(error) });
      }
    });
    return () => { cancelled = true; };
  }, [fingerprint]);
  const ready = resolved?.fingerprint === fingerprint;
  return {
    ready,
    issues: ready ? resolved!.issues : [],
    error: failure?.fingerprint === fingerprint ? failure.reason : "",
  };
}
