import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const read = path => readFileSync(new URL("../" + path, import.meta.url),"utf8");

test("factory Excel opens the saved folder only after a committed export", () => {
  const queue = read("src/WorkflowQueue.tsx");
  const start = queue.indexOf('const preview = await businessCoreCall<FactoryExportPreview>("output", "prepare_factory_export", { state: current, ids: chosen })');
  const end = queue.indexOf('scope === "STORE" ? "선택 "', start);
  assert.ok(start >= 0 && end > start);
  const factoryHandler = queue.slice(start,end);
  const persisted = factoryHandler.indexOf("await onSave(result.next)");
  const opened = factoryHandler.indexOf("await window.bando!.openExportDirectory(savedExportId)");
  assert.ok(persisted >= 0 && opened > persisted);
  assert.ok(factoryHandler.includes("savedExportId = result.exportId"));
  assert.ok(factoryHandler.includes("if (!savedPath) return"));
  assert.ok(factoryHandler.includes("onNotice("));
  assert.ok(factoryHandler.includes("폴더를 열지 못했습니다"));
  assert.ok(!factoryHandler.includes("openExcelDirectory()"));
});

test("native open-folder action accepts only a verified existing export ID", () => {
  const lib=read("src-tauri/src/lib.rs");
  const file=read("src-tauri/src/export_file.rs");
  const bridge=read("src/tauri-bridge.ts");
  const types=read("src/types.ts");
  assert.ok(lib.includes("fn open_export_directory(db: State<'_, Database>, id: String)"));
  assert.ok(lib.includes("export_file::resolve_export_directory(&snapshot, &id)"));
  assert.ok(lib.includes("open_export_directory, factory_conflict::approve_factory_conflict"));
  assert.ok(file.includes("let file = resolve_export_path(state, id)?"));
  assert.ok(file.includes("fs::canonicalize(parent)"));
  assert.ok(bridge.includes('invoke<void>("open_export_directory", { id })'));
  assert.ok(types.includes('openExportDirectory: (id: string) => Promise<void>'));
});

test("order management renders a single stage and no extra dispatch row",()=>{
  const view=read("src/app/OrderHistory.tsx");
  const logic=read("src/app/order-history.ts");
  assert.ok(view.includes("{row.status}"));
  assert.ok(!view.includes("dispatchState(state, row.order.id)"));
  for(const label of ["처리 중","엑셀 추출 대기","엑셀 추출 완료","공장 회신 완료"]){
    assert.ok(logic.includes('"'+label+'"'));
  }
  assert.ok(!logic.includes("엑셀 / 발송 목록 이관"));
});
