/** Actual TypeScript manual-apply oracle versus production compiled Rust.
 * The user-facing grid may stage typed text locally; only Rust commits the
 * final recipient assembly, source links, and employee issue decisions.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tsImport } from "tsx/esm/api";

const { applyManual } =
  await tsImport("../../../src/orders/manual-classification.ts", import.meta.url);
const root = fileURLToPath(new URL("../../../", import.meta.url));
const manifest = fileURLToPath(new URL("./Cargo.toml", import.meta.url));
const clone = structuredClone;
const baseOrder = () => ({
  id: "o1", clientId: "c1", raw: "김민수 BD 709 2개",
  orderType: "DEALER", channel: "카카오톡",
  createdAt: "2026-11-14T10:00:00Z",
  updatedAt: "2026-11-14T10:05:00Z",
  pricesLocked: true,
  recipients: [{
    id: "r1", name: "김민수", address: "서울 종로구 종로 1",
    mobile: "010-1234-5678", phone: "", note: "",
    unassignedEvidence: [{ start: 0, end: 3, kind: "name", text: "김민수" }],
    items: [{
      id: "i1", name: "BD 709", raw: "709", color: "Black",
      productId: "p1", variantId: "v1", origin: "STORE", quantity: 2,
      quantityConfirmed: true, unitPrice: 50000, manuallyConfirmed: true,
      issues: [], sources: [],
    }],
  }],
  status: "REVIEW", shippingFee: 3000,
  applyVat: false, vatAmount: 0, notified: false,
  paid: false, postpaidApproved: false, freightCode: "010",
});
const cases = [];
function add(label, change = () => {}) {
  const order = baseOrder();
  const model = { rows: clone(order.recipients), blocks: [], assignments: {} };
  change(order, model);
  let expected;
  try {
    expected = { ok: true, value: { order: applyManual(order, model) } };
  } catch (error) {
    expected = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  cases.push({
    label, operation: "apply_manual_classification",
    payload: { order, model, assignmentOrder: Object.keys(model.assignments) },
    expected,
  });
}
add("ordinary one-recipient manual completion");
add("previous customer issue decision is synchronized", (order) => {
  order.issueResolutions = { stale: {
    resolution: "UNRESOLVED", evidence: "잘못된 인식", updatedAt: "2026-11-01",
  }};
});
add("name assignment reconstructs original span", (_, model) => {
  model.blocks = [{
    id: "0:3", start: 0, end: 3, text: "김민수",
    field: "name", targetId: "r1",
  }];
  model.assignments["0:3"] = {
    recipientId: "r1", field: "name", value: "김민수",
  };
});
add("two ordered assignments to same item retain insertion order", (_, model) => {
  model.blocks = [
    { id: "4:10", start: 4, end: 10, text: "BD 709", field: "product", targetId: "i1" },
    { id: "11:13", start: 11, end: 13, text: "2개", field: "quantity", targetId: "i1" },
  ];
  model.assignments["11:13"] = {
    recipientId: "r1", itemId: "i1", field: "quantity", value: "2",
  };
  model.assignments["4:10"] = {
    recipientId: "r1", itemId: "i1", field: "product", value: "BD 709",
  };
});
add("existing analysis raw and manual source ownership preserved", (order, model) => {
  order.analysisRaw = "변경된 원문";
  order.manualClassification = { blocks: [], assignments: {} };
  model.rows[0].sources = [{
    start: 0, end: 3, field: "name", targetId: "r1", text: "김민수",
  }];
});
add("quantity missing blocks approval", (_, model) => {
  model.rows[0].items[0].quantity = null;
  model.rows[0].items[0].quantityConfirmed = false;
});
add("quantity unconfirmed blocks approval", (_, model) => {
  model.rows[0].items[0].quantityConfirmed = false;
});
add("zero quantity blocks approval", (_, model) => {
  model.rows[0].items[0].quantity = 0;
});
add("zero recipient rows blocks approval", (_, model) => {
  model.rows = [];
});
add("already-confirmed order cannot be manually reclassified", (order) => {
  order.confirmedAt = "2026-11-14T10:30:00Z";
});
add("two recipients with independent item sources", (_, model) => {
  const r = clone(model.rows[0]);
  r.id = "r2";r.name = "이가상";
  r.items[0].id = "i2";
  model.rows.push(r);
});
test("Rust final manual classification and issue decisions match original TypeScript", () => {
  const result = spawnSync("cargo", [
    "run", "--quiet", "--manifest-path", manifest, "--bin", "parity_runner",
  ], {
    cwd: root, input: JSON.stringify(cases), encoding: "utf8",
    timeout: 240000, maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr);
  const actual = JSON.parse(result.stdout);
  assert.equal(actual.length, cases.length);
  actual.forEach((entry, index) =>
    assert.deepStrictEqual(entry, cases[index].expected, cases[index].label));
});
