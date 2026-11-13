import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const source = (path) =>
  readFileSync(new URL("../" + path, import.meta.url), "utf8");
const adapter = source("src/orders/native-rules.ts");
const queue = source("src/WorkflowQueue.tsx");
const correction = source("src/CorrectionPanel.tsx");
const retail = source("src/orders/RetailOrderDialog.tsx");
const rustRules = source("src-tauri/src/business_core/rules/mod.rs");
const nativeCorrection = source("src-tauri/src/business_core/rules/correction_rules.rs");
const nativeRetail = source("src-tauri/src/business_core/rules/retail_operations.rs");

// These checks assert UI-to-IPC wiring, not runtime GUI behavior. All native
// business decisions are independently compared with real TS originals by
// tests/rust-migration/rules/parity/compare.mts (678-case differential suite).
test("factory delivery confirmation and re-export call Rust before SQLite save", () => {
  assert.match(queue, /await onSave\(await nativeApplyCorrectionAction\(state, "mark_factory_delivered", \{ shipmentId: q!\.shipmentId \}\)\)/);
  assert.match(queue, /await onSave\(await nativeApplyCorrectionAction\(state, "reopen_unsent_export", \{ shipmentId: q!\.shipmentId \}\)\)/);
  assert.doesNotMatch(queue, /await onSave\((?:markFactoryDelivered|reopenUnsentExport)\(/);
  assert.match(queue, /if \(!\(await confirmAction\("이 발송 파일을 실제 공장에 전달했나요\?/);
  assert.match(queue, /if \(!\(await confirmAction\("아직 공장에 전달하지 않은 출력본을 폐기하고 다시 작성할까요\?/);
});

test("post-export correction register, copy and staff approval call Rust", () => {
  for (const action of ["request_correction", "copied_correction", "confirm_correction"]) {
    assert.ok(correction.includes('nativeApplyCorrectionAction(state, "' + action + '"'), action);
    assert.ok(nativeCorrection.includes('"' + action + '"=>'), action + " Rust match arm");
  }
  assert.doesNotMatch(correction, /(?:requestCorrection|copiedCorrection|confirmCorrection)\(state,/);
  assert.match(correction, /await window\.bando!\.copy\(correctionMessage\(state, r\.id\)\)/);
  assert.match(correction, /await onSave\(await nativeApplyCorrectionAction\(state, "copied_correction"/);
});

test("native correction bridge injects audit IDs and validates workflow before save", () => {
  assert.match(adapter, /export async function nativeApplyCorrectionAction\(/);
  assert.match(adapter, /"rules", "apply_correction_action"/);
  assert.match(adapter, /ids: \[crypto\.randomUUID\(\), crypto\.randomUUID\(\), crypto\.randomUUID\(\)\]/);
  assert.match(adapter, /"rules", "validate_workflow", \{ state: updated, before: state \}/);
  assert.match(rustRules, /"apply_correction_action" => correction_rules::apply\(&payload\)/);
  for (const action of ["mark_factory_delivered", "reopen_unsent_export"]) {
    assert.ok(nativeCorrection.includes('"' + action + '"=>'), action + " Rust match arm");
  }
});

test("direct-entry retail confirm goes through the native reducer and preserves error guard", () => {
  assert.match(retail, /await onSave\(await nativeConfirmRetail\(state, order\)\)/);
  assert.doesNotMatch(retail, /await onSave\(confirmRetail\(/);
  assert.match(retail, /catch \(e\) \{\s*setError\(String\(e\)\)/);
  assert.match(adapter, /export async function nativeConfirmRetail\(/);
  assert.match(adapter, /"rules", "apply_retail_action"/);
  for (const key of ["receiptEventId", "processEventId", "reconcileEventIds", "processReconcileEventIds"]) {
    assert.ok(adapter.includes(key + ":"), key + " is supplied to native Rust");
  }
  assert.match(rustRules, /"apply_retail_action" => retail_operations::apply\(&payload\)/);
  assert.match(nativeRetail, /"confirm_retail"=>/);
});

test("customer-approved product resolution uses native Rust, not TS fallback", () => {
  const resolver = source("src/IssueResolver.tsx");
  const desk = source("src/OrderDesk.tsx");
  const nativeProduct = source("src-tauri/src/business_core/rules/product_confirmation.rs");
  assert.match(resolver, /const result = await nativeResolveProduct\(/);
  assert.doesNotMatch(resolver, /resolveProduct\(\s*state,/);
  assert.match(desk, /const result = await nativeConfirmProposedProduct\(state, draft, r\.id, i\.id\)/);
  assert.doesNotMatch(desk, /confirmProposedProduct\(state,/);
  assert.match(adapter, /"rules", "apply_product_action"/);
  assert.match(rustRules, /"apply_product_action" => product_confirmation::apply\(&payload\)/);
  assert.match(nativeProduct, /"resolve_product"=>resolve\(payload\)/);
  assert.match(nativeProduct, /"confirm_proposed_product"=>confirm\(payload\)/);
});

test("working raw correction previews using Rust recognition and the Rust audit reducer", () => {
  const modal = source("src/WorkingRawDialog.tsx");
  const nativeRaw = source("src-tauri/src/business_core/rules/raw_corrections.rs");
  assert.match(modal, /setPreview\(await nativeCorrectWorkingRaw\(state, order, text, reason\)\)/);
  assert.doesNotMatch(modal, /correctWorkingRaw\(state, order, text, reason\)/);
  assert.match(adapter, /"recognition", "analyze_order"/);
  assert.match(adapter, /assertRustReceptionAnalysis\(analyzed, text\)/);
  assert.match(adapter, /"rules", "apply_raw_correction"/);
  assert.match(adapter, /parsedRecipients: analyzed\.recipients/);
  assert.match(nativeRaw, /"correct_working_raw"=>/);
  assert.match(modal, /setPreview\(undefined\);\s*try \{/);
  assert.match(modal, /disabled=\{!preview \|\| busy\}/);
});
