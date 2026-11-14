import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const read = p => readFileSync(new URL("../" + p, import.meta.url), "utf8");

test("factory history and notification both use native review and conflict projection", () => {
  const history = read("src/FactoryReplyHistory.tsx");
  const notices = read("src/FactoryNotifications.tsx");
  const native = read("src/native-factory-conflict-review.ts");
  const rules = read("src-tauri/src/business_core/rules/factory_reply.rs");
  assert.match(history,/factory_reply_review_statuses/);
  assert.match(history,/nativeFactoryConflictConfirmation\(state, id, row\)/);
  assert.match(notices,/nativeFactoryConflictConfirmation\(state, record.id, row.row\)/);
  assert.match(native,/"rules", "factory_conflict_confirmation"/);
  assert.match(rules,/fn resolved_row\(state:&Value,record:&Value,row:&Value\)/);
  assert.doesNotMatch(history,/replyNeedsReview\(/);
  assert.doesNotMatch(history,/factoryConflictConfirmation\(/);
  assert.doesNotMatch(notices,/(?<!native)factoryConflictConfirmation\(/);
  assert.match(history,/statuses\?\.\[r.id\]\?\.needsReview === false \? "반영 완료" : "확인 중"/);
});

test("product-freight display and reset do not compute current rule in TS", () => {
  const panel = read("src/ProductFreightPanel.tsx");
  const shipping = read("src-tauri/src/business_core/rules/shipping.rs");
  assert.match(panel,/action: "product_freight_view", state/);
  assert.match(panel,/action: "default_product_rule"/);
  assert.match(panel,/action: "reset_product_freight_rule", state/);
  assert.doesNotMatch(panel,/effectiveShippingRule\(/);
  assert.doesNotMatch(panel,/editableShippingRule\(/);
  assert.doesNotMatch(panel,/emptyProductRule\(/);
  assert.match(shipping,/"product_freight_view" =>/);
  assert.match(shipping,/"reset_product_freight_rule" =>/);
  assert.match(shipping,/group_reset_keeps_historical_rate_and_unrelated_orders/);
});

test("catalog item construction in item editor and retail intake is native owned", () => {
  for(const name of ["src/OrderItemEditor.tsx", "src/orders/RetailOrderDialog.tsx"]){
    const source = read(name);
    assert.match(source,/"rules", "create_catalog_item"/,name);
    assert.doesNotMatch(source,/itemFromProduct\(/,name);
  }
  const catalog = read("src-tauri/src/business_core/rules/catalog_item.rs");
  assert.match(catalog,/pub\(super\) fn make\(payload:&Value\)/);
});

test("product-specific message notices are validated by Rust before settings patch and backup", () => {
  const manager = read("src/ProvisionalProductNoticeManager.tsx");
  const core = read("src-tauri/src/business_core/rules/message_template_validation.rs");
  const parity = read("tests/rust-migration/rules/parity/compare.mts");
  assert.match(manager,/"rules", "validate_provisional_product_notices"/);
  assert.doesNotMatch(manager,/validateProvisionalProductNotices\(/);
  assert.ok(manager.indexOf('"validate_provisional_product_notices"') <
    manager.indexOf("await window.bando.backup()"));
  assert.match(core,/pub\(super\) fn validate_provisional/);
  assert.match(parity,/provisional notice validation: /);
});
