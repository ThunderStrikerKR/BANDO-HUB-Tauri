import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const read=(p)=>readFileSync(new URL("../"+p,import.meta.url),"utf8");
test("Tauri can save a store Excel independently of factory and only after preview",()=>{
 const bridge=read("src/tauri-bridge.ts"),rust=read("src-tauri/src/lib.rs");
 const types=read("src/types.ts"),ui=read("src/WorkflowQueue.tsx");
 assert.match(types,/saveStoreWorkbook\?:/);
 assert.match(bridge,/saveStoreWorkbook: \(bytes\) => invoke<string \| null>\("save_store_workbook", \{ bytes \}\)/);
 assert.match(rust,/async fn save_store_workbook\(/);
 // Store shipping now writes directly to the classified, day-based archive.
 assert.match(rust, /save_xlsx_in_archive\(app, WorkbookKind::Store, bytes\)/);
 assert.match(rust, /Self::Store => "매장 발송"/);
 assert.match(rust, /Self::Store => "매장"/);
 assert.match(rust, /fn archive_daily_directory/);
 assert.match(rust, /format!\("\{stamp\}\(\{\}\{number\}\)\.xlsx", kind\.stem\(\)\)/);
 assert.match(rust, /\.create_new\(true\)/);
 assert.match(rust,/save_factory_workbook, save_store_workbook, save_settlement_workbook/);
 assert.match(ui,/businessCoreCall<StoreExportPreview>\("output", "prepare_store_export", \{ state: current, ids: chosen \}\)/);
 assert.match(ui,/createStoreWorkbook\(preview\)/);
 assert.match(ui,/businessCoreCall<StoreExportPreview>\("output", "prepare_store_export", \{ state: latest, ids: preview.ids \}\)/);
 assert.match(ui,/recordStoreExportPrepared\(latest, preview, savedPath, fresh\)/);
 assert.match(ui,/saveStoreWorkbook\(bytes\)/);
 assert.match(ui,/선택 " \+ chosen.length \+ "건 매장 Excel 작성"/);
 assert.doesNotMatch(ui,/매장 Excel 출력 미이식/);
});
test("a printed store workbook stays pending until a separately confirmed shipment",()=>{
 const ui=read("src/WorkflowQueue.tsx"),work=read("src/workflow.ts");
 const corrections=read("src/corrections.ts"),model=read("src/store-export.ts");
 assert.match(ui,/q!\.origin === "STORE"/);
 assert.match(ui,/매장 발송 확인/);
 assert.match(ui,/nativeApplyWorkflowAction\(state, "mark_store_sent", \{ queueId: q!\.id \}\)/);
 const native=read("src-tauri/src/business_core/rules/workflow.rs");
 assert.match(native,/"mark_store_sent" =>/);
 // The native reducer must reject non-store or already completed queues.
 assert.match(native,/if str_field\(q,"origin"\)!="STORE" \|\| !\["QUEUED","EXPORTED"\]\.contains\(&status\)/);
 // An exported file is not sufficient unless it belongs to this queue entry.
 assert.match(native,/if status=="EXPORTED"/);
 assert.match(native,/해당 매장 Excel 출력 이력을 확인할 수 없습니다\./);
 // A separate staff confirmation marks the shipment as sent.
 assert.match(native,/set\(&mut state\["workflow"\]\["queue"\]\[qi\],"status",json!\("STORE_SENT"\)\)/);
 assert.match(native,/set\(&mut state\["workflow"\]\["queue"\]\[qi\],"fileOnly",json!\(false\)\)/);
 assert.ok(work.includes('!["QUEUED", "EXPORTED"].includes(q.status)'));
 assert.match(work,/q\.fileOnly = false/);
 assert.match(model,/entry\.status = "EXPORTED"/);
 assert.match(model,/entry\.fileOnly = true/);
 assert.match(corrections,/q\.origin === "STORE"/);
 assert.match(corrections,/매장 Excel 출력 또는 발송 이력/);
});
