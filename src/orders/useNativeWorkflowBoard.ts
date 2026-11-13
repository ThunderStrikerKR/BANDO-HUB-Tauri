/** Compiled Rust owns live workflow-board money, VAT and approval projections.
 * Only the React view model is cached here. Stale IPC responses are ignored,
 * and no old TypeScript calculator runs as a fallback.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { businessCoreCall } from "../tauri-bridge";
import type { Origin, Price, State, ValidationIssue } from "../types";

export type NativeShipmentPreview = {
  shipmentId: string;
  paid: number;
  displayCharges: Partial<Record<Origin, Price>>;
  freightEditingBlocked: boolean;
  totals: { subtotal: Price; shipping: Price; vat: Price; total: Price };
  freightCode: string;
  vatIncluded: boolean;
};
export type NativeGroupPreview = {
  groupId: string;
  step: number;
  nextStep: number;
  needsNotice: boolean;
  transferred: boolean;
  shipmentCount: number;
  totals: { subtotal: Price; shipping: Price; vat: Price; total: Price };
  vatLabel: string;
  shipments: NativeShipmentPreview[];
  issues: ValidationIssue[];
  nextStageBlockers: string[];
};
type NativeProjection = { groups: NativeGroupPreview[] };

export function useNativeWorkflowBoard(state: State) {
  // A semantic key prevents unnecessary IPC when the caller recreates an
  // equivalent JSON object; its value changes for every meaningful edit.
  const fingerprint = useMemo(() => JSON.stringify(state), [state]);
  const latest = useRef(state);
  latest.current = state;
  const [resolved, setResolved] = useState<{
    fingerprint: string; result: NativeProjection;
  }>();
  const [failure, setFailure] = useState<{ fingerprint: string; reason: string }>();
  useEffect(() => {
    let cancelled = false;
    void businessCoreCall<NativeProjection>("rules", "preview_workflow", {
      state: latest.current,
    }).then((result) => {
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
  }, [fingerprint]);
  const ready = resolved?.fingerprint === fingerprint;
  const byId = useMemo(() => {
    if (!ready || !resolved) return {} as Record<string, NativeGroupPreview>;
    return Object.fromEntries(resolved.result.groups.map((group) => [group.groupId, group]));
  }, [ready, resolved]);
  return {
    ready,
    byId,
    pending: !ready && failure?.fingerprint !== fingerprint,
    error: failure?.fingerprint === fingerprint ? failure.reason : "",
  };
}
