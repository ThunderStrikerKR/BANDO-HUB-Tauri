import { useLayoutEffect, useRef, useSyncExternalStore } from "react";
const pending = new Set<symbol>(),
  listeners = new Set<() => void>();
const publish = () => {
  for (const listener of listeners) listener();
};
export function usePendingChanges(changed: boolean) {
  const token = useRef(Symbol("editor"));
  useLayoutEffect(() => {
    if (changed) {
      pending.add(token.current);
      publish();
    }
    return () => {
      if (pending.delete(token.current)) publish();
    };
  }, [changed]);
}
export function useHasPendingChanges() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => pending.size > 0,
    () => false,
  );
}
