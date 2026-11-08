import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { setTimeout as pause } from "node:timers/promises";
import { chromium } from "playwright";

// All state is synthetic or a cloned catalog seed. No real native database or
// external shipment, payment, official site, or file operation is permitted.
const state = JSON.parse(readFileSync(new URL("../src-tauri/resources/state-seed.json", import.meta.url), "utf8"));
state.settings.factoryReplyDirectory = "";
const client = {
  id: "ci-ui-dealer-20261109",
  name: "UI 검증 거래처",
  displayName: "UI 검증 거래처",
  address: "경기도 가상시 테스트로 101",
  phone: "031-0000-0000",
  mobile: "",
  contact: "031-0000-0000",
  tier: "retail",
  payment: "PREPAID",
  shippingFeeExcluded: false,
  active: true,
  identifiers: "",
  overrides: {},
};
state.clients.push(client);
const wheelIncluded = state.products.find((p) => p.siteId === "136" && p.name.includes("바퀴 포함"));
const wheelExcluded = state.products.find((p) => p.siteId === "136" && p.name.includes("바퀴 미포함"));
assert.ok(wheelIncluded && wheelExcluded, "Both wheel configurations must be independently registered");
const unresolved = structuredClone(wheelIncluded);
unresolved.id = "ci-unresolved-ui-product";
unresolved.code = "BD UI-999";
unresolved.name = "BD UI-999 / 판매 구성 미확정";
unresolved.variants[0].id = "ci-unresolved-price";
unresolved.requiresOption = true;
unresolved.saleUnit = false;
unresolved.siteId = "ci-unresolved-ui";
unresolved.originalName = "가상 미확정 상품";
state.products.push(unresolved);
const raw = [
  "BD Z-2 바퀴 포함 2개",
  "김민수",
  "서울특별시 강남구 테헤란로 123",
  "010-1234-5678",
].join("\n");
const server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1"], {
  cwd: new URL("../", import.meta.url), stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
server.stdout.on("data", chunk => output += chunk.toString());
server.stderr.on("data", chunk => output += chunk.toString());
let browser;
try {
  let ready = false;
  for (let n = 0; n < 80; n++) {
    if (server.exitCode !== null) throw Error("Vite exited: " + output);
    try { if ((await fetch("http://127.0.0.1:5173/", {signal: AbortSignal.timeout(1200)})).ok) { ready = true; break; } }
    catch {}
    await pause(500);
  }
  assert.ok(ready, "Vite never started: " + output);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({viewport:{width:1640,height:1040}});
  page.setDefaultTimeout(14000);
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.addInitScript(({state,raw}) => {
    const mockState = structuredClone(state);
    window.__ciCalls = [];
    window.__TAURI_INTERNALS__ = {
      invoke: async (command, args) => {
        window.__ciCalls.push(command);
        switch (command) {
          case "workspace_mode": return false;
          case "startup_status": return {phase:"READY", error:null, attempts:1, databaseMs:10, readyMs:20, isTest:false};
          case "startup_metrics": return {windowShownMs:null, databaseMs:10, dataMs:null, readyMs:20};
          case "state_load": return structuredClone(mockState);
          case "clipboard_read": return raw;
          case "dock_status_native": return {active:false, mode:"ORIGINAL", ratio:0.8};
          case "dock_windows_native": return [];
          case "dock_region_native": return undefined;
          case "receipt_archive": return [];
          // Native writes are forbidden in this click test; the working order
          // should remain in React draft state until explicitly confirmed.
          case "state_save": throw Error("UI smoke test forbids native state changes");
          default: throw Error("Unexpected native action during isolated UI test: " + command);
        }
      },
    };
  }, {state,raw});

  await page.goto("http://127.0.0.1:5173/");
  await page.getByRole("button", {name:"대리발송",exact:true}).click();
  await page.getByText("BD Z-2 바퀴 포함 2개", {exact:false}).first().waitFor();

  // UI01: choose a synthetic dealer through the real dealer picker.
  await page.getByRole("button", {name:"거래처 찾기",exact:true}).click();
  const chooser = page.getByRole("dialog", {name:"거래처 변경"});
  await chooser.getByRole("textbox", {name:"거래처 변경 검색"}).fill("UI 검증 거래처");
  await chooser.locator("button.client-result").filter({hasText:"UI 검증 거래처"}).first().click();
  await chooser.waitFor({state:"detached"});
  const row = page.locator(".compact-items tbody tr[data-item-id]").first();
  await row.waitFor();
  await row.getByRole("button", {name:/상품 수정.*Z-2.*바퀴 포함/}).waitFor();
  console.log("PASS UI01: source paste, dealer selection, independently recognized wheel-included row");

  // UI02: edit the real row and use the nested ProductSearchDialog.
  await row.getByRole("button", {name:/상품 수정.*Z-2.*바퀴 포함/}).click();
  const editor = page.getByRole("dialog", {name:"상품 상세 수정"});
  await editor.waitFor();
  assert.equal(await editor.getByRole("spinbutton", {name:"수량"}).inputValue(), "2");
  await editor.getByRole("button", {name:"상품 변경"}).click();
  const search = page.getByRole("dialog", {name:"상품 검색"});
  await search.getByRole("textbox", {name:"추가 상품 검색"}).fill("Z-2");
  await search.locator(".product-search-results article button").filter({hasText:"Z-2 / 바퀴 미포함"}).first().click();
  await search.waitFor({state:"detached"});
  assert.equal(await editor.getByRole("spinbutton", {name:"수량"}).inputValue(), "2");
  assert.equal(await editor.getByRole("textbox", {name:"적용 가격"}).inputValue(), wheelExcluded.variants[0].retail.toLocaleString("ko-KR"));
  await editor.getByRole("button", {name:"적용",exact:true}).click();
  await editor.waitFor({state:"detached"});
  await row.getByRole("button", {name:/상품 수정.*Z-2.*바퀴 미포함/}).waitFor();
  await row.getByRole("button", {name: new RegExp((wheelExcluded.variants[0].retail * 2).toLocaleString("ko-KR"))}).waitFor();
  console.log("PASS UI02: nested search selects excluded-wheels product; correct price, quantity and row after Apply");

  // UI03: cancelling a change does not alter the order.
  await row.getByRole("button", {name:/상품 수정.*Z-2.*바퀴 미포함/}).click();
  await editor.getByRole("button", {name:"상품 변경"}).click();
  await search.getByRole("textbox", {name:"추가 상품 검색"}).fill("Z-2");
  await search.locator(".product-search-results article button").filter({hasText:"Z-2 / 바퀴 포함"}).first().click();
  await search.waitFor({state:"detached"});
  await editor.getByRole("button", {name:"취소",exact:true}).click();
  await editor.waitFor({state:"detached"});
  await row.getByRole("button", {name:/상품 수정.*Z-2.*바퀴 미포함/}).waitFor();
  console.log("PASS UI03: cancellation preserves previous selected product and price");

  // UI05: adding a second independent product creates a separate order row
  // rather than a selectable nested price option under the first product.
  await page.locator(".recipient-row-actions button").filter({hasText:"상품 추가"}).first().click();
  await search.getByRole("textbox", {name:"추가 상품 검색"}).fill("709-1");
  await search.locator(".product-search-results article button").filter({hasText:"709-1 / 블랙 / 비타공 상판"}).first().click();
  await search.waitFor({state:"detached"});
  const rows = page.locator(".compact-items tbody tr[data-item-id]");
  await rows.nth(1).waitFor();
  assert.equal(await rows.count(), 2);
  const second = rows.nth(1);
  await second.getByRole("button", {name:/상품 수정.*709-1.*비타공/}).click();
  await editor.getByRole("spinbutton", {name:"수량"}).fill("1");
  await editor.getByRole("button", {name:"적용",exact:true}).click();
  await editor.waitFor({state:"detached"});
  await second.getByRole("button", {name:/상품 수정.*709-1.*비타공/}).waitFor();
  console.log("PASS UI05: additional independent product creates its own editable order row");

  // UI04: the unresolved selection must surface an actionable warning
  // in the *visible* modal, rather than placing an alert behind the search.
  await row.getByRole("button", {name:/상품 수정.*Z-2.*바퀴 미포함/}).click();
  await editor.getByRole("button", {name:"상품 변경"}).click();
  await search.getByRole("textbox", {name:"추가 상품 검색"}).fill("UI-999");
  await search.locator(".product-search-results article button").filter({hasText:"UI-999"}).first().click();
  const warningState = await page.evaluate(() => {
    const editor = document.querySelector('dialog[aria-label="상품 상세 수정"]');
    const search = document.querySelector('dialog[aria-label="상품 검색"]');
    const alert = editor?.querySelector('[role="alert"]');
    return {editorOpen: Boolean(editor?.open), searchOpen: Boolean(search?.open),
      warningText: alert?.textContent?.trim() ?? "", alertVisible: Boolean(alert?.getClientRects().length)};
  });
  console.log("UI04 WARNING DIAGNOSTICS:", JSON.stringify(warningState));
  assert.deepEqual(errors, [], "React errors: " + errors.join("\n"));
  assert.ok(!await page.evaluate(() => window.__ciCalls.includes("state_save")), "No native writes");
  assert.ok(warningState.warningText.includes("상품 구성이 미확정"), "Warning text was not rendered");
  assert.ok(warningState.alertVisible && warningState.editorOpen && !warningState.searchOpen,
    "UI04 FAIL: warning rendered behind still-open product search; staff cannot see it");
  console.log("PASS UI04: unresolved product warning visible to employee");
} finally {
  if (browser) await browser.close();
  server.kill("SIGTERM");
}
