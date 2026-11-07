import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const read = (path) => readFileSync(new URL("../"+path,import.meta.url),"utf8");

test("export history opens by ID via Rust, not from a frontend-provided path",()=>{
  const workflow=read("src/WorkflowQueue.tsx");
  const bridge=read("src/tauri-bridge.ts");
  const rust=read("src-tauri/src/lib.rs");
  const module=read("src-tauri/src/export_file.rs");
  assert.match(workflow,/window\.bando!\.openExportFile\(e\.id\)/);
  assert.match(workflow,/파일 경로 복사/);
  assert.match(bridge,/openExportFile: \(id\) => invoke<void>\("open_export_file", \{ id \}\)/);
  assert.match(rust,/fn open_export_file\(db: State<'_, Database>, id: String\)/);
  assert.match(rust,/export_file::resolve_export_path\(&snapshot, &id\)/);
  assert.match(rust,/open_export_file, factory_conflict::approve_factory_conflict/);
  assert.match(module,/record\["savedPath"\]/);
  assert.match(module,/fs::canonicalize\(file\)/);
  assert.match(module,/magic != b"PK/);
  assert.match(module,/opens_only_recorded_existing_excel_file_and_rejects_unknown_ids/);
  assert.match(module,/rejects_missing_misnamed_non_xlsx_or_invalid_archives/);
  assert.doesNotMatch(bridge,/open_export_file", \{ (?:path|savedPath)/);
});

test("browser smoke exercises the export history Open command",()=>{
  const smoke=read("scripts/receipt-audit-ui-smoke.mjs");
  assert.match(smoke,/name: "엑셀 작성 이력"/);
  assert.match(smoke,/name: "파일 열기"/);
  assert.match(smoke,/__lastOpenedExportId === "ci-open-export"/);
});
