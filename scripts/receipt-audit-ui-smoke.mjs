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
          if (command === "state_load") return structuredClone(state);
          if (command === "backup_create") return "CI-SQLITE-BACKUP";
          if (command === "save_store_workbook") {
            if (!Array.isArray(args.bytes) || args.bytes.length <= 1000) throw Error("Invalid workbook bytes");
            window.__storeWorkbookSaved = args.bytes.slice(0, 4).join(",") === "80,75,3,4";
            return storePath;
          }
          if (command === "state_save") {
            state = structuredClone(args.state);
            state.revision = (state.revision ?? 0) + 1;
            window.__storeCommit = structuredClone(state.workflow.queue.find(
              (q) => q.id === "ci-store-queue"));
            return undefined;
          }
          if (command === "receipt_archive") return structuredClone(archive);
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
  const nav = page.getByRole("navigation", { name: "업무 메뉴" });
  await nav.getByRole("button", { name: "엑셀 관리" }).click();
  await page.getByRole("button", { name: "엑셀 작성 이력" }).click();
  const exportRow = page.getByRole("row").filter({ hasText: "BANDO-CI-EXCEL.xlsx" });
  await exportRow.getByRole("button", { name: "파일 열기", exact: true }).click();
  await page.waitForFunction(() => window.__lastOpenedExportId === "ci-open-export");
  await exportRow.getByRole("button", { name: "파일 경로 복사" }).waitFor();
  await nav.getByRole("button", { name: "설정" }).click();
  await page.getByRole("heading", { name: "Excel 보관함 위치" }).waitFor();
  await page.getByText("공장 발송, 매장 발송, 공장 회신, 상품 관리, 거래처 관리 폴더를 자동으로 구분합니다.").waitFor();
  await page.getByRole("button", { name: "보관함 폴더 선택", exact: true }).click();
  await page.getByText("C:\\BANDO_CI_SELECTED").waitFor();
  await page.getByRole("button", { name: "보관함 열기", exact: true }).click();
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
  assert.deepEqual(pageErrors, [], "React runtime errors: " + pageErrors.join("\n"));
  console.log("PASS: audit UI, KakaoTalk docking, STORE shipping, cached official URL picker (mock native IPC)");
} finally {
  if (browser) await browser.close();
  server.kill("SIGTERM");
}
