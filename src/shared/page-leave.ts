import { useEffect, useRef } from "react";
import { askSaveChanges } from "../dialogs";

export type PageLeaveGuard = {
  hasChanges: () => boolean;
  save: () => Promise<boolean>;
  discard: () => void;
  busy?: () => boolean;
  label?: string;
};

const guards = new Map<symbol, PageLeaveGuard>();

/** Register only the active editor; always invoke its newest callbacks. */
export function usePageLeaveGuard(value: PageLeaveGuard) {
  const latest = useRef(value);
  latest.current = value;
  useEffect(() => {
    const id = Symbol("page-editor");
    guards.set(id, {
      hasChanges: () => latest.current.hasChanges(),
      save: () => latest.current.save(),
      discard: () => latest.current.discard(),
      busy: () => latest.current.busy?.() ?? false,
      label: latest.current.label,
    });
    return () => { guards.delete(id); };
  }, []);
}

export async function requestPageLeave(
  onError: (message: string) => void,
): Promise<{ proceed: boolean; handled: boolean }> {
  let handled = false;
  // Keep each editor responsible for saving its own data. Never fake a save.
  for (const guard of [...guards.values()]) {
    if (!guard.hasChanges()) continue;
    if (guard.busy?.()) {
      onError("현재 작업의 저장이 끝난 뒤 이동할 수 있습니다.");
      return { proceed: false, handled };
    }
    const choice = await askSaveChanges(
      (guard.label ? guard.label + "에 " : "현재 화면에 ") +
      "저장하지 않은 변경사항이 있습니다. 어떻게 할까요?",
    );
    if (choice === "cancel") return { proceed: false, handled };
    if (choice === "save") {
      try {
        if (!(await guard.save())) return { proceed: false, handled };
      } catch (error) {
        onError(error instanceof Error ? error.message : String(error));
        return { proceed: false, handled };
      }
    } else {
      guard.discard();
    }
    handled = true;
  }
  return { proceed: true, handled };
}
