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

test("shipping manager reads editable tariff and current combination from Rust", () => {
  const manager = read("src/ShippingManager.tsx");
  const router = read("src-tauri/src/business_core/rules/mod.rs");
  assert.match(manager, /"rules", "shipping_manager_view"/);
  assert.match(manager, /currentView\?\.currentCombinations\[c\.id\]/);
  assert.match(manager, /currentView\?\.editableRules\[g\.id\]/);
  assert.doesNotMatch(manager, /\bcombinationCurrent\(/);
  assert.doesNotMatch(manager, /\beditableShippingRule\(/);
  assert.match(router, /"shipping_manager_view" => shipping::shipping_manager_view/);
});
test("factory alerts and corrections never show stale TS-calculated statuses", () => {
  const notifications = read("src/FactoryNotifications.tsx");
  const correction = read("src/CorrectionPanel.tsx");
  assert.match(notifications, /"rules", "factory_reply_review_statuses"/);
  assert.doesNotMatch(notifications, /\breplyNeedsReview\(/);
  assert.match(notifications, /nativeReview\?\.state === state/);
  assert.match(correction, /action: "correction_view", state, shipmentId: sid/);
  assert.doesNotMatch(correction, /\bcorrectionMessage\(/);
  assert.doesNotMatch(correction, /\bcorrectionStatus\(/);
  assert.match(correction, /nativeView\?\.state === state/);
});
test("automatic message template validation is native before backup or SQLite patch", () => {
  const editor = read("src/AutomaticMessageTemplateManager.tsx");
  const native = read("src-tauri/src/business_core/rules/message_template_validation.rs");
  const parity = read("tests/rust-migration/rules/parity/compare.mts");
  assert.match(editor, /"rules", "validate_automatic_templates"/);
  assert.doesNotMatch(editor, /\bvalidateAutomaticMessageTemplates\(/);
  assert.ok(editor.indexOf('"validate_automatic_templates"') < editor.indexOf("window.bando.backup()"));
  assert.ok(editor.indexOf("window.bando.backup()") < editor.indexOf("window.bando.patchSettings("));
  assert.match(native, /text\.encode_utf16\(\)\.count\(\)>2000/);
  assert.match(parity, /message template validation: /);
});

test("selected catalog items in reception and correction come from Rust", () => {
  const desk = read("src/orders/useOrderDesk.tsx");
  const correction = read("src/CorrectionPanel.tsx");
  const router = read("src-tauri/src/business_core/rules/mod.rs");
  const parity = read("tests/rust-migration/rules/parity/compare.mts");
  for (const source of [desk, correction]) {
    assert.match(source, /"rules", "create_catalog_item"/);
    assert.doesNotMatch(source, /\bitemFromProduct\(/);
  }
  assert.match(desk, /quantity: currentQuantity/);
  assert.match(correction, /quantity: item\.quantity/);
  assert.match(router, /"create_catalog_item" => catalog_item::make/);
  assert.match(parity, /catalog item: /);
  assert.match(parity, /itemFromProduct\(p,c,color,quantity,vid\)/);
});
