import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
const read = p => readFileSync(new URL("../" + p,import.meta.url),"utf8");

test("all five management screens share nonstretching equal-width tabs",()=>{
  const css=read("src/styles/management-layout.css");
  for(const selector of [
    ".management-container .management-tabbar",
    ".management-container .settings-tab-list.management-tabbar .settings-tab",
    ".management-container .shipping-tabs.management-tabbar"
  ]) assert.ok(css.includes(selector));
  const block=css.split(".app-v03 .management-container .management-tabbar {")[1].split("}")[0];
  assert.ok(block.includes("display: inline-grid"));
  assert.ok(block.includes("grid-auto-flow: column"));
  assert.ok(block.includes("grid-auto-columns: minmax(max-content, 1fr)"));
  assert.ok(block.includes("width: max-content"));
  assert.ok(block.includes("max-width: 100%"));
  assert.ok(!block.includes("width: 100%"));
  assert.ok(block.includes("overflow-x: auto"));
  assert.ok(!css.includes("flex-basis: 125px"));
  for(const [path,selector] of [
    ["src/WorkflowQueue.tsx","workflow-queue-tabs management-tabbar"],
    ["src/ProductManager.tsx","product-subnav management-tabbar"],
    ["src/ClientManager.tsx","product-subnav management-tabbar"],
    ["src/ShippingManager.tsx","shipping-tabs management-tabbar"],
    ["src/app/SettingsView.tsx","settings-tab-list management-tabbar"],
  ]) assert.ok(read(path).includes(selector),path);
});

test("freight layout places title then tabs then counters and work content",()=>{
  const markup=read("src/ShippingManager.tsx");
  const title=markup.indexOf('title="운임 관리"');
  const tabs=markup.indexOf('className="shipping-tabs management-tabbar"');
  const stats=markup.indexOf('className="shipping-stats"');
  const content=markup.indexOf('tab === "products"');
  assert.ok(title>=0 && tabs>title && stats>tabs && content>stats);
});

test("factory and store export tabs show today's folder beside Excel creation, even without selection",()=>{
  const code=read("src/WorkflowQueue.tsx");
  assert.ok(code.includes('className="excel-footer-actions"'));
  assert.ok(code.includes('scope === "FACTORY" ? "FACTORY" : "STORE"'));
  assert.ok(code.includes("window.bando!.openDailyExcelDirectory"));
  assert.ok(code.includes("오늘 공장 Excel 폴더 열기"));
  assert.ok(code.includes("오늘 매장 Excel 폴더 열기"));
  assert.ok(code.includes("폴더 열기"));
  assert.ok(code.includes('disabled={busy || !chosen.length}'));
  const folder=code.indexOf("window.bando!.openDailyExcelDirectory");
  const footer=code.indexOf('className="excel-footer-actions"');
  assert.ok(folder>footer);
  assert.ok(!code.slice(folder-180,folder).includes("!chosen.length"));
});

test("native opener validates fixed kinds and uses the same dated archive as saver",()=>{
  const rust=read("src-tauri/src/lib.rs");
  const native=rust.split("fn open_daily_excel_directory(")[1].split("\n}")[0];
  assert.ok(native.includes('"FACTORY" => WorkbookKind::Factory'));
  assert.ok(native.includes('"STORE" => WorkbookKind::Store'));
  assert.ok(native.includes('workspace_excel_directory(&db, &state["settings"])'));
  assert.ok(native.includes("archive_daily_directory(&root, workbook_kind, Local::now())"));
  assert.ok(rust.includes("open_excel_directory, open_daily_excel_directory"));
  assert.ok(read("src/tauri-bridge.ts").includes('invoke<void>("open_daily_excel_directory", { kind })'));
  assert.ok(read("src/types.ts").includes('openDailyExcelDirectory: (kind: "FACTORY" | "STORE")'));
});
