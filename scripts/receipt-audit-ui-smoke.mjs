import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { setTimeout as pause } from "node:timers/promises";
import { chromium } from "playwright";
import ExcelJS from "exceljs";
import { auditCSS } from "./audit-css-ownership.mjs";

const root = new URL("../", import.meta.url);
const state = JSON.parse(readFileSync(new URL("../src-tauri/resources/state-seed.json", import.meta.url), "utf8"));
// Synthetic audit records only. Business data in the repository is not changed.
state.settings.excelDirectory = "C:\\BANDO_CI_EXPORTS";
state.exports.push({
  id: "ci-open-export", at: "2026-11-07T05:00:00+09:00",
  filename: "BANDO-CI-EXCEL.xlsx", savedPath: "C:\\BANDO_CI_EXPORTS\\BANDO-CI-EXCEL.xlsx",
  orderIds: [], queueEntryIds: [],
});
// One synthetic STORE shipment exercises file creation followed by separate
// staff confirmation. No real order or carrier data is used.
const storeSender = {
  id: "ci-store-dealer", name: "검증악기", displayName: "검증악기",
  address: "경기도 검증시 테스트로 1", postcode: "04506",
  phone: "031-0000-0000", mobile: "", tier: "wholesale",
};
const storeRecipient = {
  id: "ci-store-recipient", name: "매장시험수취인", address: "서울 테스트구 확인로 3",
  phone: "", mobile: "010-1234-0000", note: "현관 앞",
  items: [{ id: "ci-store-item", name: "기타줄", color: "블랙", quantity: 2, origin: "STORE" }],
};
state.clients.push(storeSender);
state.orders.push({
  id: "ci-store-order", clientId: storeSender.id, orderType: "AGENCY",
  clientSnapshot: storeSender, raw: "CI 매장 출고 검증", recipients: [storeRecipient],
  createdAt: "2026-11-07T09:00:00Z", updatedAt: "2026-11-07T09:00:00Z",
});
state.workflow.sources.push({
  id: "ci-store-source", orderId: "ci-store-order", dealerId: storeSender.id,
  number: 100, raw: "CI 매장 출고", createdAt: "2026-11-07T09:00:00Z",
});
state.workflow.groups.push({
  id: "ci-store-group", rootGroupId: "ci-store-group",
  sourceId: "ci-store-source", dealerId: storeSender.id,
  createdAt: "2026-11-07T09:00:00Z", notices: [], needsNotice: false,
});
state.workflow.shipments.push({
  id: "ci-store-ship", sourceId: "ci-store-source", groupId: "ci-store-group",
  orderId: "ci-store-order", recipientId: storeRecipient.id,
  transferred: true, step: 4, charges: { STORE: 2500 }, chargeMode: "AUTO",
  freightVersion: "ci-1", infoSignature: "ci-1", completedAt: {}, sender: storeSender,
});
state.workflow.queue.push({
  id: "ci-store-queue", shipmentId: "ci-store-ship", origin: "STORE",
  status: "QUEUED", at: "2026-11-07T09:00:00Z", actor: "검증 직원",
  snapshot: {
    recipient: storeRecipient, sender: storeSender, freightCode: "010",
    total: 25000, vat: 0, subtotal: 22500, shipping: 2500,
  },
});

// Date and destination are synthetic; the mock must reflect the native
// category-first, year/month/day naming rule without touching user files.
const storePath = "C:\\BANDO_CI_EXPORTS\\매장 발송\\2026년\\11월\\07일\\20261107(매장1).xlsx";

const archive = [
  {
    id: "receipt:ui-audit-test",
    orderId: "ui-audit-test",
    record: {
      original: "709B 블랙 2개 / 원문 유지 확인",
      at: "2026-11-07T03:00:00+09:00",
      actor: "테스트 직원",
      clientId: "sample-client",
      legacy: false,
    },
  },
  {
    id: "correction:ui-correction-test",
    orderId: "ui-audit-test",
    record: {
      at: "2026-11-07T03:10:00+09:00",
      actor: "테스트 직원",
      reason: "수량 오기 정정",
      before: "709B 블랙 2개 / 원문 유지 확인",
      after: "709B 블랙 3개 / 작업용 원문",
      affectedRecipientIds: ["sample-recipient"],
    },
  },
  {
    id: "legacy:legacy-order",
    orderId: "legacy-order",
    record: {
      original: "과거 기록 참조",
      at: "2026-10-01T00:00:00+09:00",
      actor: "과거 주문 / 최초 접수 검증 불가",
      verified: false,
    },
  },
];

const server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1"], {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"],
  shell: false,
});
let serverOutput = "";
server.stdout.on("data", (chunk) => (serverOutput += chunk.toString()));
server.stderr.on("data", (chunk) => (serverOutput += chunk.toString()));
let browser;
const url = "http://127.0.0.1:5173/";
try {
  let ready = false;
  for (let i = 0; i < 80; i++) {
    if (server.exitCode !== null) throw new Error("Vite exited early: " + serverOutput);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1200) });
      if (response.ok) { ready = true; break; }
    } catch { /* server still starting */ }
    await pause(500);
  }
  assert.ok(ready, "Vite did not start: " + serverOutput);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1520, height: 1000 } });
  page.setDefaultTimeout(12000);
  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));
  await page.addInitScript(
    ({ state, archive, storePath }) => {
      let mode = "ORIGINAL";
      let auditRecords = structuredClone(archive);
      const testBackups = new Map();
      let testBackupSequence = 0;
      const response = (extra = {}) => ({
        active: mode !== "ORIGINAL", mode, ratio: 0.8,
        handle: mode !== "ORIGINAL" ? "123" : undefined, ...extra,
      });
      window.__TAURI_INTERNALS__ = {
        invoke: async (command, args) => {
          if (command === "open_export_file") {
            window.__lastOpenedExportId = args.id;
            return undefined;
          }
          if (command === "catalog_report") return {
            collectedAt: "2026-11-01T17:42:45.411Z", categories: [], failures: [],
            products: [
              { siteId: "704", name: "검증용 보면대 704",
                variants: [{ url: "https://bandostand.com/product/detail.html?product_no=704" }] },
              { siteId: "705", name: "검증용 스피커 705",
                variants: [{ url: "https://bandostand.com/product/detail.html?product_no=705" }] },
            ],
          };
          if (command === "workspace_mode") return window.__forceTestWorkspace === true;
          if (command === "startup_status") return {
            phase: "READY", error: null, attempts: 1, databaseMs: 12,
            readyMs: 18, isTest: window.__forceTestWorkspace === true,
          };
          if (command === "startup_metrics") return {
            windowShownMs: null, databaseMs: 12, dataMs: null, readyMs: 18,
          };
          if (command === "retry_startup") {
            throw Error("Healthy mock databases must not be reopened during startup");
          }
          if (command === "test_database_preview") {
            return window.__forceTestWorkspace
              ? {enabled:true, revision:state.revision ?? 0, orders:0, clients:0,
                  exports:0, shipments:0, payments:0, replies:0}
              : {enabled:false};
          }
          if (command === "test_reception_boundary") {
            return { accepted: false, reason: "주문 확인 완료 전에는 정식 주문으로 저장할 수 없습니다." };
          }
          if (command === "test_run_history") return window.__developerRuns ?? [];
          if (command === "test_record_run") {
            window.__developerRuns ??= [];
            window.__developerRuns.unshift({
              id: window.__developerRuns.length + 1, at:"2026-11-08T00:00:00+09:00",
              scenario:args.report.scenario, passed:args.report.passed, report:args.report,
            });
            return undefined;
          }
          if (command === "state_load") return structuredClone(state);
          if (command === "backup_create") {
            const name = "C:\\BANDO_TEST\\developer-test\\backups\\manual-ui-" + (++testBackupSequence) + ".sqlite";
            testBackups.set(name, { state: structuredClone(state), audit: structuredClone(auditRecords) });
            return name;
          }
          if (command === "backup_list") return [...testBackups.keys()];
          if (command === "backup_restore") {
            const entry = testBackups.get(args.filename);
            if (!entry) throw Error("The selected mock backup does not exist");
            const previousRevision = state.revision ?? 0;
            const undoState = structuredClone(state);
            const undoAudit = structuredClone(auditRecords);
            state = structuredClone(entry.state);
            state.revision = Math.max(previousRevision, state.revision ?? 0) + 1;
            auditRecords = structuredClone(entry.audit);
            const undo = "C:\\BANDO_TEST\\developer-test\\backups\\pre-restore-ui-" +
              (++testBackupSequence) + ".sqlite";
            testBackups.set(undo, { state: undoState, audit: undoAudit });
            window.__testRestoreCount = (window.__testRestoreCount ?? 0) + 1;
            return undefined;
          }
          if (command === "save_store_workbook") {
            if (!Array.isArray(args.bytes) || args.bytes.length <= 1000) throw Error("Invalid workbook bytes");
            window.__storeWorkbookSaved = args.bytes.slice(0, 4).join(",") === "80,75,3,4";
            return storePath;
          }
          if (command === "state_save") {
            const priorOrderIds = new Set(state.orders.map((order) => order.id));
            for (const order of args.state.orders) {
              if (order.confirmedAt && !priorOrderIds.has(order.id)) {
                auditRecords.push({
                  id: "receipt:" + order.id, orderId: order.id,
                  record: structuredClone(order.receipt),
                });
              }
            }
            state = structuredClone(args.state);
            state.revision = (state.revision ?? 0) + 1;
            window.__storeCommit = structuredClone(state.workflow.queue.find(
              (q) => q.id === "ci-store-queue"));
            return structuredClone(state);
          }
          if (command === "receipt_archive") return structuredClone(auditRecords);
          if (command === "capture_ocr") {
            if (window.__ocrDelayForTest) {
              await new Promise((resolve) => { window.__resolveOcrForTest = resolve; });
            }
            if (window.__ocrFailureForTest) throw Error("OCR 인식 실패 (종료 코드 0xC0000135). 필수 Windows DLL을 찾을 수 없습니다.");
            return {
            text: "709B 2개",
            imageDataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==",
            width: 1, height: 1,
            };
          }
          if (command === "choose_excel_directory") return "C:\\BANDO_CI_SELECTED";
          if (command === "open_excel_directory") return undefined;
          if (command === "dock_region_native") return undefined;
          if (command === "dock_status_native") return response();
          if (command === "dock_cycle_native") {
            if (mode === "ORIGINAL") return response({ selectionRequired: true });
            mode = mode === "OVERLAP" ? "STACK" : "ORIGINAL";
            return response();
          }
          if (command === "dock_windows_native") return [
            { handle: "123", title: "카카오톡", processId: 11, kind: "MAIN" },
            { handle: "456", title: "테스트 대화", processId: 11, kind: "CHAT" },
          ];
          if (command === "dock_select_native") { mode = "OVERLAP"; return response(); }
          throw Error("Unexpected native IPC in UI smoke test: " + command);
        },
      };
    },
    { state, archive, storePath },
  );
  await page.goto(url);
  // The OS screenshot and PaddleOCR are native. The browser verifies the
  // actual staff review flow with mocked IPC, including cancel and apply.
  const captureButton = page.getByRole("button", { name: "캡처 범위 지정" });
  await page.evaluate(() => { window.__ocrDelayForTest = true; });
  await captureButton.click();
  const ocrProgress = page.getByRole("status", { name: "OCR 진행 상태" });
  await ocrProgress.waitFor();
  await ocrProgress.getByText("OCR 처리 중…").waitFor();
  if (await captureButton.textContent() !== "캡처 범위 지정") {
    throw Error("OCR capture button label must remain unchanged while busy");
  }
  if (!(await captureButton.isDisabled())) {
    throw Error("OCR capture button must remain disabled while processing");
  }
  await page.evaluate(() => {
    window.__ocrDelayForTest = false;
    window.__resolveOcrForTest?.();
  });
  await ocrProgress.waitFor({ state: "detached" });
  let ocrReview = page.getByRole("dialog", { name: "OCR 문자 인식 검토" });
  await ocrReview.waitFor();
  await ocrReview.getByRole("button", { name: "취소" }).click();
  await ocrReview.waitFor({ state: "detached" });
  await captureButton.click();
  ocrReview = page.getByRole("dialog", { name: "OCR 문자 인식 검토" });
  await ocrReview.waitFor();
  await ocrReview.getByRole("textbox", { name: "OCR 인식 문구 편집" })
    .fill("709B 2개\\n김테스트");
  await ocrReview.getByRole("button", { name: "원문 교체" }).click();
  await ocrReview.waitFor({ state: "detached" });
  await page.waitForFunction(() =>
    document.querySelector(".source-document")?.textContent?.includes("709B 2개"));
  // At the minimum Windows layout, the three source actions must remain
  // inside the source panel instead of being clipped by the 50:50 split.
  await page.setViewportSize({ width: 1024, height: 700 });
  await page.waitForFunction(() => {
    const pane = document.querySelector(".source-pane");
    const toolbar = pane?.querySelector(".source-actions");
    return pane && toolbar && toolbar.getBoundingClientRect().height > 30;
  });
  for (const label of ["내용 삭제", "수동 분류", "AI 분석"]) {
    const control = page.locator(".source-pane .source-actions").getByRole("button", { name: label });
    await control.waitFor();
    const inside = await control.evaluate((button) => {
      const panel = button.closest(".source-pane")?.getBoundingClientRect();
      const rect = button.getBoundingClientRect();
      return !!panel && rect.height >= 25 &&
        rect.top >= panel.top && rect.bottom <= panel.bottom + 1;
    });
    assert.ok(inside, "Source action is clipped: " + label);
  }
  await page.setViewportSize({ width: 1520, height: 1000 });
  await page.evaluate(() => { window.__ocrFailureForTest = true; });
  await captureButton.click();
  const ocrFailure = page.getByRole("dialog", { name: "OCR 실행 오류" });
  await ocrFailure.waitFor();
  await ocrFailure.getByText(/0xC0000135/).waitFor();
  await ocrFailure.getByRole("button", { name: "닫기", exact: true }).click();
  await ocrFailure.waitFor({ state: "detached" });
  await page.evaluate(() => { window.__ocrFailureForTest = false; });
  await page.reload();
  const nav = page.getByRole("navigation", { name: "업무 메뉴" });
  await nav.getByRole("button", { name: "엑셀 관리" }).click();
  await page.getByRole("button", { name: "엑셀 작성 이력" }).click();
  const exportRow = page.getByRole("row").filter({ hasText: "BANDO-CI-EXCEL.xlsx" });
  await exportRow.getByRole("button", { name: "파일 열기", exact: true }).click();
  await page.waitForFunction(() => window.__lastOpenedExportId === "ci-open-export");
  await exportRow.getByRole("button", { name: "파일 경로 복사" }).waitFor();
  await nav.getByRole("button", { name: "설정" }).click();
  await page.getByRole("tab", { name: "파일 관리" }).click();
  await page.getByRole("heading", { name: "Excel 보관함 위치" }).waitFor();
  const folderHelp = page.getByRole("button", { name: "Excel 보관함 위치 도움말" });
  await folderHelp.hover();
  await page.getByRole("tooltip").getByText(
    "공장 발송, 매장 발송, 공장 회신, 상품 관리, 거래처 관리 파일을 구분하고 날짜별 폴더에 보관합니다."
  ).waitFor();
  await page.getByRole("button", { name: "보관함 폴더 선택", exact: true }).click();
  await page.getByText("C:\\BANDO_CI_SELECTED").waitFor();
  await page.getByRole("button", { name: "보관함 열기", exact: true }).click();
  await page.getByRole("tab", { name: "데이터 관리" }).click();
  const unsaved = page.getByRole("dialog", { name: "저장하지 않은 변경사항" });
  await unsaved.waitFor();
  await unsaved.getByRole("button", { name: "저장 안 함" }).click();
  await unsaved.waitFor({ state: "detached" });
  await page.getByRole("button", { name: "감사 기록 열기" }).click();
  await page.getByText("3건 조회").waitFor();
  await page.locator("summary", { hasText: "ui-audit-test" }).first().click();
  await page.getByText("709B 블랙 2개 / 원문 유지 확인", { exact: true }).first().waitFor();
  // The before / after data must appear separately under a correction detail.
  await page.locator("summary", { hasText: "원문 정정" }).click();
  await page.getByText("정정 전 작업용 원문", { exact: true }).waitFor();
  await page.getByText("정정 후 작업용 원문", { exact: true }).waitFor();
  await page.getByText("709B 블랙 3개 / 작업용 원문", { exact: true }).waitFor();
  await page.getByText("정정 사유: 수량 오기 정정", { exact: true }).waitFor();
  // Search updates the list without modifying source contents.
  await page.getByRole("textbox", { name: "접수 감사 기록 검색" }).fill("과거 기록 참조");
  await page.getByText("1건 조회").waitFor();
  await page.locator("summary", { hasText: "독립 감사 미확인" }).waitFor();
  await page.getByRole("textbox", { name: "접수 감사 기록 검색" }).fill("없는 문구");
  await page.getByText("0건 조회").waitFor();
  await page.getByText("조회 조건에 맞는 감사 기록이 없습니다.").waitFor();
  // Browser reload proves the React screen can rehydrate from a later IPC read.
  await page.reload();
  await nav.getByRole("button", { name: "설정" }).click();
  await page.getByRole("tab", { name: "데이터 관리" }).click();
  await page.getByRole("button", { name: "감사 기록 열기" }).click();
  await page.getByText("3건 조회").waitFor();
  // A separate mock-native scenario checks the full three-mode UI and picker.
  await page.reload();
  await page.getByRole("button", { name: "카카오톡 함께 보기" }).click();
  await page.getByText("연결할 카카오톡 창 선택").waitFor();
  await page.getByRole("button", { name: /카카오톡 기본 창/ }).click();
  await page.getByRole("button", { name: "카카오톡 / 겹쳐 보기" }).waitFor();
  await page.getByRole("button", { name: "카카오톡 / 겹쳐 보기" }).click();
  await page.locator(".hub-kakao-slot[hidden]").waitFor({ state: "attached" });
  await page.getByRole("button", { name: "카카오톡 / 나누어 보기" }).click();
  await page.getByRole("button", { name: "카카오톡 함께 보기" }).waitFor();
  // STORE file is a frozen Logen workbook, not proof of shipment.
  await nav.getByRole("button", { name: "엑셀 관리" }).click();
  await page.getByRole("button", { name: "매장 발송 대기" }).click();
  const queuedRow = page.getByRole("row").filter({ hasText: "매장시험수취인" });
  await queuedRow.getByRole("checkbox", { name: "엑셀 선택 매장시험수취인" }).check();
  await page.getByRole("button", { name: "선택 1건 매장 Excel 작성" }).click();
  await page.getByRole("dialog", { name: "작업 확인" })
    .getByRole("button", { name: "확인", exact: true }).click();
  await page.waitForFunction(() =>
    window.__storeWorkbookSaved === true && window.__storeCommit?.status === "EXPORTED" &&
    window.__storeCommit?.fileOnly === true);
  await page.getByRole("button", { name: "엑셀 작성 이력" }).click();
  const storeHistory = page.getByRole("row").filter({ hasText: "20261107(매장1).xlsx" });
  await storeHistory.getByRole("button", { name: "파일 경로 복사" }).waitFor();
  await storeHistory.locator("summary", { hasText: "관련 주문" }).click();
  await storeHistory.getByRole("button", { name: "매장 발송 확인" }).click();
  await page.getByRole("dialog", { name: "작업 확인" })
    .getByRole("button", { name: "확인", exact: true }).click();
  await page.waitForFunction(() => window.__storeCommit?.status === "STORE_SENT");
  // Cached product discovery must only populate the URL. No price or DB
  // update may occur until the separate live detail review is approved.
  await nav.getByRole("button", { name: "상품 관리" }).click();
  await page.getByRole("button", { name: "상품 추가" }).click();
  await page.getByRole("button", { name: "내장 수집본에서 상품 찾기" }).click();
  await page.getByText("2026년 11월 1일에 저장된 카탈로그의 상품 링크 2개입니다.", { exact: false }).waitFor();
  await page.getByRole("textbox", { name: "수집본 상품 검색" }).fill("704");
  await page.getByText("검색 결과 1개 / 최대 40개 표시").waitFor();
  await page.getByRole("button", { name: "검증용 보면대 704" }).click();
  assert.equal(await page.locator('input[placeholder^="https://bandostand.com/product/"]').inputValue(),
    "https://bandostand.com/product/detail.html?product_no=704");
  // Native process isolation is separately tested in Rust. This mock checks
  // that developer controls actually render and the shared Modal operates.
  await page.addInitScript(() => { window.__forceTestWorkspace = true; });
  await page.reload();
  await nav.getByRole("button", { name: "설정" }).click();
  await page.getByText("TEST / 격리 DB / 외부 발송 금지").waitFor();
  await page.getByRole("tab", { name: "개발자 모드" }).click();
  await page.getByRole("heading", { name: "발주서 오류 검증" }).waitFor();
  await page.getByRole("button", { name: "현재 발주서 검사" }).click();
  await page.getByRole("heading", { name: /기대 조건/ }).waitFor();
  await page.getByRole("button", { name: "Rust 저장 차단 검사" }).click();
  await page.getByRole("heading", { name: /Rust 저장 경계/ }).waitFor();
  await page.getByRole("button", { name: "선택한 실제 화면 열기" }).click();
  const modal = page.getByRole("dialog", { name: "UI 상태 시험 / 기본" });
  await modal.waitFor();
  await modal.getByRole("button", { name: "취소" }).click();
  await modal.waitFor({ state: "detached" });
  // Actual ProductSearchDialog, not only a mocked common modal title.
  await page.locator("#dev-popup").selectOption("product-search");
  await page.getByRole("button", { name: "선택한 실제 화면 열기" }).click();
  const productDialog = page.getByRole("dialog", { name: "상품 검색" });
  await productDialog.waitFor();
  await productDialog.getByRole("textbox", { name: "추가 상품 검색" }).fill("709");
  await productDialog.getByRole("button", { name: /닫기/ }).click();
  await productDialog.waitFor({ state: "detached" });
  // Exercise the real React TEST workflow through the same backup/create,
  // save and restore IPC names used by Tauri. The browser mocks IPC only;
  // native SQLite persistence and rollback are covered by Rust tests.
  await page.getByRole("heading", { name: "TEST 백업 및 복원 검증" }).waitFor();
  await page.getByRole("button", { name: "1. TEST 백업 만들기" }).click();
  await page.getByText(/검증 기준 백업:/).waitFor();
  await page.getByRole("button", { name: "2. 가상 주문과 가격 변경" }).click();
  await page.getByRole("dialog", { name: "작업 확인" })
    .getByRole("button", { name: "TEST 데이터 생성" }).click();
  await page.getByRole("heading", { name: "가상 데이터 변경 확인" }).waitFor();
  await page.getByRole("button", { name: "3. 백업 복원 및 비교" }).click();
  await page.getByRole("dialog", { name: "작업 확인" })
    .getByRole("button", { name: "TEST DB 복원" }).click();
  await page.getByRole("heading", { name: "복원 검증 통과" }).waitFor();
  await page.waitForFunction(() => window.__testRestoreCount === 1);
  await page.getByText(/TEST DB 전체 내용 및 접수 감사 기록이 백업 시점과 일치/).waitFor();
  // Account add/delete must save without a false conflict after Rust JSON reorders object keys.
  const settingsPage = await browser.newPage({ viewport: { width: 1520, height: 1000 } });
  const settingsErrors = [];
  settingsPage.on("pageerror", (err) => settingsErrors.push(err.message));
  const accountFixture = structuredClone(state);
  accountFixture.settings.accounts = [
    { bank: "검증은행A", holder: "시험A", id: "ci-account-a", number: "000-0001" },
    { bank: "검증은행B", holder: "시험B", id: "ci-account-b", number: "000-0002" },
  ];
  accountFixture.settings.brandAccounts = {
    BANDOMALL: "ci-account-b",
    BANDOSTAND: "ci-account-a",
  };
  await settingsPage.addInitScript(({ initial }) => {
    let current = structuredClone(initial);
    const normalized = (value) =>
      Array.isArray(value) ? value.map(normalized) :
      value && typeof value === "object"
        ? Object.fromEntries(Object.entries(value).sort(([left], [right]) =>
            left < right ? -1 : left > right ? 1 : 0)
          .map(([key, entry]) => [key, normalized(entry)]))
        : value;
    current = normalized(current);
    window.__TAURI_INTERNALS__ = {
      invoke: async (command, args = {}) => {
        if (command === "startup_status")
          return { phase: "READY", attempts: 1, isTest: false };
        if (command === "startup_metrics")
          return { windowShownMs: null, databaseMs: 1, dataMs: null, readyMs: 1 };
        if (command === "workspace_mode") return false;
        if (command === "state_load") return structuredClone(current);
        if (command === "dock_status_native")
          return { active: false, ratio: 0.8 };
        if (command === "settings_patch") {
          const before = current.settings;
          for (const [key, value] of Object.entries(args.changes)) {
            const equal = (a, b) => JSON.stringify(normalized(a ?? null)) === JSON.stringify(normalized(b ?? null));
            if (!equal(before[key], args.expected[key]) && !equal(before[key], value))
              throw Error("실제 저장 시 동시 변경 충돌: " + key);
          }
          current.settings = normalized({ ...current.settings, ...args.changes });
          current.revision = (current.revision ?? 0) + 1;
          window.__accountSave = { changes: structuredClone(args.changes), saved: true };
          return structuredClone(current);
        }
        throw Error("Unexpected account reproduction IPC: " + command);
      },
    };
  }, { initial: accountFixture });

  await settingsPage.goto(url);
  const settingsNav = settingsPage.getByRole("navigation", { name: "업무 메뉴" });
  await settingsNav.getByRole("button", { name: "설정" }).click();
  await settingsPage.getByRole("tab", { name: "기본 설정" }).waitFor();
  // Case A: add a third account, then successfully save it.
  await settingsPage.getByRole("button", { name: /계좌 추가/ }).click();
  await settingsPage.getByRole("textbox", { name: "은행명 3" }).fill("검증은행C");
  await settingsPage.getByRole("textbox", { name: "계좌번호 3" }).fill("000-0003");
  await settingsPage.getByRole("textbox", { name: "예금주 3" }).fill("시험C");
  await settingsPage.getByRole("button", { name: "설정 저장" }).click();
  await settingsPage.waitForFunction(() => window.__accountSave?.saved === true);
  await settingsPage.waitForFunction(() => !document.body.textContent?.includes("저장하지 않은 설정이 있습니다.") &&
    !document.body.textContent?.includes("다른 작업에서 같은 설정이 변경되었습니다."));
  assert.equal(await settingsPage.getByRole("alert").count(), 0);
  assert.equal(await settingsPage.getByRole("button", { name: "설정 저장" }).isDisabled(), false);
  const addChanges = await settingsPage.evaluate(() => window.__accountSave.changes);
  assert.equal(addChanges.accounts.length, 3);
  console.log("PASS: adding a third account saves with no false conflict");

  // Case B: reload initial saved fixture; deleting B changes accounts and
  // rebuilds brandAccounts in insertion order (Rust returns key-sorted JSON).
  await settingsPage.reload();
  await settingsNav.getByRole("button", { name: "설정" }).click();
  await settingsPage.getByRole("button", { name: "계좌 삭제 2" }).click();
  await settingsPage.getByRole("button", { name: "설정 저장" }).click();
  await settingsPage.waitForFunction(() => window.__accountSave?.saved === true);
  await settingsPage.waitForFunction(() => !document.body.textContent?.includes("저장하지 않은 설정이 있습니다.") &&
    !document.body.textContent?.includes("다른 작업에서 같은 설정이 변경되었습니다."));
  assert.equal(await settingsPage.getByRole("alert").count(), 0);
  assert.equal(await settingsPage.getByRole("button", { name: "설정 저장" }).isDisabled(), false);
  const deleteChanges = await settingsPage.evaluate(() => window.__accountSave.changes);
  assert.equal(deleteChanges.accounts.length, 1);
  console.log("PASS: deleting an account saves with no false conflict");
  // Page navigation must honor Save / Don't Save / Cancel.
  // Reload after the account persistence cases to test navigation with a settled baseline.
  await settingsPage.reload();
  await settingsNav.getByRole("button", { name: "설정" }).click();
  await settingsPage.getByRole("tab", { name: "기본 설정" }).waitFor();
  const operator = settingsPage.getByRole("textbox", { name: "작업자 이름" });
  await operator.fill("이동 테스트 담당");
  console.log("NAV_BEFORE", JSON.stringify({
    typed: await operator.inputValue(),
    dirtyCount: await settingsPage.locator(".draft-status").count(),
    dirtyText: await settingsPage.locator(".draft-status").allTextContents(),
    visibleDirty: await settingsPage.getByText("저장하지 않은 설정이 있습니다.").isVisible(),
    settingsTab: await settingsPage.getByRole("tab", { name: "기본 설정" }).getAttribute("aria-selected"),
  }));
  await settingsNav.getByRole("button", { name: "상품 관리" }).click();
  const leaveDialog = settingsPage.getByRole("dialog", { name: "변경사항 저장" });
  try {
    await leaveDialog.waitFor({ timeout: 4500 });
  } catch (error) {
    console.log("NAV_DEBUG", JSON.stringify({
      settingsText: await settingsPage.getByText("저장하지 않은 설정이 있습니다.").count(),
      notices: await settingsPage.locator(".app-notice").allTextContents(),
      dialogs: await settingsPage.locator("dialog").count(),
      productHeader: await settingsPage.getByRole("heading", { name: /상품 가격표/ }).count(),
      operator: await operator.inputValue().catch(() => "unmounted"),
    }));
    throw error;
  }
  await leaveDialog.getByRole("button", { name: "취소" }).click();
  assert.equal(await operator.inputValue(), "이동 테스트 담당");
  // Save before leaving: only the edited settings key is persisted.
  await settingsNav.getByRole("button", { name: "상품 관리" }).click();
  await leaveDialog.getByRole("button", { name: "저장", exact: true }).click();
  await settingsPage.waitForFunction(() => window.__accountSave?.changes?.operatorName === "이동 테스트 담당");
  await settingsPage.getByRole("heading", { name: /상품 가격표/ }).waitFor();
  // Discard before leaving must preserve the last committed value.
  await settingsNav.getByRole("button", { name: "설정" }).click();
  const operatorAgain = settingsPage.getByRole("textbox", { name: "작업자 이름" });
  await operatorAgain.fill("버릴 임시 작업");
  await settingsNav.getByRole("button", { name: "상품 관리" }).click();
  await leaveDialog.getByRole("button", { name: "저장 안 함" }).click();
  await settingsPage.getByRole("heading", { name: /상품 가격표/ }).waitFor();
  const savedOperator = await settingsPage.evaluate(() => window.__accountSave.changes.operatorName);
  assert.equal(savedOperator, "이동 테스트 담당");
  assert.deepEqual(settingsErrors, [], "Settings page errors: " + settingsErrors.join("\\n"));
  await settingsPage.close();
  // Real React navigation tests with isolated synthetic Tauri data. Each choice
  // is clicked in its real modal; no user data or production SQLite is touched.
  const navFixture = structuredClone(state);
  navFixture.shipping ??= {};
  navFixture.shipping.groups ??= [];
  navFixture.shipping.groups.push({
    id: "ci-ui-shipgroup", name: "검증용 배송 그룹", deletedAt: null,
    current: { version: "ci-1", at: "2026-11-01T00:00:00Z", maxBundle: 2,
      maxConfirmed: true, fees: { "1": 3000, "2": 4500 }, note: "" },
    history: [],
  });
  navFixture.brands ??= [];
  navFixture.brands.push(
    { id:"ci-brand-a", name:"CI검증브랜드A", korean:"", aliases:[], evidenceUrl:"https://example.org/ci-a" },
    { id:"ci-brand-b", name:"CI검증브랜드B", korean:"", aliases:[], evidenceUrl:"https://example.org/ci-b" },
  );
  const aliasProduct = navFixture.products.find(p => p.catalog !== "DEMO" && p.variants?.length);
  navFixture.aliases ??= [];
  navFixture.aliases.push(
    { id:"ci-alias-a", text:"CI회귀별칭A", productId:aliasProduct.id,
      variantId:aliasProduct.variants[0].id, clientId:null, actor:"CI", createdAt:"2026-11-10T00:00:00Z" },
    { id:"ci-alias-b", text:"CI회귀별칭B", productId:aliasProduct.id,
      variantId:aliasProduct.variants[0].id, clientId:null, actor:"CI", createdAt:"2026-11-10T00:00:00Z" },
  );
  const navPage = await browser.newPage({ viewport: { width: 1520, height: 1000 } });
  navPage.setDefaultTimeout(8000);
  const navErrors = [];
  navPage.on("pageerror", (err) => navErrors.push(err.message));
  await navPage.addInitScript(({ initial }) => {
    let current = structuredClone(initial);
    const saveLog = [];
    window.__navSaved = () => ({ state: structuredClone(current), saves: structuredClone(saveLog) });
    window.__injectPostSaveReadFailure = false;
    window.__nextLoadMustFail = false;
    window.__postSaveReadFaultObserved = false;
    window.__TAURI_INTERNALS__ = {
      invoke: async (command, args = {}) => {
        if (command === "startup_status")
          return { phase: "READY", attempts: 1, isTest: false };
        if (command === "startup_metrics")
          return { windowShownMs: null, databaseMs: 1, dataMs: null, readyMs: 1 };
        if (command === "workspace_mode") return false;
        if (command === "state_load") {
          if (window.__nextLoadMustFail) {
            window.__nextLoadMustFail = false;
            window.__postSaveReadFaultObserved = true;
            throw Error("Injected post-save state_load failure");
          }
          return structuredClone(current);
        }
        if (command === "dock_status_native") return { active: false, mode: "ORIGINAL", ratio: 0.8 };
        if (command === "state_save") {
          if ((args.state.revision ?? 0) !== (current.revision ?? 0))
            throw Error("Mock rejected stale revision");
          current = structuredClone(args.state);
          current.revision = (current.revision ?? 0) + 1;
          saveLog.push({type:"state_save", revision:current.revision, state:structuredClone(current)});
          if (window.__injectPostSaveReadFailure) {
            window.__nextLoadMustFail = true;
            window.__injectPostSaveReadFailure = false;
          }
          return structuredClone(current);
        }
        if (command === "settings_patch") {
          current.settings = { ...current.settings, ...args.changes };
          current.revision = (current.revision ?? 0) + 1;
          saveLog.push({type:"settings_patch", revision:current.revision, changes:structuredClone(args.changes)});
          return structuredClone(current);
        }
        if (command === "capture_ocr") return { text:"검증 발주 원문 709B 2개",
          imageDataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==",
          width:1,height:1 };
        if (command === "backup_create") return "C:\\BANDO_CI\\navigation-backup.sqlite";
        if (command === "product_image") return null;
        throw Error("Unexpected navigation-test IPC: " + command);
      },
    };
  }, {initial:navFixture});
  const auditModalLayout=async(dialog,name)=>{
    const measured=await dialog.evaluate(el=>{
      const panel=el.querySelector(":scope > .modal");
      const head=panel?.querySelector(":scope > header");
      const title=head?.querySelector("h2"),close=head?.querySelector("button");
      const fields=panel?.querySelector(".modal-fields");
      // Product and client editors intentionally scroll a nested body while
      // pinning their footer; generic modals scroll the fieldset itself.
      const scrollOwner=panel?.querySelector(".client-editor-body, .product-detail-body")??fields;
      const box=(node)=>node?.getBoundingClientRect();
      const p=box(panel),f=box(fields),h=box(head);
      return {titleSize:title?Number.parseFloat(getComputedStyle(title).fontSize):0,
        closeHeight:close?Math.round(box(close).height):0,
        panelTop:p?Math.round(p.top):-1,panelBottom:p?Math.round(p.bottom):-1,
        fieldsBottom:f?Math.round(f.bottom):-1,headerBottom:h?Math.round(h.bottom):-1,
        viewport:window.innerHeight,scroll:scrollOwner?getComputedStyle(scrollOwner).overflowY:"",
        scrollOwner:scrollOwner?.className??"",panelPadding:panel?getComputedStyle(panel).paddingLeft:"",
        width:p?Math.round(p.width):0};
    });
    assert.ok(measured.titleSize>=17 && measured.titleSize<=20,
      name+" title is not using common modal typography: "+JSON.stringify(measured));
    assert.ok(measured.closeHeight>=28 && measured.closeHeight<=36,
      name+" close control is not compact: "+JSON.stringify(measured));
    assert.ok(measured.panelTop>=0 && measured.panelBottom<=measured.viewport+1,
      name+" panel clipped by viewport: "+JSON.stringify(measured));
    assert.ok(measured.fieldsBottom<=measured.panelBottom+1,
      name+" form fields extend below modal: "+JSON.stringify(measured));
    assert.ok(measured.scroll==="auto" || measured.scroll==="scroll",
      name+" fields do not own their scroll: "+JSON.stringify(measured));
    console.log("MODAL_UI_GEOMETRY",name,JSON.stringify(measured));
  };
  const navMenu = navPage.getByRole("navigation", { name: "업무 메뉴" });
  const leave = navPage.getByRole("dialog", {name:"변경사항 저장"});
  let saveDialogCascadeSampled=false;
  const checkPrompt = async (context) => {
    await leave.waitFor();
    if(!saveDialogCascadeSampled){
      const savedInline=await navPage.evaluate(()=>{
        const root=document.documentElement;
        const previous=root.style.getPropertyValue("--kakao-reserved-width");
        root.style.setProperty("--kakao-reserved-width","320px");
        return previous;
      });
      try{
        const placement=await leave.evaluate(el=>{
          const r=el.getBoundingClientRect();
          return {center:Math.round(r.left+r.width/2),width:Math.round(r.width),
            viewport:window.innerWidth};
        });
        const expectedCenter=320+(placement.viewport-320)/2;
        assert.ok(Math.abs(placement.center-expectedCenter)<=2,
          "Decision modal disregards Kakao-reserved width: "+JSON.stringify({placement,expectedCenter}));
        console.log("PASS: decision dialog centers in app workspace excluding reserved Kakao panel",JSON.stringify(placement));
      } finally {
        await navPage.evaluate((previous)=>{
          if(previous)document.documentElement.style.setProperty("--kakao-reserved-width",previous);
          else document.documentElement.style.removeProperty("--kakao-reserved-width");
        },savedInline);
      }
      await sampleCascade("저장 확인 모달");
      saveDialogCascadeSampled=true;
    }
    for (const action of ["저장","저장 안 함","취소"])
      assert.equal(await leave.getByRole("button",{name:action,exact:true}).count(),1,
        context + " missing " + action);
    const decision=await leave.evaluate(el=>{
      const heading=el.querySelector("h2"),body=el.querySelector("p");
      const buttons=[...el.querySelectorAll(".dialog-actions button")];
      const bounds=el.getBoundingClientRect();
      return {titleFont:heading?parseFloat(getComputedStyle(heading).fontSize):0,
        bodyFont:body?parseFloat(getComputedStyle(body).fontSize):0,
        buttonHeights:buttons.map(button=>Math.round(button.getBoundingClientRect().height)),
        buttonFonts:buttons.map(button=>parseFloat(getComputedStyle(button).fontSize)),
        top:Math.round(bounds.top),bottom:Math.round(bounds.bottom),viewport:window.innerHeight};
    });
    assert.equal(decision.titleFont,18,"Decision title must match edit-modal title: "+JSON.stringify(decision));
    assert.equal(decision.bodyFont,13,"Decision body should use shared 13px text: "+JSON.stringify(decision));
    assert.ok(decision.buttonHeights.every(height=>height>=30 && height<=40),
      "Decision action button dimensions differ: "+JSON.stringify(decision));
    assert.ok(decision.top>=0&&decision.bottom<=decision.viewport,
      "Decision dialog extends beyond viewport: "+JSON.stringify(decision));
  };
  const mockState = () => navPage.evaluate(() => window.__navSaved());
  // UI contract audit at desktop width: all primary headings and search controls
  // must share the same dimensions, font, border and placement.
  await navPage.goto(url);
  // No-order receipt placeholder must not regress to 12px centred legacy text.
  const receiptEmpty=navPage.locator(".receipt-panel-content > .detail-empty").first();
  await receiptEmpty.waitFor();
  const receiptEmptyStyle=await receiptEmpty.evaluate(element=>{
    const style=getComputedStyle(element),rect=element.getBoundingClientRect();
    return {font:parseFloat(style.fontSize),align:style.textAlign,
      color:style.color,height:Math.round(rect.height),text:(element.textContent??"").trim()};
  });
  assert.equal(receiptEmptyStyle.align,"left",
    "Receipt placeholder must align with ordinary content: "+JSON.stringify(receiptEmptyStyle));
  assert.ok(receiptEmptyStyle.font >= 13 && receiptEmptyStyle.font <= 15,
    "Receipt placeholder should not use superseded 12px font: "+JSON.stringify(receiptEmptyStyle));
  console.log("PASS: receipt detail placeholder uses readable left-aligned empty state",JSON.stringify(receiptEmptyStyle));
  const layoutSamples=[];
  const styleProbe=[];
  const cascadeSources=auditCSS().crossFileConflicts.map(([key,records])=>({
    key,selector:records[0].selector,property:records[0].property,
    context:records[0].context,files:records.map(record=>record.path),
    values:records.map(record=>record.value),
  }));
  const cascadeSeen=new Map();
  const sampleCascade = async (screen) => {
    const matched=await navPage.evaluate((candidates) => {
      const activeContext=(context)=>{
        if(context==="base")return true;
        return context.split(" / ").every(rule=>{
          if(rule.startsWith("@media "))return window.matchMedia(rule.slice(7).trim()).matches;
          if(rule.startsWith("@supports "))return CSS.supports(rule.slice(10).trim());
          return false;
        });
      };
      const findings=[];
      for(const candidate of candidates){
        if(!activeContext(candidate.context))continue;
        try{
          // querySelectorAll cannot select pseudo-elements; resolve their owning
          // DOM element and ask getComputedStyle for the pseudo-element directly.
          const match=candidate.selector.match(/(::[a-z-]+)$/);
          const pseudo=match?.[1]??null;
          const selector=pseudo ? candidate.selector.slice(0,-pseudo.length) : candidate.selector;
          const elements=[...document.querySelectorAll(selector)].filter(element=>{
            const style=getComputedStyle(element);
            return style.display!=="none" && element.getBoundingClientRect().width>0;
          });
          if(!elements.length)continue;
          findings.push({key:candidate.key,count:elements.length,
            actual:(pseudo ? getComputedStyle(elements[0],pseudo) : getComputedStyle(elements[0]))
              .getPropertyValue(candidate.property).trim(),
            example:elements[0].tagName.toLowerCase()+
              (typeof elements[0].className==="string" ? "."+elements[0].className.trim().replace(/\s+/g,".").slice(0,100) : "")+(pseudo??"")});
        }catch{
          findings.push({key:candidate.key,unsupportedSelector:true});
        }
      }
      return findings;
    }, cascadeSources);
    for(const row of matched){
      const current=cascadeSeen.get(row.key)||{screens:new Set(),count:0,actual:new Set(),example:row.example??""};
      current.screens.add(screen);
      current.count=Math.max(current.count,row.count||0);
      if(row.actual)current.actual.add(row.actual);
      if(row.unsupportedSelector)current.unsupportedSelector=true;
      cascadeSeen.set(row.key,current);
    }
  };
  const samplePageStyle = async (name) => {
    const metrics = await navPage.locator(".management-container").evaluate((root) => {
      const capture = (query, limit=4) => [...root.querySelectorAll(query)].filter((element)=>{
        const style=getComputedStyle(element);
        return style.display!=="none" && element.getBoundingClientRect().width>0;
      }).slice(0,limit).map((element)=>{
        const css=getComputedStyle(element),box=element.getBoundingClientRect();
        return {tag:element.tagName.toLowerCase(),className:typeof element.className==="string"?element.className.slice(0,100):"",
          text:(element.textContent??"").trim().replace(/\\s+/g," ").slice(0,45),
          font:css.fontSize,line:css.lineHeight,height:Math.round(box.height),
          paddingY:css.paddingTop+"/"+css.paddingBottom,
          marginY:css.marginTop+"/"+css.marginBottom,
          color:css.color,background:css.backgroundColor,
          overflow:css.overflow,wrap:css.whiteSpace};
      });
      return {headings:capture(".page-heading h1"),subheadings:capture("h2",2),
        fields:capture(".field > .field-label, .field > label",3),
        buttons:capture(".page-heading button, .management-search-toolbar > button",4),
        inputs:capture(".management-search-field input, .field input",3),
        tableCells:capture("table.management-data-table tbody td",3),
        empties:capture(".empty-state, .detail-empty, .empty",3)};
    });
    styleProbe.push({name,...metrics});
    await sampleCascade(name);
  };
  await sampleCascade("접수 / 기본 화면");
  const views=[
    ["주문 내역","주문 검색"],
    ["엑셀 관리","엑셀 목록 검색"],
    ["일일 결산",null],
    ["상품 관리","상품 검색"],
    ["운임 관리","상품별 운임 검색"],
    ["거래처 관리","거래처 관리 검색"],
    ["설정",null],
  ];
  for(const [label,searchLabel] of views){
    await navMenu.getByRole("button",{name:label,exact:true}).click();
    const heading=navPage.locator(".management-container .page-heading h1").first();
    await heading.waitFor();
    const metrics=await heading.evaluate((h)=>{
      const style=getComputedStyle(h),rect=h.getBoundingClientRect();
      const parent=document.querySelector(".management-container");
      return {text:h.textContent?.trim(),size:style.fontSize,left:Math.round(rect.left),
        relativeLeft:Math.round(rect.left-(parent?.getBoundingClientRect().left??0))};
    });
    assert.equal(metrics.text,label,"Wrong title on "+label);
    assert.ok(Math.abs(Number.parseFloat(metrics.size)-20)<2,"Inconsistent title font: "+JSON.stringify(metrics));
    await samplePageStyle(label);
    if(label==="설정"){
      const settingSections=await navPage.locator(".settings > div:not([hidden]) .settings-help-heading")
        .evaluateAll((headings)=>headings.map(h=>{
          const style=getComputedStyle(h);
          return {text:h.textContent?.trim().slice(0,28),
            marginTop:parseFloat(style.marginTop),marginBottom:parseFloat(style.marginBottom)};
        }));
      assert.ok(settingSections.length>=2,
        "Settings heading audit did not find the section hierarchy");
      assert.ok(settingSections.every(h=>h.marginTop<=16),
        "Legacy settings heading gap exceeds standard rhythm: "+JSON.stringify(settingSections));
      console.log("PASS: settings section headings use shared compact spacing",JSON.stringify(settingSections));
    }
    if(searchLabel){
      const input=navPage.getByRole("textbox",{name:searchLabel,exact:true});
      const search=await input.evaluate((element)=>{
        const inputStyle=getComputedStyle(element);
        const field=element.closest(".management-search-field");
        const rect=element.getBoundingClientRect();
        return {height:Math.round(rect.height),width:Math.round(rect.width),
          background:inputStyle.backgroundColor,round:inputStyle.borderRadius,
          font:inputStyle.fontSize,paddingLeft:inputStyle.paddingLeft,
          tool:!!field,icon:!!field?.querySelector(".management-search-icon")};
      });
      assert.ok(search.tool && search.icon,"Shared search missing on "+label);
      assert.ok(search.width>=180,"Unexpectedly narrow search: "+JSON.stringify(search));
      layoutSamples.push({label,search,heading:metrics});
    }else layoutSamples.push({label,heading:metrics});
  }
  // Child-tab samples use the same real browser and keep the draft state untouched.
  // Their computed metrics reveal overrides hidden by top-level-only snapshots.
  await navMenu.getByRole("button",{name:"상품 관리"}).click();
  for(const label of ["상품 목록","카테고리 관리","대표색상 관리","별칭 관리","브랜드 관리"]){
    await navPage.getByRole("navigation",{name:"상품 관리 메뉴"}).getByRole("button",{name:label,exact:true}).click();
    await samplePageStyle("상품 관리 / "+label);
    if(label==="별칭 관리" || label==="브랜드 관리"){
      const rootSelector=label==="별칭 관리" ? ".alias-manager" : ".registry-brand-manager";
      const titleLayout=await navPage.locator(rootSelector).evaluate(root=>{
        const h2=root.querySelector(":scope > h2"),intro=root.querySelector(":scope > p");
        const hs=h2?getComputedStyle(h2):null,ps=intro?getComputedStyle(intro):null;
        return {title: h2?.textContent?.trim(),bottom:hs?parseFloat(hs.marginBottom):-1,
          introTop:ps?parseFloat(ps.marginTop):-1};
      });
      assert.equal(titleLayout.bottom,0,
        "Legacy card heading has excessive spacing: "+JSON.stringify(titleLayout));
      assert.ok(titleLayout.introTop>=0 && titleLayout.introTop<=8,
        "Registry introduction spacing differs from management hierarchy: "+JSON.stringify(titleLayout));
      console.log("PASS: registry heading and introduction rhythm",label,JSON.stringify(titleLayout));
    }
  }
  await navMenu.getByRole("button",{name:"운임 관리"}).click();
  for(const label of ["상품별 기본 운임","동급 배송 그룹 지정","동급 그룹 운임표","조합 / 기준 이력"]){
    await navPage.getByRole("button",{name:label,exact:true}).click();
    await samplePageStyle("운임 관리 / "+label);
    if(label==="동급 그룹 운임표"){
      const rateRow=await navPage.locator(".shipping-rates table.management-data-table tbody tr").first().evaluate(row=>{
        const cell=row.querySelector("td"),button=row.querySelector(".ui-button");
        return {height:Math.round(row.getBoundingClientRect().height),
          paddingTop:cell?parseFloat(getComputedStyle(cell).paddingTop):-1,
          paddingBottom:cell?parseFloat(getComputedStyle(cell).paddingBottom):-1,
          buttonHeight:button?Math.round(button.getBoundingClientRect().height):-1};
      });
      assert.ok(rateRow.paddingTop<=3.1 && rateRow.paddingBottom<=3.1,
        "Freight rate cells should use compact shared table spacing: "+JSON.stringify(rateRow));
      assert.ok(rateRow.height<=41,
        "Freight rate row is taller than other management table rows: "+JSON.stringify(rateRow));
      console.log("PASS: freight rate table compact computed row geometry",JSON.stringify(rateRow));
    }
  }
  await navMenu.getByRole("button",{name:"엑셀 관리"}).click();
  for(const label of ["공장 엑셀 대기","매장 발송 대기","엑셀 작성 이력"]){
    await navPage.getByRole("button",{name:label,exact:true}).click();
    await samplePageStyle("엑셀 관리 / "+label);
  }
  await navMenu.getByRole("button",{name:"거래처 관리"}).click();
  for(const label of ["거래처 목록","자동 메시지 편집"]){
    await navPage.getByRole("button",{name:label,exact:true}).click();
    await samplePageStyle("거래처 관리 / "+label);
  }
  const searches=layoutSamples.filter(x=>x.search).map(x=>x.search);
  for(const current of searches.slice(1)){
    for(const property of ["height","background","round","font","paddingLeft"])
      assert.equal(current[property],searches[0][property],
        "Management search "+property+" differs from freight reference: "+JSON.stringify(layoutSamples));
  }
  const titlePositions=layoutSamples.map(x=>x.heading.relativeLeft);
  assert.ok(Math.max(...titlePositions)-Math.min(...titlePositions)<=2,
    "Heading x origin inconsistent across pages: "+JSON.stringify(layoutSamples));
  // Full-HD layout contract: the shell and page are height-bounded and the
  // data table or tab panel owns scrolling. X overflow remains allowed for
  // the reserved Kakao pane and wide record columns.
  await navPage.setViewportSize({width:1920,height:1080});
  const measureFrame=async(label,innerSelector)=>{
    const m=await navPage.evaluate((innerSelector)=>{
      const sel=(s)=>document.querySelector(s);
      const outer=sel(".hub-shell-scroll"),root=sel(".hub-main-content > .management-container"),inner=sel(innerSelector);
      if(!outer||!root||!inner)return {missing:{outer:!!outer,root:!!root,inner:!!inner}};
      const rect=(e)=>e.getBoundingClientRect();
      const rootBox=rect(root),innerBox=rect(inner);
      return {outerHeight:outer.clientHeight,outerScrollHeight:outer.scrollHeight,
        rootHeight:root.clientHeight,rootScrollHeight:root.scrollHeight,
        rootBottom:Math.round(rootBox.bottom),innerBottom:Math.round(innerBox.bottom),
        innerScroll:inner.scrollHeight,innerHeight:inner.clientHeight,
        bodyScroll:document.scrollingElement?.scrollHeight??0,viewport:innerHeightForTest()};
      function innerHeightForTest(){return window.innerHeight}
    },innerSelector);
    assert.ok(!m.missing,"Required workspace missing in "+label+": "+JSON.stringify(m));
    assert.ok(m.outerScrollHeight<=m.outerHeight+2,
      label+" outer shell has unnecessary vertical scrollbar: "+JSON.stringify(m));
    assert.ok(m.rootScrollHeight<=m.rootHeight+2,
      label+" management page overflows viewport: "+JSON.stringify(m));
    assert.ok(m.innerBottom<=m.rootBottom+2,
      label+" internal workspace extends beyond page frame: "+JSON.stringify(m));
    assert.ok(m.bodyScroll<=m.viewport+2,
      label+" document itself scrolls vertically: "+JSON.stringify(m));
    return m;
  };
  const fullHD=[];
  const checkFullHD=async(menu,selector)=>{
    await navMenu.getByRole("button",{name:menu,exact:true}).click();
    fullHD.push({menu,...await measureFrame(menu,selector)});
  };
  await checkFullHD("상품 관리",".product-list-workspace .price-table-scroll");
  const productNamePx=await navPage.locator(".product-prices .product-title-line b").first()
    .evaluate(el=>Number.parseFloat(getComputedStyle(el).fontSize));
  await checkFullHD("운임 관리",".shipping-product-list .shipping-table-scroll");
  const freightNamePx=await navPage.locator(".shipping-product-list .shipping-product-name > strong").first()
    .evaluate(el=>Number.parseFloat(getComputedStyle(el).fontSize));
  assert.equal(productNamePx,13,"Product manager list name must be 13px");
  assert.equal(freightNamePx,13,"Freight manager list name must be 13px");
  assert.equal(await navPage.locator(".shipping-explanation-footer").count(),0,
    "Unrelated bundle freight help footer must not occupy the list bottom");
  await navPage.getByRole("button",{name:"동급 배송 그룹 지정",exact:true}).click();
  fullHD.push({menu:"운임 관리 / 동급 배송 그룹 지정",...await measureFrame("배송 그룹 지정",".shipping-assignment-list .shipping-table-scroll")});
  await checkFullHD("거래처 관리",".management-scroll");
  const clientWidths=await navPage.locator(".client-table").evaluate(table=>{
    const heads=[...table.querySelectorAll("thead th")],cells=[...table.querySelectorAll("tbody tr:first-child td")];
    return {layout:getComputedStyle(table).tableLayout,headers:heads.map(x=>[Math.round(x.getBoundingClientRect().left),Math.round(x.getBoundingClientRect().width)]),
      data:cells.map(x=>[Math.round(x.getBoundingClientRect().left),Math.round(x.getBoundingClientRect().width)])};
  });
  assert.equal(clientWidths.layout,"fixed","Client table layout must be fixed");
  assert.deepEqual(clientWidths.headers,clientWidths.data,
    "Client header columns and data cells have different widths: "+JSON.stringify(clientWidths));
  await checkFullHD("설정",".settings-tab-panels");
  const settingsColumns=await navPage.locator(".settings-basic-top-grid").evaluate(grid=>{
    const sections=[...grid.children].map(el=>el.getBoundingClientRect());
    const sender=[...document.querySelectorAll(".settings-sender-grid > div")].map(el=>el.getBoundingClientRect());
    return {columns:sections.length,distinctXs:new Set(sections.map(r=>Math.round(r.left))).size,
      senderCount:sender.length,senderRowY:sender.map(r=>Math.round(r.top))};
  });
  assert.equal(settingsColumns.columns,2);
  assert.equal(settingsColumns.distinctXs,2,
    "Short basic settings fields should use two columns at 1080p");
  assert.equal(settingsColumns.senderCount,5);
  await checkFullHD("엑셀 관리",".excel-table-scroll");
  await checkFullHD("일일 결산",".daily-settlement");
  await checkFullHD("주문 내역",".order-history-list");
  console.log("FULL_HD_LAYOUT",JSON.stringify({fullHD,settingsColumns,clientWidths,productNamePx,freightNamePx}));
  await navPage.setViewportSize({width:1520,height:1000});
  console.log("PASS: 1080p navigation frames, scrolling ownership and client columns are consistent");

  console.log("PASS: 7 management titles and 5 shared search layouts are consistent");
  console.log("MANAGEMENT_STYLE_PROBE",JSON.stringify(styleProbe));
  // Shared tables must retain their native semantics and compress empty results
  // without leaving an oversized scroller behind. This uses the real React UI.
  const checkCompactEmpty = async (selector, label) => {
    const metrics = await navPage.locator(selector).evaluate((empty) => {
      const rect = empty.getBoundingClientRect();
      const style = getComputedStyle(empty);
      return {height:Math.round(rect.height),align:style.textAlign,
        font:parseFloat(style.fontSize),padding:parseFloat(style.paddingTop)};
    });
    assert.ok(metrics.height > 20 && metrics.height <= 80,
      label + " unexpectedly tall: " + JSON.stringify(metrics));
    assert.equal(metrics.align,"left",label + " must align list status left");
    assert.ok(metrics.font >= 12 && metrics.font <= 15,
      label + " uses an inconsistent type size: " + JSON.stringify(metrics));
  };

  await navMenu.getByRole("button",{name:"상품 관리"}).click();
  await navPage.getByRole("textbox",{name:"상품 검색"}).fill("__CI_EMPTY_PRODUCT__");
  assert.equal(await navPage.locator(".product-prices table.management-data-table").count(),1);
  await checkCompactEmpty(".product-prices .empty-state-compact","product");
  await navPage.getByRole("textbox",{name:"상품 검색"}).fill("");

  await navMenu.getByRole("button",{name:"거래처 관리"}).click();
  await navPage.getByRole("textbox",{name:"거래처 관리 검색"}).fill("__CI_EMPTY_CLIENT__");
  assert.equal(await navPage.locator(".client-table.management-data-table").count(),1);
  await checkCompactEmpty(".client-table + .empty-state-compact","client");
  await navPage.getByRole("textbox",{name:"거래처 관리 검색"}).fill("");

  await navMenu.getByRole("button",{name:"주문 내역"}).click();
  await navPage.getByRole("textbox",{name:"주문 검색"}).fill("__CI_EMPTY_ORDER__");
  assert.equal(await navPage.locator(".order-history-list table.management-data-table").count(),1);
  await checkCompactEmpty(".order-history-list > .empty-state-compact","order history");
  await navPage.getByRole("textbox",{name:"주문 검색"}).fill("");

  await navMenu.getByRole("button",{name:"운임 관리"}).click();
  await navPage.getByRole("button",{name:"동급 배송 그룹 지정"}).click();
  await navPage.getByRole("textbox",{name:"배송 그룹 상품 검색"}).fill("__CI_EMPTY_FREIGHT__");
  const freightEmpty=navPage.locator(".shipping-table-scroll.shipping-list-empty");
  await freightEmpty.waitFor();
  assert.ok(await freightEmpty.evaluate(el=>el.getBoundingClientRect().height)<=130,
    "Empty freight table still reserves excessive vertical space");
  await checkCompactEmpty(".shipping-table-scroll .empty-state-compact","freight");
  await navPage.getByRole("textbox",{name:"배송 그룹 상품 검색"}).fill("");
  const freightRowSize=await navPage.locator(".shipping-assignment-list .shipping-table-scroll tbody tr").first().evaluate(row=>{
    const select=row.querySelector("select");
    return {height:row.getBoundingClientRect().height,
      selectHeight:select?.getBoundingClientRect().height??0};
  });
  assert.ok(freightRowSize.height <= 45 && freightRowSize.selectHeight <= 34,
    "Freight assignment table should match compact row controls: " + JSON.stringify(freightRowSize));

  await navPage.getByRole("button",{name:"상품별 기본 운임"}).click();
  await navPage.getByRole("textbox",{name:"상품별 운임 검색"}).fill("__CI_EMPTY_BASE_FREIGHT__");
  const baseFreightEmpty=navPage.locator(".shipping-product-list .shipping-table-scroll.shipping-list-empty");
  await baseFreightEmpty.waitFor();
  assert.ok(await baseFreightEmpty.evaluate(el=>el.getBoundingClientRect().height) <= 150,
    "Base freight empty table still reserves excessive vertical space");
  await checkCompactEmpty(".shipping-product-list .empty-state-compact","base freight");
  await navPage.getByRole("textbox",{name:"상품별 운임 검색"}).fill("");

  await navMenu.getByRole("button",{name:"엑셀 관리"}).click();
  await navPage.getByRole("button",{name:"엑셀 작성 이력"}).click();
  await navPage.getByRole("textbox",{name:"엑셀 목록 검색"}).fill("__CI_EMPTY_EXCEL__");
  const excelEmpty=navPage.locator(".excel-table-scroll.excel-list-empty");
  await excelEmpty.waitFor();
  assert.ok(await excelEmpty.evaluate(el=>el.getBoundingClientRect().height)<=320,
    "Excel table/response history reserves excessive space with zero results");
  assert.equal(await navPage.locator(".factory-reply-data-table").count(),0);
  await checkCompactEmpty(".excel-table-scroll > .empty-state-compact","Excel export");
  await checkCompactEmpty(".factory-reply-history .empty-state-compact","factory reply history");
  await navPage.setViewportSize({width:1120,height:800});
  await checkCompactEmpty(".excel-table-scroll > .empty-state-compact","Excel at narrow viewport");
  await navPage.setViewportSize({width:1520,height:1000});
  await navPage.getByRole("textbox",{name:"엑셀 목록 검색"}).fill("");
  console.log("PASS: native management tables and compact empty states across six screens");

  // Excel: a small caption must not take its own line while ample width remains.
  await navMenu.getByRole("button",{name:"엑셀 관리"}).click();
  await navPage.getByRole("button",{name:"매장 발송 대기"}).click();
  const excelRow=navPage.locator(".excel-table-scroll .excel-queue-table tbody tr").filter({hasText:"매장시험수취인"}).first();
  await excelRow.waitFor();
  const excelLayout=await excelRow.evaluate((row)=>{
    const table=row.closest("table"),middle=row.querySelector("td:nth-child(3)");
    const caption=middle?.querySelector("small"),details=row.querySelector("details:not([open])");
    return {tableWidth:Math.round(table?.getBoundingClientRect().width??0),
      captionDisplay:caption?getComputedStyle(caption).display:null,
      captionMargin:caption?getComputedStyle(caption).marginTop:null,
      detailsDisplay:details?getComputedStyle(details).display:null,
      rowHeight:Math.round(row.getBoundingClientRect().height),
      cellTop:row.querySelector("td") ? parseFloat(getComputedStyle(row.querySelector("td")).paddingTop) : -1,
      cellBottom:row.querySelector("td") ? parseFloat(getComputedStyle(row.querySelector("td")).paddingBottom) : -1};
  });
  assert.equal(excelLayout.captionDisplay,"inline",JSON.stringify(excelLayout));
  assert.ok(excelLayout.rowHeight<=39,
    "Excel test row is unnecessarily tall at available width: "+JSON.stringify(excelLayout));
  assert.ok(excelLayout.cellTop<=3.1 && excelLayout.cellBottom<=3.1,
    "Excel table uses superseded 6px cell padding: "+JSON.stringify(excelLayout));
  console.log("PASS: Excel table uses compact rows and preserves inline information",JSON.stringify(excelLayout));
  await navMenu.getByRole("button",{name:"거래처 관리"}).click();
  // Client: Cancel keeps the draft, Discard keeps DB unchanged, Save persists it.
  await navPage.locator(".client-table tbody tr").filter({hasText:"검증악기"}).first().click();
  const clientModal = navPage.getByRole("dialog",{name:"거래처 상세 관리"});
  await auditModalLayout(clientModal,"거래처 상세 관리");
  await sampleCascade("거래처 상세 관리 모달");
  const clientAddress = clientModal.getByRole("textbox",{name:"거래처 주소"});
  const originalAddress = await clientAddress.inputValue();
  await clientAddress.fill("경기도 검증시 저장확인로 88");
  await clientModal.getByRole("button",{name:"취소",exact:true}).click();
  await checkPrompt("client");
  assert.equal(await clientModal.evaluate((dialog) => dialog.open), true,
    "The edited client must stay open underneath the unsaved-changes dialog");
  await leave.getByRole("button",{name:"취소",exact:true}).click();
  assert.equal(await clientAddress.inputValue(),"경기도 검증시 저장확인로 88");
  await clientModal.getByRole("button",{name:"취소",exact:true}).click();
  await leave.getByRole("button",{name:"저장 안 함"}).click();
  await clientModal.waitFor({state:"detached"});
  assert.equal((await mockState()).state.clients.find(c=>c.id==="ci-store-dealer").address,originalAddress);
  await navPage.locator(".client-table tbody tr").filter({hasText:"검증악기"}).first().click();
  await navPage.evaluate(() => { window.__injectPostSaveReadFailure = true; });
  await clientAddress.fill("경기도 검증시 저장확인로 89");
  await clientModal.getByRole("button",{name:"취소",exact:true}).click();
  await leave.getByRole("button",{name:"저장",exact:true}).click();
  await clientModal.waitFor({state:"detached"});
  assert.equal((await mockState()).state.clients.find(c=>c.id==="ci-store-dealer").address,"경기도 검증시 저장확인로 89");
  // Background refresh may consume the injected read failure after save.
  // The committed address remains authoritative and visible either way.
  assert.equal(await navPage.evaluate(
    () => window.__nextLoadMustFail || window.__postSaveReadFaultObserved
  ), true);
  await navPage.evaluate(() => { window.__nextLoadMustFail = false; });
  await navPage.locator(".client-table tbody tr").filter({hasText:"검증악기"}).first().click();
  assert.equal(await clientAddress.inputValue(),"경기도 검증시 저장확인로 89");
  await clientModal.getByRole("button",{name:"취소",exact:true}).click();
  await clientModal.waitFor({state:"detached"});
  console.log("PASS: committed client state displays without a post-save SQLite read");

  // Product: the existing product editor has the same three-choice leave guard.
  await navMenu.getByRole("button",{name:"상품 관리"}).click();
  // Mouse help opens only after 500ms, is excluded from Tab order,
  // and stays pinned until the next unrelated pointer or keyboard action.
  const productHelp = navPage.getByRole("button", { name: "상품 가격 수정 도움말" });
  const visibleHelp = navPage.locator(".help-tooltip-panel:popover-open");
  assert.equal(await productHelp.getAttribute("tabindex"), "-1");
  await productHelp.hover();
  await navPage.waitForTimeout(220);
  await navPage.mouse.move(4, 4);
  await navPage.waitForTimeout(370);
  assert.equal(await visibleHelp.count(), 0, "Hover below 500ms must not open help");
  await productHelp.hover();
  await navPage.waitForTimeout(260);
  assert.equal(await visibleHelp.count(), 0, "Help opened before 500ms");
  await visibleHelp.waitFor({state:"visible",timeout:2000});
  await productHelp.click();
  await navPage.mouse.move(4, 4);
  await navPage.waitForTimeout(240);
  assert.equal(await visibleHelp.count(), 1, "Clicked help must stay pinned on mouse leave");
  await navPage.keyboard.press("Tab");
  assert.equal(await visibleHelp.count(), 0, "Keyboard action must dismiss pinned help");
  assert.equal(await navPage.evaluate(() => document.activeElement?.classList.contains("help-tooltip-trigger")), false);
  await productHelp.click();
  assert.equal(await visibleHelp.count(), 1);
  await navPage.getByRole("textbox", { name: "상품 검색" }).click();
  assert.equal(await visibleHelp.count(), 0, "Clicking another control must dismiss pinned help");
  console.log("PASS: help tooltip mouse-only focus, delayed hover and click-to-pin");

  const productRows=navPage.locator(".product-prices tbody tr");
  await productRows.first().waitFor();
  const productDensity = await productRows.first().evaluate((row) => {
    const cell = row.querySelector("td");
    const price = row.querySelector("input[data-price-cell]");
    const button = row.querySelector("button");
    const cellStyle = cell ? getComputedStyle(cell) : null;
    return {
      row: row.getBoundingClientRect().height,
      cellTop: cellStyle ? parseFloat(cellStyle.paddingTop) : -1,
      cellBottom: cellStyle ? parseFloat(cellStyle.paddingBottom) : -1,
      price: price ? price.getBoundingClientRect().height : -1,
      priceWidth: price ? Math.round(price.getBoundingClientRect().width) : -1,
      priceParentWidth: price?.parentElement ? Math.round(price.parentElement.getBoundingClientRect().width) : -1,
      priceFont: price ? Number.parseFloat(getComputedStyle(price).fontSize) : -1,
      button: button ? button.getBoundingClientRect().height : -1,
    };
  });
  assert.ok(productDensity.row >= 30 && productDensity.row <= 38,
    "상품관리 상품 행이 지나치게 높음: " + JSON.stringify(productDensity));
  assert.ok(productDensity.cellTop <= 4 && productDensity.cellBottom <= 4,
    "상품관리 셀 상하 여백이 지나치게 큼: " + JSON.stringify(productDensity));
  assert.ok(productDensity.price <= 29 && productDensity.button <= 29,
    "상품관리 가격 입력창과 상세 버튼 높이가 불일치: " + JSON.stringify(productDensity));
  assert.ok(productDensity.priceWidth > 0 &&
    productDensity.priceWidth <= productDensity.priceParentWidth + 1,
    "가격 입력창의 구형 고정 폭이 셀을 넘어서 적용됨: " + JSON.stringify(productDensity));
  assert.ok(productDensity.priceFont >= 11 && productDensity.priceFont <= 14,
    "가격 입력창에 구형 큰 글씨가 적용됨: " + JSON.stringify(productDensity));
  console.log("PASS: product pricing rows and aligned action controls are compact");
  await productRows.first().getByRole("button",{name:"상세 관리"}).click();
  const productModal=navPage.getByRole("dialog",{name:"상품 상세 관리"});
  await auditModalLayout(productModal,"상품 상세 관리");
  await sampleCascade("상품 상세 관리 모달");
  const description=productModal.getByRole("textbox",{name:"상품설명"});
  const firstProductId=await navPage.evaluate(() => window.__navSaved().state.products[0].id);
  const beforeProduct=await mockState();
  await description.fill("상품설명 미저장 취소 검사");
  await productModal.getByRole("button",{name:"취소",exact:true}).click();
  await checkPrompt("product");
  await leave.getByRole("button",{name:"취소",exact:true}).click();
  assert.equal(await description.inputValue(),"상품설명 미저장 취소 검사");
  await productModal.getByRole("button",{name:"취소",exact:true}).click();
  await leave.getByRole("button",{name:"저장 안 함"}).click();
  await productModal.waitFor({state:"detached"});
  assert.equal((await mockState()).saves.length,beforeProduct.saves.length);
  await productRows.first().getByRole("button",{name:"상세 관리"}).click();
  await description.fill("상품설명 저장 완료 검사");
  await productModal.getByRole("button",{name:"취소",exact:true}).click();
  await leave.getByRole("button",{name:"저장",exact:true}).click();
  await productModal.waitFor({state:"detached"});
  const productAfter=await mockState();
  assert.equal(productAfter.saves.length,beforeProduct.saves.length+1);
  assert.ok(productAfter.state.products.some(p=>p.subtitle==="상품설명 저장 완료 검사"));
  console.log("PASS: product detail Save / Discard / Cancel (actual React modal)");

  // The freight list should have the same dense vertical rhythm as product pricing.
  await navMenu.getByRole("button",{name:"운임 관리"}).click();
  const freightRows = navPage.locator(".shipping-product-list .shipping-table-scroll tbody tr");
  await freightRows.first().waitFor();
  const freightDensity = await freightRows.first().evaluate((row) => {
    const cell = row.querySelector("td");
    const button = row.querySelector("button");
    const cellStyle = cell ? getComputedStyle(cell) : null;
    return {
      row: row.getBoundingClientRect().height,
      cellTop: cellStyle ? parseFloat(cellStyle.paddingTop) : -1,
      cellBottom: cellStyle ? parseFloat(cellStyle.paddingBottom) : -1,
      button: button ? button.getBoundingClientRect().height : -1,
    };
  });
  assert.ok(freightDensity.row >= 30 && freightDensity.row <= 38,
    "운임관리 상품 행이 지나치게 높음: " + JSON.stringify(freightDensity));
  assert.ok(freightDensity.cellTop <= 4 && freightDensity.cellBottom <= 4,
    "운임관리 셀 상하 여백이 지나치게 큼: " + JSON.stringify(freightDensity));
  assert.ok(freightDensity.button <= 29,
    "운임관리 기본 운임 버튼이 지나치게 높음: " + JSON.stringify(freightDensity));
  console.log("PASS: freight product rows match compact vertical rhythm");

  // Closing a freight editor must prompt while the original dialog is still open.
  await navPage.getByRole("button",{name:"기본 운임 설정"}).first().click();
  const freightEditor = navPage.getByRole("dialog",{name:/운임 설정/});
  await auditModalLayout(freightEditor,"상품별 운임 설정");
  await freightEditor.getByLabel("최대 묶음 수량").selectOption("2");
  await freightEditor.getByRole("button",{name:"닫기 ×"}).click();
  await checkPrompt("freight modal close");
  assert.equal(await freightEditor.evaluate((dialog) => dialog.open),true);
  await leave.getByRole("button",{name:"취소",exact:true}).click();
  assert.equal(await freightEditor.evaluate((dialog) => dialog.open),true);
  await freightEditor.getByRole("button",{name:"닫기 ×"}).click();
  await leave.getByRole("button",{name:"저장 안 함"}).click();
  await freightEditor.waitFor({state:"detached"});
  console.log("PASS: freight editor stays open until Save / Discard / Cancel decision");

  // Shipping: pending group assignment stays on Cancel, vanishes on Discard,
  // and is recorded only on Save.
  await navMenu.getByRole("button",{name:"운임 관리"}).click();
  const assignTab=navPage.getByRole("button",{name:"동급 배송 그룹 지정"});
  const historyTab=navPage.getByRole("button",{name:"조합 / 기준 이력"});
  await assignTab.click();
  const groupSelector=navPage.locator(".shipping-table-scroll tbody select").first();
  await groupSelector.selectOption("ci-ui-shipgroup");
  await historyTab.click();
  await checkPrompt("shipping");
  await leave.getByRole("button",{name:"취소",exact:true}).click();
  assert.equal(await groupSelector.inputValue(),"ci-ui-shipgroup");
  await historyTab.click();
  await leave.getByRole("button",{name:"저장 안 함"}).click();
  assert.equal((await mockState()).state.products.some(p=>p.shippingGroupId==="ci-ui-shipgroup"),false);
  await assignTab.click();
  await groupSelector.selectOption("ci-ui-shipgroup");
  await historyTab.click();
  await leave.getByRole("button",{name:"저장",exact:true}).click();
  await navPage.getByRole("button",{name:"조합 / 기준 이력","exact":true}).waitFor();
  await navPage.waitForFunction(() => window.__navSaved().state.products.some(
    product => product.shippingGroupId === "ci-ui-shipgroup"
  ));
  console.log("PASS: shipping group Save / Discard / Cancel (actual React tabs)");

  // New reception is intentionally not saveable until order confirmation.
  // Cancel keeps its raw text; Save must explain the restriction and stay put;
  // Discard may navigate away without creating an unconfirmed order.
  await navPage.reload();
  await navPage.getByRole("button",{name:"캡처 범위 지정"}).click();
  const ocr=navPage.getByRole("dialog",{name:"OCR 문자 인식 검토"});
  await ocr.getByRole("button",{name:"원문 교체"}).click();
  await navPage.waitForFunction(() => document.querySelector(".source-document")?.textContent?.includes("검증 발주 원문"));
  await navMenu.getByRole("button",{name:"상품 관리"}).click();
  await checkPrompt("unconfirmed reception");
  await leave.getByRole("button",{name:"취소",exact:true}).click();
  assert.ok((await navPage.locator(".source-document").textContent()).includes("검증 발주 원문"));
  await navMenu.getByRole("button",{name:"상품 관리"}).click();
  await leave.getByRole("button",{name:"저장",exact:true}).click();
  await navPage.getByText(/신규 발주서는 주문 확인 완료 후 저장할 수 있습니다/).waitFor();
  assert.ok((await navPage.locator(".source-document").textContent()).includes("검증 발주 원문"));
  await navMenu.getByRole("button",{name:"상품 관리"}).click();
  await leave.getByRole("button",{name:"저장 안 함"}).click();
  await navPage.getByRole("heading",{name:/상품 가격표/}).waitFor();
  assert.equal((await mockState()).state.orders.length,navFixture.orders.length);
  console.log("PASS: unconfirmed reception Cancel / Save-blocked / Discard (actual React UI)");

  // Automatic-message sub-tabs are independent editors. Switching without
  // saving must not silently discard text (the previous unmount bug).
  await navPage.reload();
  await navMenu.getByRole("button",{name:"거래처 관리"}).click();
  const clientSubnav=navPage.getByRole("navigation",{name:"거래처 관리 메뉴"});
  await clientSubnav.getByRole("button",{name:"자동 메시지 편집"}).click();
  const messageSubnav=navPage.getByRole("navigation",{name:"자동 메시지 편집 종류"});
  const commonTab=messageSubnav.getByRole("button",{name:"상황별 공통 안내"});
  const productNoticeTab=messageSubnav.getByRole("button",{name:"잠정 상품 선택 안내"});
  const automaticText=navPage.getByRole("textbox",{name:"선택한 자동 메시지 편집"});
  const originalTemplate=await automaticText.inputValue();
  await automaticText.fill(originalTemplate+"\n검증 전용 문장");
  await productNoticeTab.click();
  await checkPrompt("automatic-message internal tab");
  await leave.getByRole("button",{name:"취소",exact:true}).click();
  assert.equal(await automaticText.inputValue(),originalTemplate+"\n검증 전용 문장");
  await productNoticeTab.click();
  await leave.getByRole("button",{name:"저장 안 함"}).click();
  await navPage.getByRole("heading",{name:/상품별 안내문 등록/}).waitFor();
  assert.equal((await mockState()).state.settings.automaticMessageTemplates?.colorDefault?.includes("검증 전용 문장")??false,false);
  await commonTab.click();
  await automaticText.fill(originalTemplate+"\n저장 검증 문장");
  await productNoticeTab.click();
  await leave.getByRole("button",{name:"저장",exact:true}).click();
  await navPage.getByRole("heading",{name:/상품별 안내문 등록/}).waitFor();
  assert.equal((await mockState()).state.settings.automaticMessageTemplates?.colorDefault?.includes("저장 검증 문장"),true);
  console.log("PASS: automatic-message subtab Save / Discard / Cancel");

  // Product-specific notice: navigation uses the same safe three choices.
  const productSearch=navPage.getByRole("textbox",{name:"안내문을 등록할 상품 검색"});
  // The first keystroke must survive the tab transition without waiting or retrying.
  await productSearch.fill("BD");
  await navPage.waitForTimeout(350);
  assert.equal(await productSearch.inputValue(),"BD",
    "The first product-notice search input must not reset after the editor mounts");
  const firstProductNotice=navPage.locator('[aria-label="잠정 상품 선택 안내"] button.family-list-row').first();
  await firstProductNotice.waitFor();
  await firstProductNotice.click();
  const noticeText=navPage.getByRole("textbox",{name:"상품별 잠정 선택 안내문"});
  await noticeText.fill("검증용 안내문 - 저장하지 마세요");
  await commonTab.click();
  await checkPrompt("product-specific notice subtab");
  await leave.getByRole("button",{name:"취소",exact:true}).click();
  assert.equal(await noticeText.inputValue(),"검증용 안내문 - 저장하지 마세요");
  await commonTab.click();
  await leave.getByRole("button",{name:"저장 안 함"}).click();
  await automaticText.waitFor();
  assert.equal(Object.keys((await mockState()).state.settings.provisionalProductNotices??{}).length,0);
  await productNoticeTab.click();
  // Returning to this tab does not discard the previously entered search.
  assert.equal(await productSearch.inputValue(),"BD");
  await firstProductNotice.click();
  await noticeText.fill("검증용 안내문 - 저장합니다");
  await commonTab.click();
  await leave.getByRole("button",{name:"저장",exact:true}).click();
  await automaticText.waitFor();
  assert.ok(Object.values((await mockState()).state.settings.provisionalProductNotices??{})
    .some(value=>value==="검증용 안내문 - 저장합니다"));
  console.log("PASS: product-specific notice subtab Save / Discard / Cancel");
  // In-place edits must ask before switching records, even when the page does not change.
  await navMenu.getByRole("button", {name:"상품 관리"}).click();
  const productSubnav = navPage.getByRole("navigation", {name:"상품 관리 메뉴"});
  await productSubnav.getByRole("button", {name:"브랜드 관리"}).click();
  const brandInput = navPage.getByRole("textbox", {name:"브랜드 공식명"});
  const brandLayout = await navPage.locator(".registry-brand-manager").evaluate((root) => {
    const fields = [...root.querySelectorAll(".registry-edit-form > .field")];
    const firstRow = root.querySelector(".registry-list .registry-row");
    const action = firstRow?.querySelector("button");
    return {
      fieldCount: fields.length,
      fieldMargins: fields.map((field) => parseFloat(getComputedStyle(field).marginBottom)),
      labelSizes: fields.map((field) => parseFloat(getComputedStyle(field.querySelector("label")).fontSize)),
      rowHeight: firstRow?.getBoundingClientRect().height ?? 0,
      buttonHeight: action?.getBoundingClientRect().height ?? 0,
    };
  });
  assert.equal(brandLayout.fieldCount, 4, JSON.stringify(brandLayout));
  assert.ok(brandLayout.fieldMargins.every((margin) => margin === 0), JSON.stringify(brandLayout));
  assert.ok(brandLayout.labelSizes.every((size) => size === 14),
    "Brand fields must use common label size: " + JSON.stringify(brandLayout));
  assert.ok(brandLayout.rowHeight <= 60 && brandLayout.buttonHeight <= 34,
    "Brand rows must stay compact: " + JSON.stringify(brandLayout));
  const brandRow = (name) => navPage.getByRole("list", {name:"등록된 브랜드"})
    .getByRole("listitem").filter({hasText:name});
  const editBrand = (name) => brandRow(name).getByRole("button", {name:"정정"}).click();
  await editBrand("CI검증브랜드A");
  await brandInput.fill("CI브랜드수정취소시험");
  await editBrand("CI검증브랜드B");
  await checkPrompt("brand switch");
  await leave.getByRole("button", {name:"취소",exact:true}).click();
  assert.equal(await brandInput.inputValue(),"CI브랜드수정취소시험");
  await editBrand("CI검증브랜드B");
  await leave.getByRole("button", {name:"저장 안 함"}).click();
  assert.equal(await brandInput.inputValue(),"CI검증브랜드B");
  await editBrand("CI검증브랜드A");
  await brandInput.fill("CI검증브랜드A-저장");
  await editBrand("CI검증브랜드B");
  await leave.getByRole("button", {name:"저장",exact:true}).click();
  assert.equal(await brandInput.inputValue(),"CI검증브랜드B");
  assert.equal((await mockState()).state.brands.find(b => b.id==="ci-brand-a").name,"CI검증브랜드A-저장");
  console.log("PASS: brand target switch Save / Discard / Cancel");

  await productSubnav.getByRole("button", {name:"별칭 관리"}).click();
  const aliasInput = navPage.getByRole("textbox", {name:"관리 별칭"});
  const aliasLayout = await navPage.locator(".alias-manager").evaluate((root) => {
    const fields = [...root.querySelectorAll(".registry-edit-form > .field")];
    const action = root.querySelector(".registry-list .registry-row > button");
    return {
      fieldCount: fields.length,
      fieldMargins: fields.map((field) => parseFloat(getComputedStyle(field).marginBottom)),
      buttonHeight: action?.getBoundingClientRect().height ?? 0,
    };
  });
  assert.equal(aliasLayout.fieldCount, 2, JSON.stringify(aliasLayout));
  assert.ok(aliasLayout.fieldMargins.every((margin) => margin === 0), JSON.stringify(aliasLayout));
  assert.ok(aliasLayout.buttonHeight <= 34, JSON.stringify(aliasLayout));
  const editAlias = (name) => navPage.getByRole("list", {name:"등록된 별칭"})
    .getByRole("listitem").filter({hasText:name})
    .getByRole("button", {name:"연결 정정"}).click();
  await editAlias("CI회귀별칭A");
  await aliasInput.fill("CI별칭수정취소시험");
  await editAlias("CI회귀별칭B");
  await checkPrompt("alias switch");
  await leave.getByRole("button", {name:"취소",exact:true}).click();
  assert.equal(await aliasInput.inputValue(),"CI별칭수정취소시험");
  await editAlias("CI회귀별칭B");
  await leave.getByRole("button", {name:"저장 안 함"}).click();
  assert.equal(await aliasInput.inputValue(),"CI회귀별칭B");
  await editAlias("CI회귀별칭A");
  await aliasInput.fill("CI회귀별칭A저장검사");
  await editAlias("CI회귀별칭B");
  await leave.getByRole("button", {name:"저장",exact:true}).click();
  assert.equal(await aliasInput.inputValue(),"CI회귀별칭B");
  assert.equal((await mockState()).state.aliases.find(a => a.id==="ci-alias-a").text,"CI회귀별칭A저장검사");
  console.log("PASS: alias target switch Save / Discard / Cancel");

  await productSubnav.getByRole("button", {name:"대표색상 관리"}).click();
  const colorName = navPage.locator("#new-color-group");
  const colorForm = await navPage.locator(".family-create-form").evaluate((form) => {
    const field = form.querySelector(".field");
    const label = field?.querySelector("label");
    const input = field?.querySelector("input");
    const button = form.querySelector("button");
    return {
      labelFor: label?.htmlFor,
      inputId: input?.id,
      marginBottom: field ? getComputedStyle(field).marginBottom : "",
      inputRight: input?.getBoundingClientRect().right ?? 0,
      buttonLeft: button?.getBoundingClientRect().left ?? 0,
      buttonHeight: button?.getBoundingClientRect().height ?? 0,
      gap: getComputedStyle(form).columnGap,
    };
  });
  assert.equal(colorForm.labelFor, colorForm.inputId, JSON.stringify(colorForm));
  assert.equal(colorForm.marginBottom, "0px", JSON.stringify(colorForm));
  assert.ok(colorForm.buttonHeight >= 32 && colorForm.buttonHeight <= 44, JSON.stringify(colorForm));
  assert.ok(colorForm.buttonLeft >= colorForm.inputRight, JSON.stringify(colorForm));
  await colorName.fill("CI 미등록 대표색상");
  await navMenu.getByRole("button", {name:"거래처 관리"}).click();
  await checkPrompt("unregistered color group name");
  await leave.getByRole("button", {name:"취소",exact:true}).click();
  assert.equal(await colorName.inputValue(),"CI 미등록 대표색상");
  await navMenu.getByRole("button", {name:"거래처 관리"}).click();
  await leave.getByRole("button", {name:"저장",exact:true}).click();
  assert.equal(await colorName.inputValue(),"CI 미등록 대표색상");
  await navMenu.getByRole("button", {name:"거래처 관리"}).click();
  await leave.getByRole("button", {name:"저장 안 함"}).click();
  assert.equal((await mockState()).state.settings.colorGuidanceGroups?.length ?? 0,0);
  console.log("PASS: unregistered color-group name cannot vanish or auto-create");

  await navMenu.getByRole("button", {name:"운임 관리"}).click();
  await navPage.getByRole("button", {name:"동급 그룹 운임표"}).click();
  const shippingName = navPage.getByRole("textbox", {name:"새 배송 그룹명"});
  const shippingForm = await navPage.locator(".shipping-rates .new-group").evaluate((form) => {
    const field = form.querySelector(".field");
    const label = field?.querySelector("label");
    const input = field?.querySelector("input");
    const button = form.querySelector("button");
    const actions = form.closest(".shipping-rates")?.querySelector(".shipping-group-actions");
    const action = actions?.querySelector("button");
    return {
      labelFor: label?.htmlFor,
      inputId: input?.id,
      marginBottom: field ? getComputedStyle(field).marginBottom : "",
      labelSize: label ? parseFloat(getComputedStyle(label).fontSize) : 0,
      inputBottom: input?.getBoundingClientRect().bottom ?? 0,
      buttonBottom: button?.getBoundingClientRect().bottom ?? 0,
      actionHeight: action?.getBoundingClientRect().height ?? null,
      actionGap: actions ? getComputedStyle(actions).columnGap : null,
    };
  });
  assert.equal(shippingForm.labelFor, shippingForm.inputId, JSON.stringify(shippingForm));
  assert.equal(shippingForm.marginBottom, "0px", JSON.stringify(shippingForm));
  assert.equal(shippingForm.labelSize, 14, "Shipping form label differs from registry fields");
  assert.ok(Math.abs(shippingForm.inputBottom - shippingForm.buttonBottom) <= 2,
    JSON.stringify(shippingForm));
  if (shippingForm.actionHeight !== null)
    assert.ok(shippingForm.actionHeight <= 34, JSON.stringify(shippingForm));
  await shippingName.fill("CI 미등록 운임 그룹");
  await navMenu.getByRole("button", {name:"상품 관리"}).click();
  await checkPrompt("unregistered shipping group name");
  await leave.getByRole("button", {name:"취소",exact:true}).click();
  assert.equal(await shippingName.inputValue(),"CI 미등록 운임 그룹");
  await navMenu.getByRole("button", {name:"상품 관리"}).click();
  await leave.getByRole("button", {name:"저장",exact:true}).click();
  assert.equal(await shippingName.inputValue(),"CI 미등록 운임 그룹");
  await navMenu.getByRole("button", {name:"상품 관리"}).click();
  await leave.getByRole("button", {name:"저장 안 함"}).click();
  assert.equal((await mockState()).state.shipping.groups.some(g => g.name==="CI 미등록 운임 그룹"),false);
  console.log("PASS: unregistered shipping-group name cannot vanish or auto-create");

  await navMenu.getByRole("button", {name:"엑셀 관리"}).click();
  await navPage.getByRole("button", {name:"매장 발송 대기"}).click();
  const freightRow=navPage.locator('[data-queue-id="ci-store-queue"]');
  await freightRow.getByText("관리", {exact:true}).click();
  const freightAmount=freightRow.locator(".actual-freight-field input.money-input");
  await freightAmount.fill("5300");
  const excelSearch=navPage.getByRole("textbox", {name:"엑셀 목록 검색"});
  await excelSearch.fill("일치하지 않는 검증어");
  await freightRow.waitFor({state:"detached"});
  await excelSearch.fill("");
  await freightRow.getByText("관리", {exact:true}).click();
  assert.equal((await freightAmount.inputValue()).replaceAll(",",""),"5300");
  await navMenu.getByRole("button", {name:"상품 관리"}).click();
  await checkPrompt("freight draft after filtering");
  await leave.getByRole("button", {name:"취소",exact:true}).click();
  assert.equal((await freightAmount.inputValue()).replaceAll(",",""),"5300");
  await navMenu.getByRole("button", {name:"상품 관리"}).click();
  await leave.getByRole("button", {name:"저장 안 함"}).click();
  assert.equal((await mockState()).state.workflow.shipments.find(s=>s.id==="ci-store-ship").actualFreight?.STORE,undefined);
  await navMenu.getByRole("button", {name:"엑셀 관리"}).click();
  await navPage.getByRole("button", {name:"매장 발송 대기"}).click();
  await freightRow.getByText("관리", {exact:true}).click();
  await freightAmount.fill("4100");
  await navPage.getByRole("button", {name:"엑셀 작성 이력"}).click();
  await checkPrompt("freight save on internal tab");
  await leave.getByRole("button", {name:"저장",exact:true}).click();
  await navPage.waitForFunction(() => window.__navSaved().state.workflow.shipments
    .find(s=>s.id==="ci-store-ship").actualFreight?.STORE===4100);
  console.log("PASS: actual freight survives filtering and supports Save / Discard / Cancel");

  const cascadeInventory=cascadeSources.map(candidate=>{
    const observed=cascadeSeen.get(candidate.key);
    return {key:candidate.key,selector:candidate.selector,property:candidate.property,
      context:candidate.context,files:candidate.files,values:candidate.values,
      category:observed?.count>0 ? "MATCHED_IN_RENDERED_VIEW" :
        observed?.unsupportedSelector ? "UNSUPPORTED_SELECTOR" :
        candidate.context!=="base" ? "CONDITIONAL_NOT_OBSERVED" : "NOT_OBSERVED_IN_SAMPLED_VIEWS",
      count:observed?.count??0,
      actual:[...(observed?.actual??[])].slice(0,3),
      screens:[...(observed?.screens??[])].slice(0,5)};
  });
  assert.equal(cascadeInventory.length,cascadeSources.length);
  console.log("CSS_CASCADE_CLASSIFICATION",JSON.stringify(cascadeInventory));
  console.log("CSS_CASCADE_COUNTS",JSON.stringify({
    candidates:cascadeInventory.length,observed:cascadeInventory.filter(x=>x.category==="MATCHED_IN_RENDERED_VIEW").length,
    unobserved:cascadeInventory.filter(x=>x.category==="NOT_OBSERVED_IN_SAMPLED_VIEWS").length,
    conditionalNotObserved:cascadeInventory.filter(x=>x.category==="CONDITIONAL_NOT_OBSERVED").length,
    unsupportedSelectors:cascadeInventory.filter(x=>x.category==="UNSUPPORTED_SELECTOR").length,
    screens:styleProbe.length,
    observedStates:[...new Set([...cascadeSeen.values()].flatMap(e=>[...e.screens]))].length}));
  assert.ok(cascadeInventory.length>=100,"Cross-file CSS collision inventory unexpectedly incomplete");



  // Stage 7: use the actual developer modal workbench with detached mock data.
  // Do not submit business saves. Test every listed popup mode, including long
  // content, errors, busy state, and the unique manual-classification surface.
  await navPage.evaluate(()=>{
    window.bando.isTestWorkspace=true;
    const original=window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke=(command,args)=>{
      if(command==="test_run_history")return Promise.resolve([]);
      if(command==="test_database_preview")return Promise.resolve({enabled:false});
      if(command==="receipt_archive")return Promise.resolve([]);
      return original(command,args);
    };
  });
  await navMenu.getByRole("button",{name:"설정",exact:true}).click();
  await navPage.getByRole("tab",{name:"개발자 모드"}).click();
  const popupSelect=navPage.locator("#dev-popup");
  await popupSelect.waitFor();
  const popupOpen=navPage.getByRole("button",{name:"선택한 실제 화면 열기"});
  const stage7Records=[];
  const measureStage7=async(label,dialog)=>{
    const result=await dialog.evaluate(element=>{
      const rect=element.getBoundingClientRect();
      const panel=element.querySelector(":scope > .modal");
      const heading=panel?.querySelector(":scope > header h2");
      const close=panel?.querySelector(":scope > header button");
      const fields=panel?.querySelector(".modal-fields");
      const scrollOwner=panel?.querySelector(".client-editor-body, .product-detail-body")
        ??fields??panel;
      const b=scrollOwner.getBoundingClientRect();
      return {label:element.getAttribute("aria-label"),
        width:Math.round(rect.width),height:Math.round(rect.height),
        top:Math.round(rect.top),bottom:Math.round(rect.bottom),
        left:Math.round(rect.left),right:Math.round(rect.right),
        titleFont:heading?parseFloat(getComputedStyle(heading).fontSize):0,
        closeHeight:close?Math.round(close.getBoundingClientRect().height):0,
        scrollOwner:scrollOwner.className?.toString()??"",
        scrollStyle:getComputedStyle(scrollOwner).overflowY,
        scrollHeight:scrollOwner.scrollHeight,clientHeight:scrollOwner.clientHeight,
        scrollBoxBottom:Math.round(b.bottom),
        viewportWidth:window.innerWidth,viewportHeight:window.innerHeight,
        focused:element.contains(document.activeElement),
        panelOverflow:panel?getComputedStyle(panel).overflowY:"",
        controlAudit:[...panel.querySelectorAll("input:not([type=hidden]):not([type=file]), textarea, select, button")]
          .filter(node=>getComputedStyle(node).display!=="none" && node.getBoundingClientRect().width>0)
          .map(node=>{
            const box=node.getBoundingClientRect();
            return {tag:node.tagName.toLowerCase(),label:node.getAttribute("aria-label")||
              node.textContent?.trim().slice(0,32)||"",
              left:Math.round(box.left),right:Math.round(box.right),
              top:Math.round(box.top),bottom:Math.round(box.bottom),
              height:Math.round(box.height),font:parseFloat(getComputedStyle(node).fontSize)};
          }),
        fieldOverflow:fields?fields.scrollWidth-fields.clientWidth:0,
        scrollableContent:scrollOwner.scrollHeight>scrollOwner.clientHeight+1,
        footer:panel?.querySelector(".modal-footer,.client-editor-footer,.product-detail-footer")
          ?(()=>{
            const box=panel.querySelector(".modal-footer,.client-editor-footer,.product-detail-footer").getBoundingClientRect();
            return {top:Math.round(box.top),bottom:Math.round(box.bottom)};
          })():null};
    });
    assert.ok(result.width>200 && result.top>=-1 &&
      result.bottom<=result.viewportHeight+1 &&
      result.left>=-1 && result.right<=result.viewportWidth+1,
      "Stage7 dialog escapes viewport "+label+": "+JSON.stringify(result));
    assert.equal(result.titleFont,18,
      "Stage7 modal title must use the shared 18px typography at 100% UI scale "+label+": "+JSON.stringify(result));
    assert.ok(result.closeHeight>=28 && result.closeHeight<=40,
      "Stage7 close button inconsistent "+label+": "+JSON.stringify(result));
    assert.ok(result.scrollBoxBottom<=result.bottom+2,
      "Stage7 scroll owner escapes modal "+label+": "+JSON.stringify(result));
    assert.ok(result.fieldOverflow<=3,
      "Stage7 fields overflow horizontally "+label+": "+JSON.stringify(result));
    assert.ok(result.controlAudit.every(c=>c.left>=result.left-2 && c.right<=result.right+2),
      "Stage7 visible control exceeds dialog width "+label+": "+JSON.stringify(result));
    assert.ok(result.controlAudit.filter(c=>c.tag==="button").every(c=>
      c.label.includes("도움말") ? c.height>=20 : c.height>=24),
      "Stage7 action button is too short "+label+": "+JSON.stringify(result));
    assert.ok(!result.scrollableContent || ["auto","scroll"].includes(result.scrollStyle),
      "Stage7 overflowing content cannot scroll "+label+": "+JSON.stringify(result));
    if(result.footer)assert.ok(result.footer.bottom<=result.bottom+2,
      "Stage7 action footer escapes modal "+label+": "+JSON.stringify(result));
    stage7Records.push({popup:label,...result});
    return result;
  };
  const nativeOpen=()=>navPage.locator("dialog.app-modal-layer[open]").last();
  const closeNative=async(dialog)=>{
    await dialog.getByRole("button",{name:"닫기 ×"}).click();
    await dialog.waitFor({state:"hidden"});
  };
  for(const mode of ["NORMAL","EMPTY","ERROR","BUSY","LONG","WARNING","SUCCESS","FAILURE","CANCEL"]){
    await popupSelect.selectOption("common");
    await navPage.locator("#dev-popup-state").selectOption(mode);
    await popupOpen.click();
    const dialog=nativeOpen();
    await dialog.waitFor();
    const entry=await measureStage7("common/"+mode,dialog);
    if(mode==="LONG")
      assert.ok(entry.scrollHeight>entry.clientHeight,
        "Long text should scroll inside common modal: "+JSON.stringify(entry));
    if(mode==="ERROR"||mode==="WARNING"||mode==="FAILURE")
      assert.ok(await dialog.getByRole("alert").count()>0,
        "Stage7 warning/error message is missing in "+mode);
    if(mode==="BUSY"){
      assert.equal(await dialog.getAttribute("aria-busy"),"true");
      await navPage.waitForFunction(()=>
        document.querySelector('dialog.developer-preview-dialog[open]')?.getAttribute("aria-busy")!=="true");
    }
    await closeNative(dialog);
  }
  for(const popup of ["raw","resolver","product-search","category","retail"]){
    await popupSelect.selectOption(popup);
    await popupOpen.click();
    const dialog=nativeOpen();
    await dialog.waitFor();
    await measureStage7(popup,dialog);
    await closeNative(dialog);
  }
  await popupSelect.selectOption("manual");
  await popupOpen.click();
  const manual=navPage.getByRole("dialog",{name:"수동 분류"});
  await manual.waitFor();
  const manualResult=await manual.evaluate(el=>{
    const box=el.getBoundingClientRect();
    const scroll=el.querySelector(".manual-grid-scroll");
    return {width:Math.round(box.width),height:Math.round(box.height),
      viewportWidth:window.innerWidth,viewportHeight:window.innerHeight,
      scrollPresent:!!scroll,scrollOverflow:scroll?getComputedStyle(scroll).overflowY:""};
  });
  assert.ok(manualResult.scrollPresent,"Manual classification requires an independent grid scrollbar");
  stage7Records.push({popup:"manual",...manualResult});
  await manual.getByRole("button",{name:"닫기 ×"}).click();
  await manual.waitFor({state:"hidden"});
  for(const [popup,button] of [["client","＋ 거래처 등록"],["product","상품 추가"]]){
    await popupSelect.selectOption(popup);
    await popupOpen.click();
    const workspace=navPage.locator(".developer-live-container");
    await workspace.waitFor();
    await workspace.getByRole("button",{name:button,exact:true}).click();
    if(popup==="product")await workspace.getByRole("button",{name:"직접 등록",exact:true}).click();
    const dialog=nativeOpen();
    await dialog.waitFor();
    await measureStage7(popup+"-editor",dialog);
    await closeNative(dialog);
    await navPage.getByRole("button",{name:"시험 화면 닫기"}).click();
  }
  const stage7Workbook=async(name,headers,values,sheetName="Sheet1")=>{
    const workbook=new ExcelJS.Workbook(),sheet=workbook.addWorksheet(sheetName);
    sheet.addRow(headers);
    sheet.addRow(values);
    return {name,mimeType:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      buffer:Buffer.from(await workbook.xlsx.writeBuffer())};
  };
  const registrationFile=await stage7Workbook("CI-product-registration.xlsx",
    ["최종 등록명","제조사 모델코드","브랜드","색상","구성 구분","규격",
      "판매 단위","상품군","카테고리 경로","도매가","반도매가","소매가","상품 링크","비고"],
    ["CI 미등록 제품","CI-TEST-1001","","검정","가방 미포함","","개",
      "반도스탠드","","1000","1300","1600","","합성 UI 검사용"],"상품 등록");
  const replyHeaders=["수하인명","수하인우편번호","수하인주소","수하인전화번호",
    "수하인핸드폰번호","택배수량","택배운임","운임구분","품목명","",
    "메시지","송하인명","(송)우편","(송)주소1","(송)전화","(송)핸드폰","운송장번호"];
  const replyCells=Array(17).fill("");
  replyCells[0]="CI 검증수취인";replyCells[2]="경기도 검증시 시험길 12";
  replyCells[3]="01012345678";replyCells[6]="3000";replyCells[16]="000012345678";
  const replyFile=await stage7Workbook("CI-factory-reply.xlsx",replyHeaders,replyCells);
  // Generated in memory: uploaded only to the detached browser mock, never saved.
  for(const popup of ["registration","reply","receipt"]){
    await popupSelect.selectOption(popup);
    await popupOpen.click();
    const work=navPage.locator(".developer-live-container");
    await work.waitFor();
    const preview=await work.evaluate(el=>({
      visible:el.getBoundingClientRect().width>0,
      content:el.textContent?.trim().slice(0,90)??""
    }));
    assert.ok(preview.visible,"Developer workflow preview not shown: "+popup);
    if(popup==="registration"){
      await work.getByRole("button",{name:"엑셀 대량 등록",exact:true}).click();
      const dialog=nativeOpen();
      await dialog.waitFor();
      await dialog.locator('input[type="file"]').setInputFiles(registrationFile);
      await dialog.locator(".registration-preview").first().waitFor();
      await measureStage7(popup+"-workbook-review",dialog);
      await closeNative(dialog);
    }else if(popup==="reply"){
      await work.locator('input[type="file"]').setInputFiles(replyFile);
      const dialog=nativeOpen();
      await dialog.waitFor();
      assert.equal(await dialog.getByRole("button",{name:/DB 백업 후 회신/}).isDisabled(),true,
        "Synthetic factory preview must never allow production commit");
      await measureStage7(popup+"-workbook-review",dialog);
      await closeNative(dialog);
    }else{
      await work.getByRole("button",{name:"감사 기록 열기",exact:true}).click();
      const dialog=nativeOpen();
      await dialog.waitFor();
      await measureStage7(popup+"-dialog",dialog);
      await closeNative(dialog);
    }
    await navPage.getByRole("button",{name:"시험 화면 닫기"}).click();
  }
  // A second set of real dialogs is reachable from category and freight
  // management, rather than the developer workbench's default previews.
  await navMenu.getByRole("button",{name:"상품 관리",exact:true}).click();
  await navPage.getByRole("navigation",{name:"상품 관리 메뉴"})
    .getByRole("button",{name:"카테고리 관리",exact:true}).click();
  await navPage.getByRole("button",{name:"+ 하위 분류 추가",exact:true}).first().click();
  let operationDialog=nativeOpen();
  await operationDialog.waitFor();
  await measureStage7("category-add",operationDialog);
  await closeNative(operationDialog);
  await navMenu.getByRole("button",{name:"운임 관리",exact:true}).click();
  await navPage.getByRole("button",{name:"동급 그룹 운임표",exact:true}).click();
  const groupRow=navPage.locator(".shipping-rates table tbody tr").filter({hasText:"검증용 배송 그룹"}).first();
  for(const [button,label] of [["운임 수정","shipping-group-rate"],["삭제","shipping-group-delete"]]){
    await groupRow.getByRole("button",{name:button,exact:true}).click();
    const dialog=nativeOpen();
    await dialog.waitFor();
    await measureStage7(label,dialog);
    await closeNative(dialog);
  }
  console.log("STAGE7_MODAL_AUDIT",JSON.stringify(stage7Records));
  assert.equal(stage7Records.length,23,
    "Stage7 modal workbench inventory changed without audit coverage");
  console.log("PASS: developer workbench common modes and all 12 popup entries audited");

  // Stage 8: exercise the REAL settings control that drives --ui-scale. Check
  // the whole outer frame, semantic list owner, and native modal boundaries.
  const stage8ViewportSizes=[
    {width:1920,height:1080},
    {width:1600,height:900},
    {width:1280,height:800},
    {width:1024,height:700},
  ];
  const stage8Scales=[90,100,110,125];
  const stage8Screens=[
    ["상품 관리",".product-list-workspace .price-table-scroll"],
    ["운임 관리",".shipping-product-list .shipping-table-scroll"],
    ["거래처 관리",".management-scroll"],
    ["설정",".settings-tab-panels"],
    ["엑셀 관리",".excel-table-scroll"],
    ["일일 결산",".daily-settlement"],
    ["주문 내역",".order-history-list"],
  ];
  const stage8Results=[];
  const stage8Measure=async(context,innerSelector)=>{
    const actual=await navPage.evaluate((selector)=>{
      const box=(s)=>document.querySelector(s);
      const shell=box(".hub-shell-scroll");
      const root=box(".hub-main-content > .management-container");
      const inside=box(selector);
      const body=document.scrollingElement;
      if(!shell||!root||!inside)return {missing:{shell:!!shell,root:!!root,inside:!!inside}};
      const rootRect=root.getBoundingClientRect();
      const innerRect=inside.getBoundingClientRect();
      return {shellY:shell.scrollHeight-shell.clientHeight,
        rootY:root.scrollHeight-root.clientHeight,
        bodyY:(body?.scrollHeight??0)-window.innerHeight,
        rootBottom:Math.round(rootRect.bottom),
        innerBottom:Math.round(innerRect.bottom),
        innerHeight:Math.round(innerRect.height),
        innerOverflow:getComputedStyle(inside).overflowY,
        horizontalShellOverflow:shell.scrollWidth-shell.clientWidth,
        scale:Number(getComputedStyle(document.documentElement).getPropertyValue("--ui-scale"))};
    },innerSelector);
    assert.ok(!actual.missing,context+" missing work area: "+JSON.stringify(actual));
    console.log("STAGE8_SAMPLE",JSON.stringify({context,...actual}));
    assert.ok(actual.shellY<=3,context+" has outer shell vertical scrollbar: "+JSON.stringify(actual));
    assert.ok(actual.rootY<=3,context+" has page-level vertical overflow: "+JSON.stringify(actual));
    assert.ok(actual.bodyY<=3,context+" has document-level vertical scrollbar: "+JSON.stringify(actual));
    assert.ok(actual.innerBottom<=actual.rootBottom+3,
      context+" inner workspace extends outside page: "+JSON.stringify(actual));
    assert.ok(actual.innerHeight>=24,
      context+" inner workspace shrank to unusable height: "+JSON.stringify(actual));
    return actual;
  };
  const stage8CheckModal=async(kind,open,close)=>{
    await open();
    const dialog=navPage.locator("dialog.app-modal-layer[open]").last();
    await dialog.waitFor();
    const metrics=await dialog.evaluate(el=>{
      const frame=el.getBoundingClientRect();
      const panel=el.querySelector(":scope > .modal");
      const title=panel?.querySelector(":scope > header h2");
      const closeButton=panel?.querySelector(":scope > header button");
      const owner=panel?.querySelector(".client-editor-body, .product-detail-body")
        ??panel?.querySelector(".modal-fields")??panel;
      const scroll=owner.getBoundingClientRect();
      const controls=[...panel.querySelectorAll("input:not([type=hidden]), select, textarea, button")]
        .filter(x=>getComputedStyle(x).display!=="none"&&x.getBoundingClientRect().width>0);
      return {width:Math.round(frame.width),top:Math.round(frame.top),bottom:Math.round(frame.bottom),
        left:Math.round(frame.left),right:Math.round(frame.right),
        titleSize:title?parseFloat(getComputedStyle(title).fontSize):0,
        closeHeight:closeButton?Math.round(closeButton.getBoundingClientRect().height):0,
        overflow:getComputedStyle(owner).overflowY,
        scrollBottom:Math.round(scroll.bottom),
        overhang:controls.reduce((max,control)=>{
          const r=control.getBoundingClientRect();
          return Math.max(max,frame.left-r.left,r.right-frame.right);
        },0),
        viewportHeight:window.innerHeight,viewportWidth:window.innerWidth};
    });
    const label=kind+" at "+(await navPage.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue("--ui-scale")))+
      " / "+(await navPage.evaluate(()=>window.innerWidth+"x"+window.innerHeight));
    console.log("STAGE8_MODAL",JSON.stringify({label,...metrics}));
    assert.ok(metrics.top>=-2 && metrics.bottom<=metrics.viewportHeight+2,
      label+" modal exceeds vertical viewport: "+JSON.stringify(metrics));
    assert.ok(metrics.left>=-2&&metrics.right<=metrics.viewportWidth+2,
      label+" modal exceeds horizontal viewport: "+JSON.stringify(metrics));
    assert.ok(metrics.scrollBottom<=metrics.bottom+2,
      label+" modal scroll content extends below frame: "+JSON.stringify(metrics));
    assert.ok(metrics.overhang<=3,
      label+" modal controls are horizontally clipped: "+JSON.stringify(metrics));
    assert.ok(Math.abs(metrics.titleSize-18*metricsScale())<=.25,
      label+" title did not follow UI scale: "+JSON.stringify(metrics));
    function metricsScale(){return Number(label.split(" at ")[1].split(" / ")[0])}
    await close(dialog);
    return metrics;
  };
  for(const scale of stage8Scales){
    await navMenu.getByRole("button",{name:"설정",exact:true}).click();
    await navPage.getByRole("tab",{name:"기본 설정"}).click();
    await navPage.getByRole("combobox",{name:"전체 UI 크기"}).selectOption(String(scale));
    await navPage.waitForFunction(expected=>
      Math.abs(Number(getComputedStyle(document.documentElement).getPropertyValue("--ui-scale"))-expected)<.001,
      scale/100);
    for(const viewport of stage8ViewportSizes){
      await navPage.setViewportSize(viewport);
      for(const [menu,selector] of stage8Screens){
        await navMenu.getByRole("button",{name:menu,exact:true}).click();
        await navPage.locator(selector).first().waitFor({state:"visible"});
        const context=menu+" "+viewport.width+"x"+viewport.height+" "+scale+"%";
        const measure=await stage8Measure(context,selector);
        stage8Results.push({context,...measure});
      }
      await navMenu.getByRole("button",{name:"운임 관리",exact:true}).click();
      await navPage.getByRole("button",{name:"동급 배송 그룹 지정",exact:true}).click();
      const subContext="배송 그룹 지정 "+viewport.width+"x"+viewport.height+" "+scale+"%";
      stage8Results.push({context:subContext,...await stage8Measure(subContext,
        ".shipping-assignment-list .shipping-table-scroll")});
      await navMenu.getByRole("button",{name:"상품 관리",exact:true}).click();
      await stage8CheckModal("상품 상세",
        async()=>navPage.locator(".product-prices tbody tr").first()
          .getByRole("button",{name:"상세 관리"}).click(),
        async dialog=>{await dialog.getByRole("button",{name:"닫기 ×"}).click();
          await dialog.waitFor({state:"hidden"});});
      await navMenu.getByRole("button",{name:"거래처 관리",exact:true}).click();
      await stage8CheckModal("거래처 상세",
        async()=>navPage.locator(".client-table tbody tr").filter({hasText:"검증악기"}).first().click(),
        async dialog=>{await dialog.getByRole("button",{name:"닫기 ×"}).click();
          await dialog.waitFor({state:"hidden"});});
      // All secondary tabs are covered at both viewport extremes and both
      // UI-scale extremes. This supplements 128 primary page combinations.
      if((scale===90||scale===125)&&(viewport.width===1920||viewport.width===1024)){
        const extraTabs=[
          ["상품 관리","상품 관리 메뉴",
            [["카테고리 관리",".management-scroll"],
              ["대표색상 관리",".management-scroll"],
              ["별칭 관리",".management-scroll"],
              ["브랜드 관리",".management-scroll"]]],
          ["운임 관리",null,
            [["동급 그룹 운임표",".shipping-rates"],
              ["조합 / 기준 이력",".shipping-rates"]]],
          ["엑셀 관리",null,
            [["공장 엑셀 대기",".excel-table-scroll"],
              ["매장 발송 대기",".excel-table-scroll"],
              ["엑셀 작성 이력",".excel-table-scroll"]]],
          ["거래처 관리",null,
            [["자동 메시지 편집",".management-scroll"]]],
        ];
        for(const [parent,tabMenu,tabs] of extraTabs){
          await navMenu.getByRole("button",{name:parent,exact:true}).click();
          for(const [tab,selector] of tabs){
            const source=tabMenu
              ? navPage.getByRole("navigation",{name:tabMenu})
              : navPage;
            await source.getByRole("button",{name:tab,exact:true}).click();
            const context=parent+" / "+tab+" "+viewport.width+"x"+viewport.height+" "+scale+"%";
            await navPage.locator(selector).first().waitFor({state:"visible"});
            stage8Results.push({context,...await stage8Measure(context,selector)});
          }
        }
        await navMenu.getByRole("button",{name:"설정",exact:true}).click();
        await navPage.getByRole("tab",{name:"개발자 모드"}).click();
        await navPage.locator("#dev-popup").selectOption("common");
        await navPage.locator("#dev-popup-state").selectOption("LONG");
        await stage8CheckModal("긴 내용 공통 모달",
          async()=>navPage.getByRole("button",{name:"선택한 실제 화면 열기"}).click(),
          async dialog=>{await dialog.getByRole("button",{name:"닫기 ×"}).click();
            await dialog.waitFor({state:"hidden"});});
      }
    }
  }
  await navPage.setViewportSize({width:1520,height:1000});
  await navMenu.getByRole("button",{name:"설정",exact:true}).click();
  await navPage.getByRole("tab",{name:"기본 설정"}).click();
  await navPage.getByRole("combobox",{name:"전체 UI 크기"}).selectOption("100");
  await navPage.waitForFunction(()=>Math.abs(
    Number(getComputedStyle(document.documentElement).getPropertyValue("--ui-scale"))-1)<.001);
  console.log("STAGE8_MATRIX",JSON.stringify({scales:stage8Scales,viewports:stage8ViewportSizes,
    primaryScreens:stage8Screens.length+1,extraTabChecks:40,samples:stage8Results.length,
    horizontalShellScrollAllowed:true,results:stage8Results}));
  assert.equal(stage8Results.length,stage8Scales.length*stage8ViewportSizes.length*(stage8Screens.length+1)+40);
  console.log("PASS: Stage8 viewport/UI-scale matrix bounds all navigation pages and editor modals");


  // Stage 8 follow-up: the reception desk was absent from the original
  // 4-scale x 4-viewport matrix. Keep the actual Kakao reservation and
  // horizontally scrollable three-column workspace intact.
  const followupReception = [];
  const followupScale = async (value) => {
    await navMenu.getByRole("button", {name:"설정",exact:true}).click();
    await navPage.getByRole("tab", {name:"기본 설정"}).click();
    await navPage.getByRole("combobox", {name:"전체 UI 크기"}).selectOption(String(value));
    await navPage.waitForFunction(expected =>
      Math.abs(Number(getComputedStyle(document.documentElement).getPropertyValue("--ui-scale"))-expected)<.001,
      value/100);
  };
  for (const scale of stage8Scales) {
    await followupScale(scale);
    for (const viewport of stage8ViewportSizes) {
      await navPage.setViewportSize(viewport);
      await navMenu.getByRole("button", {name:"접수",exact:true}).click();
      const live = navPage.locator(".hub-live-workspace");
      await live.waitFor({state:"visible"});
      const sample = await live.evaluate(el => {
        const outer=document.querySelector(".hub-shell-scroll");
        const inner=el.querySelector(".hub-panels");
        const scroll=el.querySelector(".hub-workspace-scroll");
        const stack=el.querySelector(".hub-reception-stack");
        const slots=inner ? [...inner.querySelectorAll(":scope > .hub-panel-slot")] : [];
        const body=document.scrollingElement;
        const bound=e=>{const r=e.getBoundingClientRect();
          return {left:Math.round(r.left),right:Math.round(r.right),
            top:Math.round(r.top),bottom:Math.round(r.bottom),
            width:Math.round(r.width),height:Math.round(r.height)};};
        return {
          shellY:outer ? outer.scrollHeight-outer.clientHeight : null,
          bodyY:body ? body.scrollHeight-window.innerHeight : null,
          scale:Number(getComputedStyle(document.documentElement).getPropertyValue("--ui-scale")),
          viewport:{width:window.innerWidth,height:window.innerHeight},
          live:bound(el),stack:stack?bound(stack):null,
          slotCount:slots.length,slots:slots.map(bound),
          internalHorizontalScroll:scroll ? scroll.scrollWidth-scroll.clientWidth : null,
          outerHorizontalScroll:outer ? outer.scrollWidth-outer.clientWidth : null,
          sourcePresent:!!el.querySelector(".source-pane, .source-document"),
          messagePresent:!!el.querySelector(".hub-slot-1 .hub-portal-target"),
          workflowPresent:!!el.querySelector(".hub-management .workflow-board"),
        };
      });
      const context="접수 "+viewport.width+"x"+viewport.height+" "+scale+"%";
      assert.ok(sample.slotCount===3 && sample.sourcePresent &&
        sample.messagePresent && sample.workflowPresent,
        context+" missing a reception panel: "+JSON.stringify(sample));
      assert.ok(sample.slots.every(s=>s.width>=80 && s.height>=120) &&
        sample.stack && sample.stack.height>=180,
        context+" unusable reception column: "+JSON.stringify(sample));
      assert.ok(sample.shellY<=3 && sample.bodyY<=3 &&
        sample.live.bottom<=viewport.height+3,
        context+" reception escapes viewport vertically: "+JSON.stringify(sample));
      followupReception.push({context,...sample});
      console.log("STAGE8_FOLLOWUP_RECEPTION",JSON.stringify({context,...sample}));
    }
  }
  assert.equal(followupReception.length,16,"Every reception scale/viewport combination must run");

  // Stage 8 usability: a bounded list is only useful when its LAST record and
  // action remain reachable. Exercise actual controls without saving any data.
  const followupLists=[];
  const followupDialogs=[];
  const followupRisks=[];
  const lastRowProbe=async(label,selector)=>{
    const element=navPage.locator(selector).first();
    await element.waitFor({state:"visible"});
    const sample=await element.evaluate(el=>{
      const rows=[...el.querySelectorAll("tbody tr")];
      const last=rows.at(-1);
      if(!last)return {missingRows:true};
      el.scrollTop=el.scrollHeight;
      el.scrollLeft=el.scrollWidth;
      const frame=el.getBoundingClientRect(),lastBox=last.getBoundingClientRect();
      const rowHeight=rows.length?rows[Math.floor(rows.length/2)].getBoundingClientRect().height:0;
      const visible=rows.filter(r=>{
        const b=r.getBoundingClientRect();
        return Math.min(b.bottom,frame.bottom)-Math.max(b.top,frame.top)>Math.min(14,b.height/2);
      }).length;
      const text=last.querySelector("td:nth-child(2)");
      return {rowCount:rows.length,visibleRows:visible,viewHeight:Math.round(frame.height),
        rowHeight:Math.round(rowHeight),lastTop:Math.round(lastBox.top),
        lastBottom:Math.round(lastBox.bottom),viewTop:Math.round(frame.top),
        viewBottom:Math.round(frame.bottom),
        scrollTop:el.scrollTop,scrollEnd:el.scrollHeight-el.clientHeight,
        horizontalScrollable:el.scrollWidth>el.clientWidth+2,
        endReachable:lastBox.top<frame.bottom && lastBox.bottom>frame.top,
        nameWidth:text?Math.round(text.getBoundingClientRect().width):null,
        nameScrollWidth:text?text.scrollWidth:null};
    });
    assert.ok(!sample.missingRows && sample.rowCount>10,
      label+" list lost real fixture rows: "+JSON.stringify(sample));
    assert.ok(sample.endReachable && sample.scrollTop>=sample.scrollEnd-3,
      label+" last record cannot be reached by list scroll: "+JSON.stringify(sample));
    assert.ok(sample.visibleRows>=1,
      label+" has no visible usable record: "+JSON.stringify(sample));
    if(sample.visibleRows<3 || sample.viewHeight<140){
      const flag={label,reason:"Fewer than 3 visible rows or list under 140px",...sample};
      followupRisks.push(flag);
      console.log("STAGE8_FOLLOWUP_DENSITY_RISK",JSON.stringify(flag));
    }
    followupLists.push({label,...sample});
    console.log("STAGE8_FOLLOWUP_LIST",JSON.stringify({label,...sample}));
  };
  const closeFollowupModal=async(dialog)=>{
    await dialog.getByRole("button",{name:"닫기 ×"}).click();
    await dialog.waitFor({state:"hidden"});
  };
  const extremeScales=[90,125];
  const extremeViewports=[
    {width:1920,height:1080},{width:1024,height:700},
  ];
  for(const scale of extremeScales){
    await followupScale(scale);
    for(const viewport of extremeViewports){
      await navPage.setViewportSize(viewport);
      const suffix=" "+viewport.width+"x"+viewport.height+" "+scale+"%";

      await navMenu.getByRole("button",{name:"상품 관리",exact:true}).click();
      await lastRowProbe("상품 관리"+suffix,".product-list-workspace .price-table-scroll");
      await navPage.locator(".product-prices tbody tr").last()
        .getByRole("button",{name:"상세 관리"}).click();
      let opened=navPage.locator("dialog.app-modal-layer[open]").last();
      await opened.waitFor();
      await closeFollowupModal(opened);

      await navMenu.getByRole("button",{name:"운임 관리",exact:true}).click();
      await lastRowProbe("상품별 운임"+suffix,".shipping-product-list .shipping-table-scroll");
      await navPage.locator(".shipping-product-list tbody tr").last()
        .getByRole("button",{name:/기본 운임 설정|그룹 기준 편집/}).first().click();
      opened=navPage.locator("dialog.app-modal-layer[open]").last();
      await opened.waitFor();
      await closeFollowupModal(opened);

      await navPage.getByRole("button",{name:"동급 배송 그룹 지정",exact:true}).click();
      await lastRowProbe("배송 그룹 지정"+suffix,
        ".shipping-assignment-list .shipping-table-scroll");
      const finalSelect=navPage.locator(".shipping-assignment-list tbody tr").last().locator("select");
      await finalSelect.focus();
      assert.equal(await finalSelect.evaluate(el=>document.activeElement===el),true,
        "Last shipping-group row select cannot receive focus "+suffix);

      // These risky dialogs are real business components, opened without writes.
      await navPage.getByRole("button",{name:"상품별 기본 운임",exact:true}).click();
      const freight=await stage8CheckModal("상품별 운임 설정",
        async()=>navPage.locator(".shipping-product-list tbody tr").first()
          .getByRole("button",{name:/기본 운임 설정|그룹 기준 편집/}).first().click(),
        closeFollowupModal);
      followupDialogs.push({kind:"freight",scale,viewport,...freight});

      await navMenu.getByRole("button",{name:"설정",exact:true}).click();
      await navPage.getByRole("tab",{name:"개발자 모드"}).click();
      for(const [id,name] of [["raw","원문 정정"],["category","카테고리 선택"]]){
        await navPage.locator("#dev-popup").selectOption(id);
        const measured=await stage8CheckModal(name,
          async()=>navPage.getByRole("button",{name:"선택한 실제 화면 열기"}).click(),
          closeFollowupModal);
        followupDialogs.push({kind:id,scale,viewport,...measured});
      }
      // Manual classification is a dedicated dialog-role workspace, NOT a
      // native Modal. Its outer bounds and table scroll owner must be measured.
      await navPage.locator("#dev-popup").selectOption("manual");
      await navPage.getByRole("button",{name:"선택한 실제 화면 열기"}).click();
      const manual=navPage.getByRole("dialog",{name:"수동 분류"}).last();
      await manual.waitFor();
      const manualSample=await manual.evaluate(el=>{
        const r=el.getBoundingClientRect();
        const table=el.querySelector(".manual-grid-scroll");
        const tableRect=table?.getBoundingClientRect();
        const close=[...el.querySelectorAll("button")].find(b=>b.textContent?.includes("닫기"));
        const closeRect=close?.getBoundingClientRect();
        return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,
          viewportWidth:window.innerWidth,viewportHeight:window.innerHeight,
          tableHeight:tableRect?.height??0,tableOverflow:table?getComputedStyle(table).overflowY:"",
          closeVisible:!!closeRect&&closeRect.bottom>0&&closeRect.top<window.innerHeight};
      });
      followupDialogs.push({kind:"manual",scale,viewport,...manualSample});
      const manualVisible=manualSample.top>=-2 &&
        manualSample.bottom<=manualSample.viewportHeight+2 &&
        manualSample.closeVisible && manualSample.tableHeight>=24;
      if(!manualVisible){
        const risk={label:"수동 분류"+suffix,reason:"Manual workspace cannot fit viewport or close is unreachable",...manualSample};
        followupRisks.push(risk);
        console.log("STAGE8_FOLLOWUP_MANUAL_RISK",JSON.stringify(risk));
      }
      await manual.getByRole("button",{name:"닫기 ×"}).click();

      // The three-choice unsaved edit prompt is a distinct native dialog.
      await navMenu.getByRole("button",{name:"운임 관리",exact:true}).click();
      await navPage.getByRole("button",{name:"동급 그룹 운임표",exact:true}).click();
      const unsavedName=navPage.getByRole("textbox",{name:"새 배송 그룹명"});
      await unsavedName.fill("CI 임시 저장 확인 화면 / 수정하지 않음");
      await navMenu.getByRole("button",{name:"상품 관리",exact:true}).click();
      const decision=navPage.locator("dialog.app-action-dialog[open]").last();
      await decision.waitFor();
      const decisionSample=await decision.evaluate(el=>{
        const r=el.getBoundingClientRect();
        const x=parseFloat(getComputedStyle(document.documentElement)
          .getPropertyValue("--kakao-reserved-width"))||0;
        const controls=[...el.querySelectorAll("button")].map(b=>{
          const c=b.getBoundingClientRect();
          return {left:c.left,right:c.right,top:c.top,bottom:c.bottom};
        });
        return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,
          width:r.width,viewportWidth:window.innerWidth,viewportHeight:window.innerHeight,
          kakaoReserved:x,centerError:Math.abs((r.left+r.right)/2-(x+(window.innerWidth-x)/2)),
          controlsVisible:controls.every(c=>c.left>=r.left-2&&c.right<=r.right+2&&
            c.top>=r.top-2&&c.bottom<=r.bottom+2)};
      });
      assert.ok(decisionSample.left>=-2 &&
        decisionSample.right<=decisionSample.viewportWidth+2 &&
        decisionSample.top>=-2 &&
        decisionSample.bottom<=decisionSample.viewportHeight+2 &&
        decisionSample.controlsVisible && decisionSample.centerError<=4,
        "Unsaved edit decision is clipped or off-center "+suffix+": "+JSON.stringify(decisionSample));
      followupDialogs.push({kind:"save-decision",scale,viewport,...decisionSample});
      await decision.getByRole("button",{name:"취소",exact:true}).click();
      await unsavedName.fill("");
    }
  }
  await followupScale(100);
  await navPage.setViewportSize({width:1520,height:1000});
  assert.equal(followupLists.length,12,"Last-record access matrix is incomplete");
  assert.equal(followupDialogs.length,20,"High-risk modal matrix is incomplete");
  console.log("STAGE8_FOLLOWUP_SUMMARY",JSON.stringify({
    reception:followupReception.length,lists:followupLists.length,
    dialogs:followupDialogs.length,densityRisks:followupRisks,
    windowsNativeVerified:false,changesToBusinessData:0,
  }));

  assert.deepEqual(navErrors,[],"Navigation React errors: "+navErrors.join("\n"));
  await navPage.close();
  assert.deepEqual(pageErrors, [], "React runtime errors: " + pageErrors.join("\n"));
  console.log("PASS: audit UI, docking, STORE, official URL, isolated developer tests and real Modal (mock IPC)");
} finally {
  if (browser) await browser.close();
  server.kill("SIGTERM");
}
