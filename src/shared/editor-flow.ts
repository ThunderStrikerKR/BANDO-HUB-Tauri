import { confirmAction } from "../dialogs";

/** Consistent exit contract for draft-only dialogs. */
export async function confirmDiscardDraft(
  label: string, changed: boolean, onClose: () => void, busy = false,
): Promise<boolean> {
  if (busy) return false;
  if (changed && !(await confirmAction(
    label + "에 저장하지 않은 변경사항이 있습니다. 저장하지 않고 닫을까요?",
    { cancel: "계속 편집", accept: "저장 안 함" },
  ))) return false;
  onClose();
  return true;
}
