import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { tsImport } from "tsx/esm/api";
const read = (path) => readFileSync(new URL("../" + path, import.meta.url), "utf8");

test("new draft and its temporary workflow rows are not persisted", async () => {
  const { persistedReceptionState } = await tsImport("../src/orders/reception.ts", import.meta.url);
  const initial = { orders: [], queue: [], workflow: {
    sources: [], shipments: [], groups: [], queue: [], payments: [], confirmations: [], events: []
  }};
  const proposal = structuredClone(initial);
  proposal.orders.push({ id: "draft", receptionVersion: 1, raw: "709 3개" });
  proposal.workflow.sources.push({ id: "s", orderId: "draft" });
  proposal.workflow.shipments.push({ id: "sh", orderId: "draft", sourceId: "s", groupId: "g" });
  proposal.workflow.groups.push({ id: "g", sourceId: "s" });
  const stored = persistedReceptionState(initial, proposal);
  assert.equal(stored.orders.length, 0);
  assert.equal(stored.workflow.sources.length, 0);
  assert.equal(stored.workflow.shipments.length, 0);
  assert.equal(stored.workflow.groups.length, 0);
  assert.equal(initial.orders.length, 0);
});

test("Rust archive uses transactional collision detection rather than ignore", () => {
  const source = read("src-tauri/src/lib.rs");
  assert.match(source, /SELECT order_id,record FROM receipt_archive WHERE id=/);
  assert.match(source, /stored_owner != order_id \|\| stored_record != record/);
  const transaction = source.slice(source.indexOf("fn write_snapshot("), source.indexOf("// Only modified/new brands"));
  assert.doesNotMatch(transaction, /INSERT OR IGNORE INTO receipt_archive/);
  assert.match(source, /tx\.commit\(\)/);
});

test("the audit screen distinguishes legacy references and shows the before/after diff", () => {
  const screen=read("src/ReceiptArchive.tsx");
  assert.match(screen, /독립 감사 미확인/);
  assert.match(screen, /정정 전 작업용 원문/);
  assert.match(screen, /정정 후 작업용 원문/);
  assert.match(screen, /확정 전 분석 초안은 감사 기록에 포함하지 않습니다/);
});

test("Tauri has a single atomic persistence path for receipts and corrections", () => {
  const rust = read("src-tauri/src/reception.rs");
  const bridge = read("src/tauri-bridge.ts");
  assert.match(rust,/fn validate_new_correction/);
  assert.match(rust,/new_archive_entries/);
  assert.match(bridge,/receiptArchive: \(\) => invoke/);
  assert.doesNotMatch(bridge,/captureReceipt: async \(\) => notReady/);
  assert.doesNotMatch(bridge,/recordReceiptCorrection: async \(\) => notReady/);
});
