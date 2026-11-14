import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL("../" + path, import.meta.url), "utf8");

test("all live factory review surfaces use the Rust resolver, never the TS review predicate", () => {
  const app = read("src/App.tsx");
  const history = read("src/FactoryReplyHistory.tsx");
  const notifications = read("src/FactoryNotifications.tsx");
  assert.doesNotMatch(app, /replyNeedsReview/);
  assert.doesNotMatch(history, /replyNeedsReview/);
  assert.match(app, /"factory_reply_review_statuses"/);
  assert.match(notifications, /"factory_reply_review_details"/);
  assert.doesNotMatch(notifications, /resolves\?\.id === record\.id/);
  assert.match(history, /"factory_reply_review_details"/);
  assert.match(history, /"상태 확인 중"/);
  assert.match(history, /resolved === false && !row\.applied/);
});

test("registered item creation in independent and retail order editors is native-owned", () => {
  const editor = read("src/OrderItemEditor.tsx");
  const retail = read("src/orders/RetailOrderDialog.tsx");
  const correction = read("src/CorrectionPanel.tsx");
  for (const source of [editor, retail, correction]) {
    assert.match(source, /"create_catalog_item"/);
    assert.doesNotMatch(source, /\bitemFromProduct\(/);
  }
  assert.match(retail, /quantityConfirmed: false, unitPrice: null/);
  assert.match(editor, /if \(!catalogItem\.variantId\)/);
});

test("product freight displays native effective and editable rules without TS status fallback", () => {
  const source = read("src/ProductFreightPanel.tsx");
  assert.match(source, /"product_freight_view"/);
  assert.match(source, /action: "start_new_rule"/);
  assert.doesNotMatch(source, /g\.history\.push\(g\.current\)/);
  assert.doesNotMatch(source, /\beffectiveShippingRule\(/);
  assert.doesNotMatch(source, /\beditableShippingRule\(/);
  assert.match(source, /nativeFreight\?\.state === state/);
});

test("automatic and provisional notice save validation uses Rust before native SQLite patch", () => {
  const template = read("src/AutomaticMessageTemplateManager.tsx");
  const provisional = read("src/ProvisionalProductNoticeManager.tsx");
  assert.match(template, /"validate_automatic_templates"/);
  assert.match(provisional, /"validate_provisional_notices"/);
  assert.doesNotMatch(provisional, /\bvalidateProvisionalProductNotices\(/);
  assert.ok(provisional.indexOf('"validate_provisional_notices"') < provisional.indexOf("await window.bando.backup()"));
  assert.ok(provisional.indexOf('"validate_provisional_notices"') < provisional.indexOf("await window.bando.patchSettings("));
});

test("Rust projections have source-TS differential fixtures, not just static wiring tests", () => {
  const parity = read("tests/rust-migration/rules/parity/compare.mts");
  assert.match(parity, /"factory review detail: "\+name/);
  assert.match(parity, /"product freight view: "\+name/);
  assert.match(parity, /"freight reset history: "\+name/);
  assert.match(parity, /"provisional notice validation: "\+name/);
  assert.match(parity, /\bvalidateProvisionalProductNotices\(state\)/);
  assert.match(parity, /\beffectiveShippingRule\(state,p\.id\)/);
  assert.match(parity, /\breplyNeedsReview\(state,record\)/);
});
