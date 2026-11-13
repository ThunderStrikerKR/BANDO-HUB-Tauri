/** Rust state transition following a successful clipboard write.
 * The signed payment text is rendered and selected by the same Rust message
 * operation that displays the invoice; no TypeScript billing signature exists
 * on the active message copy path.
 */
import { businessCoreCall } from "./tauri-bridge";
import type { State } from "./types";

export async function nativeRecordMessageCopy(
  state: State,
  groupId: string,
  copyType: "REQUEST" | "PAYMENT",
  token: string,
  signature?: string,
): Promise<State> {
  if (copyType === "PAYMENT" && signature === undefined) {
    throw Error("결제 안내 서명 정보가 없습니다. 메시지를 다시 확인하세요.");
  }
  const { state: next } = await businessCoreCall<{ state: State }>(
    "rules", "record_message_copy", {
      state, groupId, copyType, token,
      ...(copyType === "PAYMENT" ? { signature } : {}),
      now: new Date().toISOString(),
      eventId: crypto.randomUUID(),
    },
  );
  return next;
}
