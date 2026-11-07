import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const read = (path) => readFileSync(new URL("../" + path, import.meta.url), "utf8");
test("one native Excel archive directory for all five business categories",()=>{
  const rust=read("src-tauri/src/lib.rs"),ui=read("src/SettingsPanel.tsx");
  const bridge=read("src/tauri-bridge.ts");
  for(const cmd of ["choose_excel_directory","open_excel_directory"]){
    assert.match(bridge,new RegExp('"'+cmd+'"'));
    assert.match(rust,new RegExp("fn "+cmd+"\\("));
  }
  for(const cat of ["공장 발송","매장 발송","공장 회신","상품 관리","거래처 관리"]) assert.ok(rust.includes('"'+cat+'"'));
  assert.match(rust,/workspace_excel_directory\(&db, &state\["settings"\]\)\?/);
  assert.match(rust,/if db\.is_test/);
  assert.match(rust,/saved_excel_directory\(settings\)/);
  assert.match(rust,/fn archive_daily_directory/);
  assert.match(rust,/create_new\(true\)/);
  assert.match(rust,/archive_workbook_bytes\(&root, WorkbookKind::FactoryReply/);
  assert.match(rust,/WorkbookKind::Factory, bytes/);
  assert.match(rust,/WorkbookKind::Store, bytes/);
  assert.match(rust,/WorkbookKind::Product, bytes/);
  assert.match(rust,/WorkbookKind::Client, bytes/);
  assert.match(rust,/WorkbookKind::ProductTemplate, bytes/);
  assert.match(ui,/Excel 보관함 위치/);
  assert.match(ui,/공장 회신 자동 수신 폴더/);
  assert.match(ui,/수신 폴더 선택/);
  // Source monitoring is separate from the five-category output archive.
  const monitor=read("src-tauri/src/factory_reply_watch.rs");
  assert.match(monitor,/공장 회신 수신/);
  assert.match(monitor,/factoryReplyDirectory/);
});
