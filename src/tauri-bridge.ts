/** BANDO HUB Tauri bridge. Active React actions map to native commands.
 * Planned mobile networking remains explicitly unavailable offline.
 */
import { invoke } from "@tauri-apps/api/core";

/** Shared Tauri IPC entry point; domain operations remain checked by Rust. */
export function businessCoreCall<T>(
  domain: "recognition" | "rules" | "output" | "catalog_clients",
  operation: string,
  payload: unknown,
): Promise<T> {
  return invoke<T>("business_core_call", { domain, operation, payload });
}

import { getCurrentWindow } from "@tauri-apps/api/window";
import type { Api, State, CatalogReport, OcrCapture, OfficialLink } from "./types";
import productImages from "./tauri-product-images.json";



const notReady = (feature: string): never => {
  throw new Error(`${feature} 기능은 아직 구현되지 않았습니다.`);
};
const appWindow = () => getCurrentWindow();
const safeImage = (siteId?: string) => {
  if (!siteId || !Object.prototype.hasOwnProperty.call(productImages, siteId)) return null;
  const filename = (productImages as Record<string, string>)[siteId];
  return { data: `./product-images/${filename}`, source: "반도스탠드 수집 이미지" };
};

const api: Api = {
  isTestWorkspace: false,
  workspaceMode: () => invoke<boolean>("workspace_mode"),
  testRecordRun: (report) => invoke<void>("test_record_run", { report }),
  testRunHistory: () => invoke("test_run_history"),
  testReceptionBoundary: (candidate) => invoke("test_reception_boundary", { candidate }),
  saveProductWorkbook: (bytes) => invoke<string | null>("save_product_workbook", { bytes }),
  saveProductSyncWorkbook: (bytes) => invoke<string | null>("save_product_sync_workbook", { bytes }),
  saveFactoryWorkbook: (bytes) => invoke<string | null>("save_factory_workbook", { bytes }),
  saveStoreWorkbook: (bytes) => invoke<string | null>("save_store_workbook", { bytes }),
  saveSettlementWorkbook: (bytes) => invoke<string | null>("save_settlement_workbook", { bytes }),
  saveOrderHistoryWorkbook: (bytes) => invoke<string | null>("save_order_history_workbook", { bytes }),
  saveClientWorkbook: (bytes) => invoke<string | null>("save_client_workbook", { bytes }),
  saveRegistrationWorkbook: (kind, bytes) => invoke<string | null>("save_registration_workbook", { kind, bytes }),
  load: () => invoke<State>("state_load"),
  save: (state) => invoke<State>("state_save", { state }),
  patchSettings: (changes, expected) => invoke<State>("settings_patch", { changes, expected }),
  setPrice: (productId, variantId, tier, price, expected) =>
    invoke<State>("price_set", { productId, variantId, tier, price, expected }),
  copy: (text) => invoke<void>("clipboard_write", { text }),
  readClipboard: () => invoke<string>("clipboard_read"),
  captureOcr: () => invoke<OcrCapture>("capture_ocr"),
  openProduct: (url) => invoke<void>("product_open", { target: url }),
  catalogReport: () => invoke<CatalogReport>("catalog_report"),
  backup: () => invoke<string>("backup_create"),
  backups: () => invoke<string[]>("backup_list"),
  restore: (filename) => invoke<void>("backup_restore", { filename }),
  productImage: async (id) => {
    const s = await invoke<State>("state_load");
    const product = s.products.find((p) => p.id === id);
    return safeImage(product?.siteId ?? product?.sourceProductId);
  },
  windowControl: async (action) => {
    if (action === "minimize") await appWindow().minimize();
    else if (action === "maximize") await appWindow().toggleMaximize();
    else if (action === "close") await appWindow().close();
  },
  requestClose: async (hasUnsavedChanges) => {
    if (hasUnsavedChanges && !window.confirm("저장하지 않은 변경사항이 있습니다. 종료할까요?")) return;
    await appWindow().close();
  },
  dockStatus: () => invoke("dock_status_native"),
  dockCycle: () => invoke("dock_cycle_native"),
  dockMode: (mode) => invoke("dock_mode_native", { mode }),
  dockStart: (handle, ratio) => invoke("dock_start_native", { handle, ratio }),
  dockStop: () => invoke("dock_stop_native"),
  dockSelect: (handle) => invoke("dock_select_native", { handle }),
  dockWindows: () => invoke("dock_windows_native"),
  dockRegion: (region) => invoke("dock_region_native", { region }),
  startupStatus: () => invoke("startup_status"),
  startupMetrics: () => invoke("startup_metrics"),
  retryStartup: () => invoke("retry_startup"),
  receiptArchive: () => invoke<{ id: string; orderId: string; record: Record<string, unknown> }[]>("receipt_archive"),
  // Confirmed receipts and corrections are written atomically by state_save.
  // The old Electron secondary-write IPC is intentionally not duplicated.
  chooseExcelDirectory: async () => (await invoke<string | null>("choose_excel_directory")) ?? undefined,
  openExcelDirectory: () => invoke<void>("open_excel_directory"),
  openDailyExcelDirectory: (kind) => invoke<void>("open_daily_excel_directory", { kind }),
  openExportFile: (id) => invoke<void>("open_export_file", { id }),
  openExportDirectory: (id) => invoke<void>("open_export_directory", { id }),
  previewImport: async (url) => {
    const html = await invoke<string>("fetch_official_product_html", { target: url });
    const state = await invoke<State>("state_load");
    return businessCoreCall("catalog_clients", "preview_official_product_html", {
      state, url, html, now: new Date().toISOString(),
      productId: crypto.randomUUID(), variantId: crypto.randomUUID(),
    });
  },
  // Suggests links from the bundled historical catalog; individual previews
  // still fetch their official product detail pages live.
  officialList: async () => {
    const links = await businessCoreCall<OfficialLink[]>("catalog_clients", "official_links", {
      report: await invoke<CatalogReport>("catalog_report"),
    });
    // Presentation-only sorting: business URL validation and deduplication
    // are authoritative in Rust, matching the original Korean UI ordering.
    return links.sort((a,b) => a.name.localeCompare(b.name,"ko"));
  },
  mobileStart: async () => notReady("스마트폰 연동"),
  mobileStop: async () => notReady("스마트폰 연동"),
  mobileStatus: async () => ({ running: false, urls: [] }),
  inbox: async () => [],
  archiveFactoryReply: (id, bytes) => invoke<string>("archive_factory_reply", { id, bytes }),
  chooseFactoryReplyDirectory: async () =>
    (await invoke<string | null>("choose_factory_reply_directory")) ?? undefined,
  factoryReplyWatchScan: () => invoke("factory_reply_watch_scan"),
  factoryReplyWatchCommit: (filename, id, candidate, expectedRevision) =>
    invoke("factory_reply_watch_commit", { filename, id, candidate, expectedRevision }),
  openFactoryFile: (id) => invoke<void>("open_factory_reply_file", { id }),
  approveFactoryConflict: (id, row, expectedRevision) =>
    invoke<void>("approve_factory_conflict", { id, row, expectedRevision }),
  testDatabasePreview: () => invoke("test_database_preview"),
  openTestWorkspace: () => invoke<void>("open_test_workspace"),
  resetTestDatabase: (revision) => invoke("reset_test_database", { revision }),
};

if (typeof window !== "undefined") window.bando = api;
