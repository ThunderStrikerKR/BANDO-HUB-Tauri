import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { tsImport } from "tsx/esm/api";
const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const seed = () => JSON.parse(read("src-tauri/resources/state-seed.json"));
const functions = await tsImport("../src/developer/backup-restore-drill.ts", import.meta.url);
const archive = [{ id: "receipt:historical", orderId: "order-historical",
  record: { original: "과거 주문", at: "2026-11-07T00:00:00Z" } }];
const stamp = "2026-11-08T11:00:00.000Z";
const token = "ci-standalone-backup";

test("TEST drill creates a full valid confirmation and dedicated delivery event without touching seed", () => {
  const original = seed();
  const pristine = JSON.stringify(original);
  const candidate = functions.buildDrillMutation(original, token, stamp);
  assert.equal(JSON.stringify(original), pristine, "fixture must not modify original TEST DB snapshot");
  assert.equal(candidate.next.orders.length, original.orders.length + 1);
  assert.equal(candidate.next.clients.length, original.clients.length + 1);
  assert.equal(candidate.next.aliases.length, original.aliases.length + 2);
  assert.equal(candidate.next.revision, original.revision);
  assert.equal(candidate.testPrice, candidate.previousPrice + 137);
  const order = candidate.next.orders.at(-1);
  assert.equal(order.confirmedAt, stamp);
  assert.equal(order.receptionVersion, 1);
  assert.equal(order.confirmationSnapshot.at, order.confirmedAt);
  assert.equal(order.confirmationSnapshot.raw, order.raw);
  assert.equal(order.confirmationSnapshot.data.id, order.id);
  assert.deepEqual(order.confirmationSnapshot.recipients, order.recipients);
  assert.deepEqual(order.confirmationSnapshot.data.recipients, order.recipients);
  assert.equal(order.receipt.original, order.raw);
  assert.equal(order.receipt.at, stamp);
  assert.equal(order.confirmationSnapshot.client.id, order.clientId);
  assert.ok(candidate.next.workflow.shipments.some((s) =>
    s.orderId === order.id && s.recipientId === order.recipients[0].id && s.step === 1));
  assert.ok(candidate.next.workflow.events.some((e) =>
    e.action === "주문 확인 완료" &&
    e.shipmentIds.some((id) => id.endsWith("-shipment") && id.startsWith("backup-drill-"))));
  assert.ok(!candidate.next.workflow.queue.some((q) => q.shipmentId?.startsWith("backup-drill-")),
    "synthetic receipt must never be added to a factory or courier export queue");
  const checks = functions.verifyDrillMutation(candidate.next, candidate);
  assert.equal(checks.length, 4);
  assert.ok(checks.every((check) => check.passed), checks);
});

test("TEST drill detects complete restoration even though native backup restore increases revision", () => {
  const original = seed();
  const scenario = functions.buildDrillMutation(original, token, stamp);
  const changed = structuredClone(scenario.next);
  changed.revision = (original.revision ?? 0) + 1;
  const restored = structuredClone(original);
  restored.revision = changed.revision + 1;
  const results = functions.verifyDrillRestore(original, restored, archive,
    structuredClone(archive), scenario, changed.revision);
  assert.ok(results.every((result) => result.passed), results);
  const corrupted = structuredClone(restored);
  corrupted.products[0].variants[0].retail += 1;
  const bad = functions.verifyDrillRestore(original, corrupted, archive,
    structuredClone(archive), scenario, changed.revision);
  assert.equal(bad[0].passed, false);
  assert.equal(bad[1].passed, false);
  const missingAudit = functions.verifyDrillRestore(original, restored, archive,
    [], scenario, changed.revision);
  assert.equal(missingAudit.find((r) => r.label === "접수 감사 기록 복원").passed, false);
  const staleRevision = functions.verifyDrillRestore(original, { ...restored, revision: 0 },
    archive, archive, scenario, changed.revision);
  assert.equal(staleRevision.find((r) => r.label === "복원 후 리비전 증가").passed, false);
});

test("full comparison includes aliases, clients, orders, prices, workflow and settings", () => {
  const original = seed();
  const master = functions.comparableState(original);
  const edits = [
    (s) => { s.aliases.push({ id:"fake",clientId:null,text:"시험",productId:"unknown" }); },
    (s) => { s.clients.push({ id:"fake",name:"시험 거래처" }); },
    (s) => { s.orders.push({ id:"fake",recipients:[] }); },
    (s) => { s.products[0].variants[0].retail = 9999; },
    (s) => { s.workflow.events.push({ action:"시험" }); },
    (s) => { s.settings.operatorName = "변경된 직원"; },
  ];
  for (const change of edits) {
    const copy = structuredClone(original);
    change(copy);
    assert.notEqual(functions.comparableState(copy), master);
  }
  const copy = structuredClone(original);
  copy.revision = 501;
  assert.equal(functions.comparableState(copy), master);
  assert.throws(() => functions.buildDrillMutation(original, "../unsafe",stamp),/검증 ID/);
});

test("guided UI performs actual backup/list/save/restore API with TEST process and confirmation guards", () => {
  const host = read("src/TestDatabasePanel.tsx");
  const ui = read("src/developer/BackupRestoreDrill.tsx");
  const bridge = read("src/tauri-bridge.ts");
  const native = read("src-tauri/src/backup_manager.rs");
  assert.match(host, /<BackupRestoreDrill onRestored=\{onReset\}/);
  assert.match(host, /if \(!preview\?\.enabled\)/);
  assert.match(ui, /if \(!window\.bando\?\.isTestWorkspace\)/);
  assert.match(ui, /await native\.backup\(\)/);
  assert.match(ui, /await native\.backups\(\)/);
  assert.match(ui, /await native\.save\(sample\.next\)/);
  assert.match(ui, /await native\.restore\(baseline\.filename\)/);
  assert.match(ui, /await native\.receiptArchive\(\)/);
  assert.match(ui, /await confirmAction\(/);
  assert.match(ui, /comparableState\(current\) !== comparableState\(baseline\.before\)/);
  assert.match(ui, /live\.revision !== changed\.revision/);
  for (const op of ["backup_create","backup_list","backup_restore","state_save","receipt_archive"]) {
    assert.ok(bridge.includes('"'+op+'"'),op);
  }
  assert.match(native, /fn restore_selected\(/);
  assert.match(native, /copy_entire_db\(&backup, conn\)\?/);
  assert.match(native, /\"pre-restore\"/);
  assert.match(native, /validate_database\(conn\)/);
  assert.match(native, /복원을 취소하고 직전 상태로 되돌렸습니다/);
});
