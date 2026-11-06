/** BANDO HUB v0.0.4. Tauri-to-legacy React compatibility layer.
 * Electron IPC methods that have not been migrated fail explicitly.
 */
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { Api, State, CatalogReport } from "./types";
import productImages from "./tauri-product-images.json";

const notReady = (feature: string): never => {
  throw new Error(`${feature}: Tauri v0.0.4에서 아직 이전하지 않은 기능입니다.`);
};
const inactiveDock = { active: false, ratio: 0.8 } as const;
const appWindow = () => getCurrentWindow();
const safeImage = (siteId?: string) => {
  if (!siteId || !Object.prototype.hasOwnProperty.call(productImages, siteId)) return null;
  const filename = (productImages as Record<string, string>)[siteId];
  return { data: `./product-images/${filename}`, source: "반도스탠드 수집 이미지" };
};

const api: Api = {
  isTestWorkspace: true,
  saveProductWorkbook: (bytes) => invoke<string>("save_product_workbook", { bytes }),
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
  dockStatus: async () => ({ ...inactiveDock }),
  dockCycle: async () => notReady("카카오톡 창 도킹"),
  dockStart: async () => notReady("카카오톡 창 도킹"),
  dockStop: async () => ({ ...inactiveDock }),
  dockSelect: async () => notReady("카카오톡 창 선택"),
  dockWindows: async () => notReady("카카오톡 창 검색"),
  dockRegion: async () => {}, // There is no OS-docking window in this preview.
  startupMetrics: async () => notReady("시작 성능 계측"),
  retryStartup: async () => notReady("다시 시작"),
  receiptArchive: () => invoke<{ id: string; orderId: string; record: Record<string, unknown> }[]>("receipt_archive"),
  captureReceipt: async () => notReady("접수 원문 감사 저장"),
  recordReceiptCorrection: async () => notReady("접수 원문 정정 감사"),
  registrationTemplate: async () => notReady("상품 일괄 등록 양식 다운로드"),
  registrationPreview: async () => notReady("상품 일괄 등록 검증"),
  registrationCommit: async () => notReady("상품 일괄 등록 반영"),
  registrationResults: async () => notReady("상품 일괄 등록 결과"),
  chooseExcelDirectory: async () => notReady("엑셀 폴더 선택"),
  openExcelDirectory: async () => notReady("엑셀 폴더 열기"),
  openExportFile: async () => notReady("엑셀 출력 파일 열기"),
  exportExcel: async () => notReady("공장 엑셀 내보내기"),
  previewImport: async () => notReady("외부 상품 가져오기"),
  officialList: async () => notReady("공식 홈페이지 목록 조회"),
  downloadSheet: async () => notReady("시트 다운로드"),
  previewSheet: async () => notReady("시트 업로드 검증"),
  approveSheet: async () => notReady("시트 업로드 승인"),
  mobileStart: async () => notReady("스마트폰 연동"),
  mobileStop: async () => notReady("스마트폰 연동"),
  mobileStatus: async () => ({ running: false, urls: [] }),
  inbox: async () => [],
  openFactoryFile: async () => notReady("공장 회신 파일 열기"),
  approveFactoryConflict: async () => notReady("공장 회신 충돌 승인"),
  testDatabasePreview: async () => ({ enabled: false as const }),
  openTestWorkspace: async () => notReady("격리 테스트 작업공간"),
  resetTestDatabase: async () => notReady("격리 테스트 초기화"),
};

if (typeof window !== "undefined") window.bando = api;
