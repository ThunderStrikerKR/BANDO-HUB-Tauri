import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const read = (path) => readFileSync(new URL("../" + path, import.meta.url), "utf8");

test("manual final application is Rust-owned and failure preserves draft", () => {
  const view = read("src/orders/ManualClassification.tsx");
  const router = read("src-tauri/src/business_core/rules/mod.rs");
  assert.match(view, /"rules", "apply_manual_classification"/);
  assert.match(view, /latestInputs\.current\.order !== submittedOrder/);
  assert.match(view, /latestInputs\.current\.model !== submittedModel/);
  assert.doesNotMatch(view, /\bapplyManual\(/);
  assert.match(router, /"apply_manual_classification" => manual_classification::apply/);
  const parity = read("tests/rust-migration/rules/parity/compare.mts");
  assert.match(parity, /manual classification: /);
  assert.match(parity, /order:applyManual\(o,m\)/);
});

test("historical billing snapshot uses first edit metadata and native saved original", () => {
  const editor = read("src/orders/useOrderDesk.tsx");
  const save = read("src-tauri/src/business_core/rules/order_save.rs");
  const types = read("src/types.ts");
  assert.doesNotMatch(editor, /\bbillingSnapshot\(/);
  assert.match(editor, /pendingBillingSnapshot = \{ at: new Date\(\)\.toISOString\(\), reason \}/);
  assert.match(save, /super::reply_rules::billing\(previous,state,reason,at\)/);
  assert.match(save, /remove\("pendingBillingSnapshot"\)/);
  assert.match(save, /!flag\(ship,"legacyArchived"\)/);
  assert.match(types, /pendingBillingSnapshot\?: \{ at: string; reason: string \}/);
  assert.match(read("tests/rust-migration/rules/order-save-parity.test.mjs"),
    /frozen history append preserves pre-existing snapshots/);
});
