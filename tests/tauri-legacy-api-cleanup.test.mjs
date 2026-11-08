import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL("../" + path, import.meta.url), "utf8");

test("unmounted Electron-era workbook and registration API members are removed", () => {
  const bridge = read("src/tauri-bridge.ts");
  const types = read("src/types.ts");
  const old = [
    "registrationTemplate", "registrationPreview", "registrationCommit",
    "registrationResults", "exportExcel", "downloadSheet",
    "previewSheet", "approveSheet", "approveCatalog",
  ];
  for (const name of old) {
    assert.doesNotMatch(bridge, new RegExp("\\b" + name + "\\s*:"),
      "stale bridge method: " + name);
    assert.doesNotMatch(types, new RegExp("\\b" + name + "\\s*:"),
      "stale API method type: " + name);
  }
  const ui = read("src/ManagementUI.tsx");
  assert.doesNotMatch(ui, /export function BulkTools\(/);
  assert.doesNotMatch(ui, /window\.bando!\.(downloadSheet|previewSheet|approveSheet)\(/);
});

test("actively used product, dealer and freight workbook paths remain available", () => {
  const manager = read("src/ProductManager.tsx");
  const dealer = read("src/ClientManager.tsx");
  const registration = read("src/RegistrationManager.tsx");
  const productWorkbook = read("src/ProductSyncWorkbookTools.tsx");
  const clientWorkbook = read("src/ClientWorkbookTools.tsx");
  const factory = read("src/WorkflowQueue.tsx");
  const bridge = read("src/tauri-bridge.ts");
  const rust = read("src-tauri/src/lib.rs");
  const api = read("src/types.ts");
  assert.match(manager, /<RegistrationManager state=\{state\}/);
  assert.match(manager, /<ProductSyncWorkbookTools onSave=\{onSave\}/);
  assert.match(dealer, /<ClientWorkbookTools onSave=\{onSave\}/);
  assert.match(registration, /previewRegistrationWorkbook\(current, file\)/);
  assert.match(registration, /prepareRegistrationCommit\(current, preview/);
  assert.match(productWorkbook, /saveProductSyncWorkbook/);
  assert.match(clientWorkbook, /saveClientWorkbook/);
  assert.match(factory, /saveFactoryWorkbook\(bytes\)/);
  for (const [method, command] of [
    ["saveProductSyncWorkbook", "save_product_sync_workbook"],
    ["saveClientWorkbook", "save_client_workbook"],
    ["saveFactoryWorkbook", "save_factory_workbook"],
    ["saveRegistrationWorkbook", "save_registration_workbook"],
  ]) {
    assert.ok(bridge.includes(method + ":"), method);
    assert.ok(bridge.includes('"' + command + '"'), command);
    assert.ok(api.includes(method + "?:"), method + " API type");
    assert.ok(rust.includes(command), command);
  }
});

test("planned mobile bridge stays explicit; unsafe legacy catalog approval remains rejected natively", () => {
  const bridge = read("src/tauri-bridge.ts");
  const api = read("src/types.ts");
  const mobile = read("src/app/MobilePanel.tsx");
  const native = read("src-tauri/src/lib.rs");
  for (const method of ["mobileStart", "mobileStop", "mobileStatus", "inbox"]) {
    assert.match(bridge, new RegExp("\\b" + method + ":"));
    assert.match(api, new RegExp("\\b" + method + ":"));
  }
  assert.match(mobile, /window\.bando!\.mobileStart\(\)/);
  assert.match(bridge, /notReady\("스마트폰 연동"\)/);
  assert.match(native, /fn catalog_approve\(_db: State<'_, Database>\)/);
  assert.match(native, /이전 방식의 일괄 승인은 안전하지 않아 중지/);
});
