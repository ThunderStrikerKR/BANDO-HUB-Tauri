import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { tsImport } from "tsx/esm/api";

const { shouldRefreshUncommittedOrderPricing } =
  await tsImport("../src/orders/passive-pricing.ts", import.meta.url);
const { repriceOrder } = await tsImport("../src/domain.ts", import.meta.url);

const draft = (extra = {}) => ({
  id: "order-pricing-audit", confirmedAt: undefined, deletedAt: undefined,
  pricesLocked: false, raw: "CI 709 1개", shippingMode: "AUTO",
  shippingFee: 7500, shippingVersion: "historical-v1",
  recipients: [{ id: "recipient", name: "가상수취인", items: [
    { id: "item", productId: "product", variantId: "price", unitPrice: 13700, quantity: 1 },
  ] }],
  ...extra,
});

test("a saved legacy order must never passively adopt current master prices or freight", () => {
  const original = draft({ pricesLocked: false });
  const snapshot = structuredClone(original);
  const master = {
    products: [{ id: "product", variants: [{ id: "price", wholesale: 29000 }] }],
  };
  const dealer = { id: "dealer", tier: "wholesale", overrides: {} };
  const repriced = repriceOrder(original, dealer, master);
  assert.equal(repriced.recipients[0].items[0].unitPrice, 29000,
    "This fixture must be able to reproduce unintended repricing if unguarded");
  assert.equal(shouldRefreshUncommittedOrderPricing(original, [{ id: original.id }]), false);
  assert.deepEqual(original, snapshot, "Policy checks must never mutate snapshots");
  assert.equal(original.shippingFee, 7500);
  assert.equal(original.shippingVersion, "historical-v1");
});

test("a saved unconfirmed order and even an orphaned confirmed order are protected", () => {
  const order = draft();
  assert.equal(shouldRefreshUncommittedOrderPricing(order, [{ id: order.id }]), false);
  assert.equal(shouldRefreshUncommittedOrderPricing(draft({
    confirmedAt: "2026-11-01T00:00:00Z",
  }), []), false);
  assert.equal(shouldRefreshUncommittedOrderPricing(draft({
    pricesLocked: true,
  }), []), false);
  assert.equal(shouldRefreshUncommittedOrderPricing(draft({
    deletedAt: "2026-11-01T00:00:00Z",
  }), []), false);
});

test("new uncommitted reception follows master changes until finalized", () => {
  const unsaved = draft();
  assert.equal(shouldRefreshUncommittedOrderPricing(unsaved, []), true);
  assert.equal(shouldRefreshUncommittedOrderPricing(draft({
    id: "another-order",
  }), [{ id: "historical-order" }]), true);
});

test("native Rust pricing/shipping effects protect persisted records and explicit edits", () => {
  const source = readFileSync(new URL("../src/orders/useOrderDesk.tsx", import.meta.url), "utf8");
  const parts = source.split(/\n  useEffect\(\(\) => \{/);
  const priceEffect = parts.find((part) => part.includes('"rules", "reprice_order"'));
  const freightEffect = parts.find((part) => part.includes('"rules", "calculate_shipping"'));
  assert.ok(priceEffect, "New receptions must invoke the real Rust repricing engine");
  assert.ok(freightEffect, "Auto freight must invoke the real Rust shipping engine");
  assert.match(priceEffect, /!liveClient \|\| !passivePricingAllowed/);
  assert.match(freightEffect, /!passivePricingAllowed && !shippingPending/,
    "Saved orders may refresh freight only after a deliberate edit marked pending");
  for (const block of [priceEffect, freightEffect]) {
    assert.match(block, /shouldRefreshUncommittedOrderPricing\(previous, persisted\)/,
      "The latest draft must be rechecked before any async native result is applied");
    assert.match(block, /ruleRequests\.current/,
      "Out-of-order native responses must be rejected");
  }
  assert.match(source, /const edit = \([\s\S]*?next\.shippingFee = null;[\s\S]*?next\.shippingVersion = "";/,
    "Explicit staff edits must invalidate old freight until Rust recalculates it");
  assert.doesNotMatch(source, /recommendShipping\(previous, state\)/,
    "React must not silently revert to TypeScript tariff computation");
  const orderDesk = readFileSync(new URL("../src/OrderDesk.tsx", import.meta.url), "utf8");
  assert.match(orderDesk, /onDealer=\{async \(c\) => \{[\s\S]*?nativeRepriceEditedOrder\(/,
    "Dealer change must call the real Rust unit-price resolver");
  assert.match(orderDesk, /nativeReconcileWorkflow\(state, next\)/,
    "Saved dealer edits must run Rust workflow reconciliation");
});

test("preview order is not treated as persisted when backing storage has no such order", () => {
  const local = draft({ id:"local-preview" });
  const previewState = [local, { id:"persisted-another-order" }];
  const actualPersisted = [{ id:"persisted-another-order" }];
  assert.equal(shouldRefreshUncommittedOrderPricing(local, previewState), false,
    "The incorrect preview-based lookup would mark the draft as saved");
  assert.equal(shouldRefreshUncommittedOrderPricing(local, actualPersisted), true);
  const workspace=readFileSync(new URL("../src/HubWorkspace.tsx", import.meta.url),"utf8");
  assert.equal((workspace.match(/persistedOrders=\{state\.orders\}/g)??[]).length,2,
    "Both rendered order desks must use canonical persisted records");
});
