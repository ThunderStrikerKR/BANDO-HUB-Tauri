import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { setTimeout as pause } from "node:timers/promises";
import { chromium } from "playwright";

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
            return undefined;
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
  const navPage = await browser.newPage({ viewport: { width: 1520, height: 1000 } });
  navPage.setDefaultTimeout(8000);
  const navErrors = [];
  navPage.on("pageerror", (err) => navErrors.push(err.message));
  await navPage.addInitScript(({ initial }) => {
    let current = structuredClone(initial);
    const saveLog = [];
    window.__navSaved = () => ({ state: structuredClone(current), saves: structuredClone(saveLog) });
    window.__TAURI_INTERNALS__ = {
      invoke: async (command, args = {}) => {
        if (command === "startup_status")
          return { phase: "READY", attempts: 1, isTest: false };
        if (command === "startup_metrics")
          return { windowShownMs: null, databaseMs: 1, dataMs: null, readyMs: 1 };
        if (command === "workspace_mode") return false;
        if (command === "state_load") return structuredClone(current);
        if (command === "dock_status_native") return { active: false, mode: "ORIGINAL", ratio: 0.8 };
        if (command === "state_save") {
          if ((args.state.revision ?? 0) !== (current.revision ?? 0))
            throw Error("Mock rejected stale revision");
          current = structuredClone(args.state);
          current.revision = (current.revision ?? 0) + 1;
          saveLog.push({type:"state_save", revision:current.revision, state:structuredClone(current)});
          return undefined;
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
  const navMenu = navPage.getByRole("navigation", { name: "업무 메뉴" });
  const leave = navPage.getByRole("dialog", {name:"변경사항 저장"});
  const checkPrompt = async (context) => {
    await leave.waitFor();
    for (const action of ["저장","저장 안 함","취소"])
      assert.equal(await leave.getByRole("button",{name:action,exact:true}).count(),1,
        context + " missing " + action);
  };
  const mockState = () => navPage.evaluate(() => window.__navSaved());
  // Client: Cancel keeps the draft, Discard keeps DB unchanged, Save persists it.
  await navPage.goto(url);
  await navMenu.getByRole("button",{name:"거래처 관리"}).click();
  await navPage.locator(".client-table tbody tr").filter({hasText:"검증악기"}).first().click();
  const clientModal = navPage.getByRole("dialog",{name:"거래처 상세 관리"});
  const clientAddress = clientModal.getByRole("textbox",{name:"거래처 주소"});
  const originalAddress = await clientAddress.inputValue();
  await clientAddress.fill("경기도 검증시 저장확인로 88");
  await clientModal.getByRole("button",{name:"취소",exact:true}).click();
  await checkPrompt("client");
  await leave.getByRole("button",{name:"취소",exact:true}).click();
  assert.equal(await clientAddress.inputValue(),"경기도 검증시 저장확인로 88");
  await clientModal.getByRole("button",{name:"취소",exact:true}).click();
  await leave.getByRole("button",{name:"저장 안 함"}).click();
  await clientModal.waitFor({state:"detached"});
  assert.equal((await mockState()).state.clients.find(c=>c.id==="ci-store-dealer").address,originalAddress);
  await navPage.locator(".client-table tbody tr").filter({hasText:"검증악기"}).first().click();
  await clientAddress.fill("경기도 검증시 저장확인로 89");
  await clientModal.getByRole("button",{name:"취소",exact:true}).click();
  await leave.getByRole("button",{name:"저장",exact:true}).click();
  await clientModal.waitFor({state:"detached"});
  assert.equal((await mockState()).state.clients.find(c=>c.id==="ci-store-dealer").address,"경기도 검증시 저장확인로 89");
  console.log("PASS: client detail Save / Discard / Cancel (actual React modal)");

  // Product: the existing product editor has the same three-choice leave guard.
  await navMenu.getByRole("button",{name:"상품 관리"}).click();
  const productRows=navPage.locator(".product-prices tbody tr");
  await productRows.first().getByRole("button",{name:"상세 관리"}).click();
  const productModal=navPage.getByRole("dialog",{name:"상품 상세 관리"});
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
  await navPage.evaluate(() => {
    const input = document.getElementById("provisional-notice-product-search");
    const manager = input?.closest(".fixed-manager");
    window.__noticeSearchProbe = { input, manager, events: [] };
    input?.addEventListener("input", () => window.__noticeSearchProbe.events.push({ value: input.value }));
  });
  await productSearch.fill("BD");
  const beforeSearchWait=await navPage.evaluate(() => ({
    value:document.getElementById("provisional-notice-product-search")?.value,
    events:window.__noticeSearchProbe.events,
  }));
  await navPage.waitForTimeout(350);
  const afterSearchWait=await navPage.evaluate(() => ({
    value:document.getElementById("provisional-notice-product-search")?.value,
    inputConnected:window.__noticeSearchProbe.input.isConnected,
    sameInput:window.__noticeSearchProbe.input===document.getElementById("provisional-notice-product-search"),
    managerConnected:window.__noticeSearchProbe.manager.isConnected,
    sameManager:window.__noticeSearchProbe.manager===document.getElementById("provisional-notice-product-search")?.closest(".fixed-manager"),
    events:window.__noticeSearchProbe.events,
  }));
  console.log("NOTICE_SEARCH_TRACE",JSON.stringify({beforeSearchWait,afterSearchWait}));
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
  assert.deepEqual(navErrors,[],"Navigation React errors: "+navErrors.join("\n"));
  await navPage.close();
  assert.deepEqual(pageErrors, [], "React runtime errors: " + pageErrors.join("\n"));
  console.log("PASS: audit UI, docking, STORE, official URL, isolated developer tests and real Modal (mock IPC)");
} finally {
  if (browser) await browser.close();
  server.kill("SIGTERM");
}
