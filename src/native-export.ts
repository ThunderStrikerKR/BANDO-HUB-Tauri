/** Rust-owned output history transition, after ExcelJS and Windows Save As.
 * The persisted state is still committed once by the existing revision-checked
 * SQLite onSave. No TypeScript state reducer fallback is permitted.
 */
import { businessCoreCall } from "./tauri-bridge";
import type { State, Origin } from "./types";
import type { FactoryExportPreview } from "./factory-export";
import type { StoreExportPreview } from "./store-export";

export async function nativeFinalizeExport(
  state: State,
  origin: Origin,
  preview: FactoryExportPreview | StoreExportPreview,
  savedPath: string,
): Promise<{ next: State; filename: string; exportId: string }> {
  return businessCoreCall("output", "finalize_export", {
    state, origin, preview, savedPath,
    now: new Date().toISOString(),
    exportId: crypto.randomUUID(),
    eventId: crypto.randomUUID(),
  });
}
