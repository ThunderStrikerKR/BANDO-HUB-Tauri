import { businessCoreCall } from "./tauri-bridge";
import type { State } from "./types";

// Read-only Rust projection. Staff approval still requires the latest DB revision.
export async function nativeFactoryConflictConfirmation(
  state: State, id: string, rowNumber: number,
): Promise<string> {
  const { text } = await businessCoreCall<{ text: string }>(
    "rules", "factory_conflict_confirmation", { state, id, rowNumber },
  );
  return text;
}
