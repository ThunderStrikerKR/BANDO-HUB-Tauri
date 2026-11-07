import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { tsImport } from "tsx/esm/api";

const read=(file)=>readFileSync(new URL("../"+file, import.meta.url),"utf8");
const rust=read("src-tauri/src/lib.rs");
const native=read("src-tauri/src/developer_workspace.rs");
const bridge=read("src/tauri-bridge.ts");

test("developer workspace can only launch a second process with a separate SQLite root",()=>{
  assert.match(rust,/mod developer_workspace/);
  assert.match(rust,/is_test: bool/);
  assert.match(rust,/developer_workspace::open_isolated/);
  assert.match(native,/Command::new\(std::env::current_exe\(\)/);
  assert.match(native,/--bando-developer-test/);
  assert.match(native,/developer-test/);
  assert.match(native,/bando-hub-test\.sqlite/);
  assert.match(native,/SQLITE_OPEN_READ_ONLY/);
  assert.match(native,/clean_activity/);
  assert.match(native,/"orders", "clients", "aliases"/);
  assert.match(native,/snapshot\["workflow"\]/);
  assert.match(native,/snapshot\["revision"\] = json!\(0\)/);
  assert.match(native,/if !db\.is_test \{/);
  assert.match(native,/VACUUM INTO/);
  assert.match(native,/DELETE FROM receipt_archive/);
  assert.match(native,/DELETE FROM developer_test_runs/);
  assert.match(native,/fn isolated_clone_keeps_master_and_does_not_touch_production_state/);
  assert.match(native,/fn test_reset_preserves_prices_and_archives_old_audit_and_case_runs/);
});

test("native commands reject test-only operations on normal database and isolate file exports",()=>{
  for(const command of [
    "workspace_mode","open_test_workspace","test_database_preview",
    "reset_test_database","test_record_run","test_run_history"
  ]){
    assert.match(bridge,new RegExp('"'+command+'"'));
    assert.match(rust,new RegExp("developer_workspace::"+command));
  }
  assert.match(rust,/workspace_excel_directory/);
  assert.match(rust,/if db\.is_test/);
  assert.match(rust,/테스트 작업공간 Excel 보관함은 변경할 수 없습니다/);
  assert.match(native,/시험 결과는 격리된 작업공간에서만 저장합니다/);
  assert.match(native,/정식 업무 데이터베이스는 개발자 모드에서 초기화할 수 없습니다/);
  assert.match(native,/200/);
});

test("developer modal laboratory uses the existing dialog component and does not write orders",()=>{
  const lab=read("src/developer/DeveloperLab.tsx");
  const host=read("src/app/SettingsView.tsx");
  const entry=read("src/main.tsx");
  assert.match(lab,/import \{ Modal \} from "\.\.\/ui"/);
  assert.match(lab,/실제 공통 Modal/);
  for(const mode of ["NORMAL","EMPTY","ERROR","BUSY","LONG","WARNING","SUCCESS"]){
    assert.ok(lab.includes('"'+mode+'"'));
  }
  assert.match(lab,/if \(!api\?\.isTestWorkspace/);
  assert.match(host,/window\.bando\?\.isTestWorkspace &&/);
  assert.match(entry,/workspaceMode/);
  assert.match(lab,/testRecordRun/);
  assert.doesNotMatch(lab,/\.save\(/);
});

test("real receipt parser and actual issue rules find missing contact without modifying state",async()=>{
  const { inspectOrder, exampleRaw, developerCases } =
    await tsImport("../src/developer/scenarios.ts", import.meta.url);
  const state=JSON.parse(read("src-tauri/resources/state-seed.json"));
  const original=JSON.stringify(state);
  assert.ok(developerCases.length>=9);
  const raw=exampleRaw("missing-contact",state);
  const report=inspectOrder(state,"missing-contact",raw);
  assert.equal(report.scenario,"연락처 누락");
  assert.ok(report.detected.includes("CONTACT"),report.detected.join(","));
  assert.equal(report.passed,true);
  assert.equal(report.raw,raw);
  assert.equal(JSON.stringify(state),original);
  const repeat=inspectOrder(state,"duplicate-order",exampleRaw("duplicate-order",state));
  assert.equal(repeat.passed,false,"No test orders means no duplicate can be asserted");
  assert.ok(repeat.notes.some(x=>x.includes("동일 원문 주문이 격리 DB에 없습니다")));
  assert.throws(()=>inspectOrder(state,"custom",""),/1자 이상/);
  assert.equal(JSON.stringify(state),original);
});
