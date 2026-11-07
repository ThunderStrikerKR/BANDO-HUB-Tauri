/** BANDO HUB v0.0.4. Tauri-to-legacy React compatibility layer.
 * Electron IPC methods that have not been migrated fail explicitly.
 */
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { Api, State, CatalogReport } from "./types";
import productImages from "./tauri-product-images.json";
import { parseOfficialProductPage } from "./official-product-import";

const notReady = (feature: string): never => {
  throw new Error(`${feature}: Tauri v0.0.4에서 아직 이전하지 않은 기능입니다.`);
};
const appWindow = () => getCurrentWindow();
const safeImage = (siteId?: string) => {
  if (!siteId || !Object.prototype.hasOwnProperty.call(productImages, siteId)) return null;
  const filename = (productImages as Record<string, string>)[siteId];
  return { data: `./product-images/${filename}`, source: "반도스탠드 수집 이미지" };
};

const api: Api = {
  isTestWorkspace: true,
  saveProductWorkbook: (bytes) => invoke<string | null>("save_product_workbook", { bytes }),
  saveProductSyncWorkbook: (bytes) => invoke<string | null>("save_product_sync_workbook", { bytes }),
  saveFactoryWorkbook: (bytes) => invoke<string | null>("save_factory_workbook", { bytes }),
  saveStoreWorkbook: (bytes) => invoke<string | null>("save_store_workbook", { bytes }),
  saveSettlementWorkbook: (bytes) => invoke<string | null>("save_settlement_workbook", { bytes }),
  saveOrderHistoryWorkbook: (bytes) => invoke<string | null>("save_order_history_workbook", { bytes }),
  saveClientWorkbook: (bytes) => invoke<string | null>("save_client_workbook", { bytes }),
  saveRegistrationWorkbook: (kind, bytes) => invoke<string | null>("save_registration_workbook", { kind, bytes }),
  load: () => invoke<State>("state_load"),
  save: (state) => invoke<void>("state_save", { state }),
  patchSettings: (changes, expected) => invoke<State>("settings_patch", { changes, expected }),
  setPrice: (productId, variantId, tier, price, expected) =>
    invoke<State>("price_set", { productId, variantId, tier, price, expected }),
  copy: (text) => invoke<void>("clipboard_write", { text }),
  readClipboard: () => invoke<string>("clipboard_read"),
  openProduct: (url) => invoke<void>("product_open", { target: url }),
  catalogReport: () => invoke<CatalogReport>("catalog_report"),
  approveCatalog: () => invoke<{ updated: number; created: number }>("catalog_approve"),
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
  dockStart: (handle, ratio) => invoke("dock_start_native", { handle, ratio }),
  dockStop: () => invoke("dock_stop_native"),
  dockSelect: (handle) => invoke("dock_select_native", { handle }),
  dockWindows: () => invoke("dock_windows_native"),
  dockRegion: (region) => invoke("dock_region_native", { region }),
  startupMetrics: async () => notReady("시작 성능 계측"),
  retryStartup: async () => notReady("다시 시작"),
  receiptArchive: () => invoke<{ id: string; orderId: string; record: Record<string, unknown> }[]>("receipt_archive"),
  // Confirmed receipts and corrections are written atomically by state_save.
  // The old Electron secondary-write IPC is intentionally not duplicated.
  registrationTemplate: async () => notReady("상품 일괄 등록 양식 다운로드"),
  registrationPreview: async () => notReady("상품 일괄 등록 검증"),
  registrationCommit: async () => notReady("상품 일괄 등록 반영"),
  registrationResults: async () => notReady("상품 일괄 등록 결과"),
  chooseExcelDirectory: async () => (await invoke<string | null>("choose_excel_directory")) ?? undefined,
  openExcelDirectory: () => invoke<void>("open_excel_directory"),
  openExportFile: (id) => invoke<void>("open_export_file", { id }),
  exportExcel: async () => notReady("공장 엑셀 내보내기"),
  previewImport: async (url) => {
    const html = await invoke<string>("fetch_official_product_html", { target: url });
    const state = await invoke<State>("state_load");
    return parseOfficialProductPage(url, html, state);
  },
  officialList: async () => notReady("공식 홈페이지 목록 조회"),
  downloadSheet: async () => notReady("시트 다운로드"),
  previewSheet: async () => notReady("시트 업로드 검증"),
  approveSheet: async () => notReady("시트 업로드 승인"),
  mobileStart: async () => notReady("스마트폰 연동"),
  mobileStop: async () => notReady("스마트폰 연동"),
  mobileStatus: async () => ({ running: false, urls: [] }),
  inbox: async () => [],
  archiveFactoryReply: (id, bytes) => invoke<string>("archive_factory_reply", { id, bytes }),
  openFactoryFile: (id) => invoke<void>("open_factory_reply_file", { id }),
  approveFactoryConflict: (id, row, expectedRevision) =>
    invoke<void>("approve_factory_conflict", { id, row, expectedRevision }),
  testDatabasePreview: async () => ({ enabled: false as const }),
  openTestWorkspace: async () => notReady("격리 테스트 작업공간"),
  resetTestDatabase: async () => notReady("격리 테스트 초기화"),
};

if (typeof window !== "undefined") window.bando = api;
