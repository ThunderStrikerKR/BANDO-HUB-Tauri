/** Persisted first-edit billing snapshots: real TS oracle against compiled Rust.
 * React keeps typed drafts synchronous; only Rust may freeze the historical
 * amount, linked client and original recipient data before SQLite save.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tsImport } from "tsx/esm/api";

const { billingSnapshot } = await tsImport("../../../src/replies.ts", import.meta.url);
const root = fileURLToPath(new URL("../../../", import.meta.url));
const manifest = fileURLToPath(new URL("./Cargo.toml", import.meta.url));
const now = "2026-11-15T01:00:00.000Z";
const copy = (value) => structuredClone(value);
const client = () => ({
  id: "c1", name: "악기사", displayName: "악기사",
  address: "서울 종로구 1", phone: "02-1234-5678", mobile: "",
  tier: "wholesale", payment: "PREPAID", overrides: {}, shippingFeeExcluded: false,
});
const oldOrder = () => ({
  id: "o1", clientId: "c1", clientSnapshot: client(), raw: "가상 주문",
  orderType: "DEALER", pricesLocked: true,
  createdAt: now, updatedAt: now, freightCode: "010",
  shippingFee: 3000, vatAmount: 0, applyVat: false,
  status: "NOTIFIED", paid: false, notified: true, postpaidApproved: false,
  recipients: [{
    id: "r1", name: "김민수", address: "서울 종로구 종로 1",
    mobile: "010-0000-0000", phone: "", note: "",
    items: [{
      id: "i1", productId: "p1", variantId: "v1", name: "BD 709",
      quantity: 2, unitPrice: 50000, color: "Black", origin: "FACTORY",
      quantityConfirmed: true, issues: [],
    }],
  }],
});
const state = () => ({
  revision: 3, clients: [client()], products: [],
  orders: [oldOrder()], queue: [], exports: [],
  settings: { accounts: [], operatorName: "직원" },
  workflow: {
    sources: [], groups: [], shipments: [], queue: [],
    payments: [], events: [], confirmations: [], deliveries: [], changeRequests: [],
  },
});
const scenarios = [];
function scenario(label, change = () => {}) {
  const before = state();
  const proposed = copy(before);
  const edited = proposed.orders[0];
  edited.recipients[0].items[0].quantity = 4;
  edited.pricesLocked = false;
  edited.notified = false;
  edited.status = "REVIEW";
  edited.pendingBillingSnapshot = {
    at: now, reason: "수취인 / 배송 정보 수정", activeGroupId: null,
  };
  change(before, proposed);
  const output = copy(proposed);
  const original = before.orders.find((item) => item.id === edited.id);
  const pending = output.orders[0].pendingBillingSnapshot;
  delete output.orders[0].pendingBillingSnapshot;
  if (original?.pricesLocked && pending && !pending.activeGroupId &&
      !(before.workflow?.shipments ?? []).some((ship) =>
        ship.orderId === original.id && !ship.legacyArchived)) {
    const snapshot = billingSnapshot(original, before, pending.reason);
    snapshot.at = pending.at;
    output.orders[0].billingHistory = [
      ...(output.orders[0].billingHistory ?? []), snapshot,
    ];
  }
  scenarios.push({
    label, operation: "finalize_billing_history",
    payload: { before, state: proposed }, expected: { ok: true, value: { state: output } },
  });
}
scenario("saved locked order old total and old recipients, not changed quantity");
scenario("existing history preserved", (before, proposed) => {
  const prior = billingSnapshot(before.orders[0], before, "과거 변경");
  prior.at = "2026-10-01T00:00:00.000Z";
  before.orders[0].billingHistory = [prior];
  proposed.orders[0].billingHistory = [copy(prior)];
});
scenario("active shipment blocks automatic standalone invoice history", (before) => {
  before.workflow.shipments = [{
    id: "s1", orderId: "o1", recipientId: "r1", legacyArchived: false,
  }];
});
scenario("archived shipment does not prevent standalone invoice snapshot", (before) => {
  before.workflow.shipments = [{
    id: "s1", orderId: "o1", recipientId: "r1", legacyArchived: true,
  }];
});
scenario("active group ID suppresses standalone historical snapshot", (_, proposed) => {
  proposed.orders[0].pendingBillingSnapshot.activeGroupId = "group-1";
});
scenario("already unlocked order never re-freezes old amounts", (before) => {
  before.orders[0].pricesLocked = false;
});
scenario("save-order can relock edited draft before commit", (_, proposed) => {
  proposed.orders[0].pricesLocked = true;
});
scenario("no marker never creates a historical entry", (_, proposed) => {
  delete proposed.orders[0].pendingBillingSnapshot;
});
scenario("unconfirmed new reception marker cannot create historical invoice", (before, proposed) => {
  before.orders = [];
});

test("native commit-time historical invoice matches original TS snapshot and guard semantics", () => {
  const result = spawnSync("cargo", [
    "run", "--quiet", "--manifest-path", manifest, "--bin", "parity_runner",
  ], {
    cwd: root, input: JSON.stringify(scenarios), encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024, timeout: 240000,
  });
  assert.equal(result.status, 0, result.stderr);
  const actual = JSON.parse(result.stdout);
  assert.equal(actual.length, scenarios.length);
  actual.forEach((entry, index) =>
    assert.deepStrictEqual(entry, scenarios[index].expected, scenarios[index].label));
});
