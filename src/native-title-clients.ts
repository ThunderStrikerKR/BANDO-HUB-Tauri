/** Rust is authoritative for Kakao window title ↔ client mapping.
 * Window capture, React suggestions, and explicit selection stay in the UI.
 */
import { businessCoreCall } from "./tauri-bridge";
import type { DockWindow, State } from "./types";

export async function nativeRememberedTitleClient(
  state: State, windows: DockWindow[],
): Promise<string | undefined> {
  const { clientId } = await businessCoreCall<{ clientId: string | null }>(
    "catalog_clients", "remembered_title_client", { state, windows },
  );
  return clientId ?? undefined;
}

export async function nativeRememberTitle(
  state: State, windows: DockWindow[], handle: string,
  clientId: string, actor: string,
): Promise<State> {
  const { state: next } = await businessCoreCall<{ state: State }>(
    "catalog_clients", "remember_title_client", {
      state, windows, handle, clientId, actor, now: new Date().toISOString(),
    },
  );
  return next;
}
