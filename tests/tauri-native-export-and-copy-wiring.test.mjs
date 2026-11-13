import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const read = path => readFileSync(new URL("../"+path,import.meta.url),"utf8");

test("both Save As workflows finalize exported ledger in native Rust",()=>{
  const view=read("src/WorkflowQueue.tsx");
  const adapter=read("src/native-export.ts");
  const dispatcher=read("src-tauri/src/business_core/output/mod.rs");
  const ledger=read("src-tauri/src/business_core/output/export_history.rs");
  assert.match(view,/await nativeFinalizeExport\(latest, "STORE", preview, savedPath\)/);
  assert.match(view,/await nativeFinalizeExport\(latest, "FACTORY", preview, savedPath\)/);
  assert.doesNotMatch(view,/(?:recordFactoryExportPrepared|recordStoreExportPrepared)\(/);
  assert.match(adapter,/"output", "finalize_export"/);
  assert.match(dispatcher,/"finalize_export" => export_history::finalize\(&payload\)/);
  assert.match(ledger,/super::export::prepare\(state,ids,origin\)/);
  assert.match(ledger,/if fresh\.get\("rows"\)!=preview\.get\("rows"\)/);
  assert.match(ledger,/entry\["status"\]=json!\("EXPORTED"\)/);
  assert.match(ledger,/entry\["fileOnly"\]=json!\(true\)/);
  assert.match(view,/await onSave\(result\.next\)/);
});
test("clipboard copy writes audit via Rust only after native clipboard succeeds",()=>{
  const view=read("src/MessageWorkspace.tsx");
  const adapter=read("src/native-message-audit.ts");
  const rules=read("src-tauri/src/business_core/rules/mod.rs");
  const audit=read("src-tauri/src/business_core/rules/message_audit.rs");
  assert.match(view,/await window\.bando!\.copy\(/);
  assert.match(view,/await onSave\(await nativeRecordMessageCopy\(/);
  assert.doesNotMatch(view,/\brecordCopy\(state,/);
  assert.match(adapter,/"rules", "record_message_copy"/);
  assert.match(adapter,/copyType === "PAYMENT" && signature === undefined/);
  assert.match(view,/automatic\?\.signature/);
  assert.doesNotMatch(adapter,/paymentSignature\(/);
  assert.match(rules,/"record_message_copy" => message_audit::record\(&payload\)/);
  assert.match(audit,/str_field\(field\(e,"after"\),"token"\)==token/);
  assert.match(audit,/!flag\(s,"legacyArchived"\)/);
});
