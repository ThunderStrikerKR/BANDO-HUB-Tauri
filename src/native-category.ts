/** Category UI bridge. Rendering/selection stays React-side; all
 * category decisions and product reassignment are native Rust.
 */
import { businessCoreCall } from "./tauri-bridge";
import type { State } from "./types";

export async function nativeChangeCategory(
  state: State,
  categoryId: string,
  name: string,
  parentId: string | null,
  transfer = false,
  guardCatalogMove = false,
  guardError = "",
): Promise<State> {
  const result = await businessCoreCall<{ state: State }>(
    "catalog_clients", "change_category", {
      state, categoryId, name, parentId, transfer, guardCatalogMove, guardError,
    },
  );
  return result.state;
}

export async function nativeDeleteCategory(
  state: State,
  categoryId: string,
  destination = "",
): Promise<State> {
  const result = await businessCoreCall<{ state: State }>(
    "catalog_clients", "delete_category", { state, categoryId, destination },
  );
  return result.state;
}
