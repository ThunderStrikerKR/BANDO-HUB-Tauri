/** Native client workbook preview. ExcelJS remains the file-format adapter.
 * Rust owns all editable row decisions and collision policy.
 */
import { readClientWorkbookRows, type ClientWorkbookPreview } from "./client-workbook";
import { businessCoreCall } from "./tauri-bridge";
import type { State } from "./types";

export async function previewNativeClientWorkbook(
  state: State, file: File,
): Promise<ClientWorkbookPreview> {
  const { sourceRevision, cells } = await readClientWorkbookRows(state, file);
  return businessCoreCall<ClientWorkbookPreview>("catalog_clients", "preview_client_rows", {
    state, sourceRevision, input: cells,
    newIds: cells.map((row) => row.cells[0]?.trim() ? null : crypto.randomUUID()),
  });
}
