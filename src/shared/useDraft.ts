import { useEffect, useRef, useState } from "react";
import { rebaseDraft } from "./draft";
import { usePendingChanges } from "./pending-changes";
export function useDraft<T extends object>(incoming: T) {
  const baseline = useRef(structuredClone(incoming)),
    latest = useRef(incoming),
    current = useRef(structuredClone(incoming));
  latest.current = incoming;
  const [draft, setDraftState] = useState(current.current),
    [conflicts, setConflicts] = useState<(keyof T)[]>([]);
  const setDraft = (value: T | ((previous: T) => T)) => {
    const next =
      typeof value === "function" ? (value as (previous: T) => T)(current.current) : value;
    current.current = next;
    setDraftState(next);
  };
  useEffect(() => {
    if (JSON.stringify(baseline.current) === JSON.stringify(incoming)) return;
    const result = rebaseDraft(baseline.current, current.current, incoming);
    baseline.current = structuredClone(incoming);
    setDraft(result.draft);
    setConflicts((previous) => [...new Set([...previous, ...result.conflicts])]);
  }, [incoming]);
  const reset = () => {
    baseline.current = structuredClone(latest.current);
    setDraft(structuredClone(latest.current));
    setConflicts([]);
  };
  const dirty = JSON.stringify(draft) !== JSON.stringify(incoming);
  usePendingChanges(dirty);
  return {
    draft,
    setDraft,
    conflicts,
    reset,
    dirty,
  };
}
