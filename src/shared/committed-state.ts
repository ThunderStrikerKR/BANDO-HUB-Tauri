import type { NoticeSink } from "./notices";
import type { State } from "../types";

/** Native persistence already succeeded. A UI refresh fault cannot turn a
 * committed save into a reported save failure or a stale Cancel baseline. */
export async function refreshAfterCommittedSave(
  label: string,
  committed: State,
  refresh: (state: State) => Promise<void>,
  notify: NoticeSink,
): Promise<boolean> {
  try {
    await refresh(committed);
    return true;
  } catch (error) {
    notify(label + " 데이터는 저장됐지만 화면 갱신에 실패했습니다. 화면을 다시 확인하세요: " +
      String(error), "error");
    return false;
  }
}
