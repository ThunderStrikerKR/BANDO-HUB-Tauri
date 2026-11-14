import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
test("native state_save returns the committed snapshot including revision", () => {
  const source=read("src-tauri/src/lib.rs");
  const block=source.slice(source.indexOf("fn state_save("),source.indexOf("fn canonical_color_key("));
  assert.match(block,/-> Result<Value, String>/);
  assert.match(block,/write_snapshot\(&mut \*lock_db\(&db\)\?, state, revision, true\)/);
  assert.doesNotMatch(block,/Ok\(\(\)\)/);
  const bridge=read("src/tauri-bridge.ts");
  const save=bridge.match(/save: \(state\) => \{([\s\S]*?)\n  \},/)?.[1] ?? "";
  assert.match(save,/return invoke<State>\("state_save", \{ state \}\)/);
  assert.match(save,/auditNativeCall\("state_save"\)/);
});
test("common commit and workflow selection use the authoritative write response", () => {
  const source=read("src/app/useAppModel.ts");
  assert.match(source,/const committed = await window\.bando!\.save\(persistent\)/);
  assert.match(source,/lastCommitted\.current = committed/);
  assert.match(source,/await refresh\(committed\)/);
  assert.match(source,/const loaded = lastCommitted\.current!/);
  assert.doesNotMatch(source,/setState\(await window\.bando!\.load\(\)\)/);
});
test("direct price and settings updates apply the native response, not a reload", () => {
  const product=read("src/ProductManager.tsx");
  assert.match(product,/const committed = await window\.bando!\.setPrice/);
  assert.match(product,/await onRefresh\(committed\)/);
  for(const p of [
    "src/ColorGuidanceManager.tsx",
    "src/AutomaticMessageTemplateManager.tsx",
    "src/ProvisionalProductNoticeManager.tsx",
  ]) assert.match(read(p),/refreshAfterCommittedSave\(/);
  const refresh=read("src/shared/committed-state.ts");
  assert.match(refresh,/await refresh\(committed\)/);
  assert.match(refresh,/return true/);
  assert.match(refresh,/화면 갱신에 실패했습니다/);
});
test("bulk saves no longer re-read after the common commit", () => {
  for (const p of [
    "src/ClientWorkbookTools.tsx","src/ProductSyncWorkbookTools.tsx",
    "src/FactoryReplyImport.tsx","src/RegistrationManager.tsx",
    "src/ProductImports.tsx","src/ManagementUI.tsx","src/WorkflowQueue.tsx"
  ]) {
    assert.doesNotMatch(read(p),/await onSave\([^;]*\);\s*await onRefresh\(\)/);
  }
});
