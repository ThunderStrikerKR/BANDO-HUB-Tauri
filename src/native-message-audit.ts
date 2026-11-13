/** Rust state transition for a confirmed clipboard message-copy event.
 * The current TypeScript payment template signature is retained as a
 * cross-version compatibility input until native message rendering has
 * complete per-template equivalence.
 */
import { paymentSignature } from "./automatic-message";
import { businessCoreCall } from "./tauri-bridge";
import type { State } from "./types";

export async function nativeRecordMessageCopy(
  state: State, groupId: string, copyType: "REQUEST" | "PAYMENT", token: string,
): Promise<State> {
  const signature = copyType === "PAYMENT" ? paymentSignature(state, groupId) : undefined;
  const { state: next } = await businessCoreCall<{ state: State }>(
    "rules", "record_message_copy", {
      state, groupId, copyType, token,
      ...(signature !== undefined ? { signature } : {}),
      now: new Date().toISOString(),
      eventId: crypto.randomUUID(),
    },
  );
  return next;
}
