/** Native Rust-only live order draft reconciliation.
 * Produces temporary preview state; NEVER writes SQLite or records a durable
 * audit event. Every in-flight native response is keyed to the exact current
 * input, so a late IPC completion cannot replace newer staff edits.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { Order, State } from "../types";
import { businessCoreCall } from "../tauri-bridge";

export function useNativeWorkflowReconcile(input: State, drafts: Order[]) {
  const fingerprint = useMemo(
    () => JSON.stringify({ input, drafts }),
    [input, drafts],
  );
  const latest = useRef({ input, drafts });
  latest.current = { input, drafts };
  const [resolved, setResolved] = useState<{ fingerprint: string; value: State }>();
  const [failure, setFailure] = useState<{ fingerprint: string; reason: string }>();
  useEffect(() => {
    // The unchanged persisted state is the exact result when there are no
    // draft overlays. Avoid an IPC request and any temporary event IDs.
    if (!latest.current.drafts.length) return;
    let cancelled = false;
    const request = latest.current;
    void (async () => {
      let value = request.input;
      for (const draft of request.drafts) {
        // Unlike a durable save, a half-entered reception must be previewable
        // even when final-workflow validation still reports staff issues.
        // The Rust reducer mirrors TS reconcileWorkflow without persisting its
        // temporary audit events to SQLite.
        const count = Math.max(256, 12 * (value.workflow?.shipments.length ?? 0) +
          8 * value.orders.length + 64);
        if (count > 15000)
          throw Error("재검증 이벤트가 너무 많습니다. 발주 묶음을 나누어 확인하세요.");
        const eventIds = Array.from({ length: count }, () => crypto.randomUUID());
        const result = await businessCoreCall<{ state: State; emittedEvents: number }>(
          "rules", "reconcile_workflow", {
            state: value,
            draft,
            now: new Date().toISOString(),
            eventIds,
          },
        );
        value = result.state;
      }
      if (!cancelled) {
        setResolved({ fingerprint, value });
        setFailure(undefined);
      }
    })().catch((error) => {
      if (!cancelled) {
        setResolved(undefined);
        setFailure({ fingerprint, reason: String(error) });
      }
    });
    return () => { cancelled = true; };
  }, [fingerprint]);

  const ready = drafts.length === 0 || resolved?.fingerprint === fingerprint;
  return {
    // A still-pending projection never falls back to the old synchronous TS
    // workflow engine. Its current input may be shown read-only while busy.
    state: ready && drafts.length ? resolved!.value : input,
    ready,
    error: failure?.fingerprint === fingerprint ? failure.reason : "",
  };
}
