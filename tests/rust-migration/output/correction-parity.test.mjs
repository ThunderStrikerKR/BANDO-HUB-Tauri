/** Executable original TypeScript versus production Rust correction copy/status.
 * A static function-name search cannot prove message equality.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tsImport } from "tsx/esm/api";

const { correctionStatus, correctionMessage } =
  await tsImport("../../../src/corrections.ts", import.meta.url);
const root = fileURLToPath(new URL("../../../", import.meta.url));
const manifest = fileURLToPath(new URL("./Cargo.toml", import.meta.url));
const base = () => ({
  workflow: {
    events: [],
    shipments: [{ id: "ship-1", charges: { FACTORY: 3000, STORE: 2500 } }],
    changeRequests: [{
      id: "request-1", shipmentId: "ship-1",
      at: "2026-11-14T10:00:00+09:00", actor: "직원",
      beforeRecipient: {
        id: "recipient-1", name: "김민수", address: "서울 종로구 1",
        mobile: "", phone: "02-1234-5678", note: "", freightCode: "010",
        items: [{ id: "item-1", name: "BD 709", color: "Black", quantity: 1 }],
      },
      afterRecipient: {
        id: "recipient-1", name: "김민수", address: "서울 종로구 1",
        mobile: "", phone: "02-1234-5678", note: "", freightCode: "010",
        items: [{ id: "item-1", name: "BD 709", color: "Black", quantity: 1 }],
      },
    }],
  },
});
const cases = [];
function add(label, mutate = () => {}) {
  const state = base();
  mutate(state);
  const shipmentId = "ship-1";
  const baseline = state.workflow.changeRequests
    .filter((request) => request.shipmentId === shipmentId)
    .map((request) => ({
      id: request.id,
      status: correctionStatus(state, request.id),
      text: request.afterRecipient
        ? correctionMessage(state, request.id) : null,
    }));
  cases.push({
    label, operation: "render_correction_summaries",
    payload: { state, shipmentId }, baseline,
  });
}
add("unchanged request");
add("address and mobile changed", (state) => {
  const after = state.workflow.changeRequests[0].afterRecipient;
  after.address = "경기 의정부시 시민로 2";
  after.mobile = "010-1234-0000";
});
add("name phone note and freight code changed", (state) => {
  const after = state.workflow.changeRequests[0].afterRecipient;
  after.name = "김희수"; after.phone = ""; after.note = "문 앞";
  after.freightCode = "020";
});
add("changed products and normalized BD display", (state) => {
  const after = state.workflow.changeRequests[0].afterRecipient;
  after.items = [{
    id: "item-1", name: "[가상] BD 709-1", color: "Wine", quantity: 2,
  }, {
    id: "item-2", name: "BD 800", color: "Black", quantity: 1,
  }];
});
add("freight changes from shipment defaults and explicit old value", (state) => {
  const req = state.workflow.changeRequests[0];
  req.beforeRecipient.shippingCharges = { FACTORY: 4000, STORE: 2000 };
  req.afterRecipient.shippingCharges = { FACTORY: 5000, STORE: 3000 };
});
add("no fake change when null freight inherits original", (state) => {
  const req = state.workflow.changeRequests[0];
  req.beforeRecipient.shippingCharges = { FACTORY: null };
  req.afterRecipient.shippingCharges = { FACTORY: null };
});
add("newest status event wins", (state) => {
  state.workflow.events = [
    { action: "정정 요청 상태", before: "request-1", after: "REGISTERED" },
    { action: "정정 요청 상태", before: "different", after: "CONFIRMED" },
    { action: "정정 요청 상태", before: "request-1", after: "PENDING_FACTORY" },
  ];
});
add("two requests and legacy unstructured record", (state) => {
  state.workflow.changeRequests.push({
    id: "request-2", shipmentId: "ship-1",
    afterRecipient: null, text: "legacy factory correction",
  });
  state.workflow.changeRequests.push({
    id: "request-3", shipmentId: "other-shipment",
    afterRecipient: null, text: "other shipment",
  });
});
add("no correction requests", (state) => {
  state.workflow.changeRequests = [];
});

test("factory change-copy text and review status match original TypeScript via compiled Rust", () => {
  const execution = spawnSync("cargo", [
    "run", "--quiet", "--manifest-path", manifest, "--bin", "parity_runner",
  ], {
    cwd: root, input: JSON.stringify(cases), encoding: "utf8",
    timeout: 240000, maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(execution.status, 0, execution.stderr);
  const actual = JSON.parse(execution.stdout);
  assert.equal(actual.length, cases.length);
  actual.forEach((entry, index) => {
    const expected = cases[index];
    assert.equal(entry.ok, true, expected.label + ": " + entry.error);
    assert.deepStrictEqual(entry.value.records, expected.baseline, expected.label);
  });
});
