import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const read=(name)=>readFileSync(new URL("../"+name,import.meta.url),"utf8");
test("Excel folder picker and saved-folder opener are backed by native Tauri",()=>{
 const bridge=read("src/tauri-bridge.ts");
 const rust=read("src-tauri/src/lib.rs");
 const screen=read("src/SettingsPanel.tsx");
 for(const command of ["choose_excel_directory","open_excel_directory"]){
   assert.ok(bridge.includes('"'+command+'"'));
   assert.ok(rust.includes("fn "+command+"("));
   assert.match(rust,new RegExp("generate_handler!\\[[\\s\\S]*"+command));
 }
 assert.match(rust,/blocking_pick_folder\(\)/);
 assert.match(rust,/canonical_excel_directory\(&picked\)/);
 assert.match(rust,/saved_excel_directory\(&saved\["settings"\]\)/);
 assert.match(rust,/dialog = dialog\.set_directory\(path\)/);
 assert.match(rust,/let selected = dialog\.blocking_save_file\(\)/);
 assert.match(rust,/mod excel_folder_tests/);
 assert.match(screen,/공장 회신 폴더 지정은 가능하지만 자동 감지는 아직 지원하지 않습니다/);
 assert.match(screen,/저장된 폴더 열기/);
});
