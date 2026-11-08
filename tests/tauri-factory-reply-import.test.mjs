import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { File } from "node:buffer";
import vm from "node:vm";
import ts from "typescript";
import ExcelJS from "exceljs";
import { webcrypto } from "node:crypto";
import { createRequire } from "node:module";

const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const nodeRequire = createRequire(import.meta.url);
const modules = new Map();
function load(path) {
  if (modules.has(path)) return modules.get(path);
  const output = {};
  modules.set(path, output);
  const source = ts.transpileModule(read("src/" + path + ".ts"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
  const execute = vm.runInThisContext(
    "(function(exports, require, crypto, structuredClone) {\n" + source + "\n})",
    { filename: path + ".ts" },
  );
  execute(output, (name) => {
    if (name.startsWith("./")) return load(name.slice(2).replace(/\.js$/, ""));
    return nodeRequire(name);
  }, webcrypto, structuredClone);
  return output;
}
const { parseFactoryReplyWorkbook, previewFactoryReply, applyFactoryReplyPreview,
  approveFactoryReplyRow } = load("factory-reply-workbook");

function stateFixture() {
  const recipient = {
    id: "r1", name: "박수하", address: "서울 서초구 123", phone: "02-1234-5678",
    mobile: "010-2222-4444", note: "", items: [
      { id: "item1", origin: "FACTORY", quantity: 2, name: "BD 709" },
    ],
  };
  const sender = { id: "dealer", name: "예시악기", address: "경기도 김포시 34",
    phone: "031-500-2000", mobile: "" };
  const queue = { id: "excel:s1:FACTORY", shipmentId: "s1", origin: "FACTORY",
    status: "EXPORTED", snapshot: { recipient, sender, freightCode: "010",
      total: 80000, shipping: 4000, vat: 0, subtotal: 76000 } };
  return {
    revision: 5, products: [], clients: [sender], aliases: [], queue: [], exports: [],
    orders: [{ id: "order1", recipients: [recipient], clientId: "dealer" }],
    settings: { operatorName: "매장 직원", accounts: [] }, factoryReplies: [],
    workflow: {
      queue: [queue], shipments: [{ id: "s1", recipientId: "r1", orderId: "order1",
        tracking: {}, actualFreight: {}, transferred: true, step: 4 }],
      events: [], payments: [], deliveries: [], sources: [], groups: [], changeRequests: [],
    },
  };
}
const headers = [
  "수하인명", "수하인우편번호", "수하인주소", "수하인전화번호", "수하인핸드폰번호",
  "택배수량", "택배운임", "운임구분", "품목명", "", "메시지", "송하인명",
  "(송)우편", "(송)주소1", "(송)전화", "(송)핸드폰", "운송장번호",
];
async function workbookFile(rows, name = "공장회신.xlsx", customHeaders = headers) {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet("로젠");
  sheet.addRow(customHeaders);
  rows.forEach((row) => sheet.addRow(row));
  const bytes = await book.xlsx.writeBuffer();
  return new File([Buffer.from(bytes)], name, {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}
const goodRow = (tracking = "001234567891", freight = "4,000") =>
  ["박수하", "", "서울 서초구 123", "02-1234-5678", "010-2222-4444",
    "1", freight, "010", "BD 709", "", "", "예시악기", "", "경기도 김포시 34",
    "031-500-2000", "", tracking];

test("real Logen XLSX Q waybill and G freight are parsed; approved data updates only factory shipment", async () => {
  const s = stateFixture();
  const original = JSON.stringify(s);
  const file = await workbookFile([goodRow()]);
  const preview = await parseFactoryReplyWorkbook(s, file);
  assert.equal(preview.applied, 1);
  assert.equal(preview.held, 0);
  assert.equal(preview.rows[0].tracking, "001234567891");
  assert.equal(preview.rows[0].actual, 4000);
  assert.equal(preview.rows[0].shipmentId, "s1");
  assert.match(preview.reply.id, /^factory-reply-[0-9a-f]{64}$/);
  const { next } = applyFactoryReplyPreview(s, preview);
  assert.equal(next.workflow.shipments[0].tracking.FACTORY, "001234567891");
  assert.equal(next.workflow.shipments[0].actualFreight.FACTORY, 4000);
  assert.equal(next.factoryReplies[0].status, "APPLIED");
  assert.ok(next.workflow.events.some((event) => event.action === "공장 회신 반영"));
  assert.equal(JSON.stringify(s), original);
  assert.throws(() => previewFactoryReply(next, preview.reply), /이미 등록된 동일/);
});

test("real Logen XLSX: address mismatch is held without mutating an unrelated shipment", async () => {
  const s = stateFixture();
  const row = goodRow();
  row[2] = "서울 다른 구 999";
  const preview = await parseFactoryReplyWorkbook(s, await workbookFile([row]));
  assert.equal(preview.applied, 0);
  assert.equal(preview.held, 1);
  assert.match(preview.rows[0].issue, /일치하는 공장 발송/);
  const { next } = applyFactoryReplyPreview(s, preview);
  assert.equal(next.workflow.shipments[0].tracking.FACTORY, undefined);
  assert.equal(next.factoryReplies[0].status, "REVIEW");
});

test("real Logen XLSX: every row sharing Q tracking number is held", async () => {
  const s = stateFixture();
  const preview = await parseFactoryReplyWorkbook(s, await workbookFile([goodRow(), goodRow()]));
  assert.equal(preview.applied, 0);
  assert.equal(preview.held, 2);
  assert.ok(preview.rows.every((r) => r.issue?.includes("운송장번호가 중복")));
});

test("real Logen XLSX: changed tracking and actual freight require individual conflict approval", async () => {
  const s = stateFixture();
  const first = await parseFactoryReplyWorkbook(s, await workbookFile([goodRow()]));
  const prior = applyFactoryReplyPreview(s, first).next;
  prior.revision = 6;
  const second = await parseFactoryReplyWorkbook(prior, await workbookFile([
    goodRow("009988776655", "5,000"),
  ]));
  assert.equal(second.applied, 0);
  assert.equal(second.held, 1);
  assert.match(second.rows[0].issue, /충돌/);
  const held = applyFactoryReplyPreview(prior, second).next;
  assert.equal(held.workflow.shipments[0].tracking.FACTORY, "001234567891");
  assert.equal(held.workflow.shipments[0].actualFreight.FACTORY, 4000);
  const corrected = approveFactoryReplyRow(held, second.reply.id, 2);
  assert.equal(corrected.workflow.shipments[0].tracking.FACTORY, "009988776655");
  assert.equal(corrected.workflow.shipments[0].actualFreight.FACTORY, 5000);
  assert.ok(!corrected.factoryReplies[1].rows[0].applied);
  assert.equal(corrected.factoryReplies[2].resolves.id, second.reply.id);
  assert.ok(corrected.workflow.events.some((e) => e.before?.tracking === "001234567891"));
  assert.throws(() => approveFactoryReplyRow(corrected, second.reply.id, 2), /이미 정정된/);
});

test("a waybill already bound to a different shipment cannot be reused even by conflict approval", async () => {
  const s = stateFixture();
  s.workflow.shipments.push({id:"s2", recipientId:"r2", orderId:"order2",
    transferred:true, step:4, tracking:{FACTORY:"001234567891"}, actualFreight:{}});
  const preview = await parseFactoryReplyWorkbook(s, await workbookFile([goodRow()]));
  assert.equal(preview.applied, 0);
  assert.match(preview.rows[0].issue, /다른 배송 건/);
});

test("old DB revisions, duplicate file identity and formula cells are rejected", async () => {
  const s = stateFixture();
  const file = await workbookFile([goodRow()]);
  const preview = await parseFactoryReplyWorkbook(s, file);
  assert.throws(() => applyFactoryReplyPreview({ ...s, revision: 6 }, preview), /DB가 수정/);
  const applied = applyFactoryReplyPreview(s, preview).next;
  await assert.rejects(() => parseFactoryReplyWorkbook(applied, file), /이미 등록된 동일/);
  const book = new ExcelJS.Workbook();
  book.addWorksheet("로젠").addRow(headers);
  book.worksheets[0].addRow(goodRow());
  book.worksheets[0].getCell("Q2").value = { formula: "1+1", result: 2 };
  const buf = await book.xlsx.writeBuffer();
  const bad = new File([Buffer.from(buf)], "formula.xlsx");
  await assert.rejects(() => parseFactoryReplyWorkbook(s,bad), /수식이나 병합/);
});

test("numeric tracking loses leading-zero guarantee and must be rejected", async () => {
  const s=stateFixture();
  const row=goodRow();
  row[16]=12345678901;
  const file = await workbookFile([row]);
  await assert.rejects(
    () => parseFactoryReplyWorkbook(s, file),
    /텍스트 셀로 입력하세요/,
  );
});

test("unrecognized 15-column export without the Q return column is rejected explicitly", async () => {
  const s=stateFixture();
  const file = await workbookFile([goodRow().slice(0,15)],
    "출력양식.xlsx",headers.slice(0,15));
  await assert.rejects(
    () => parseFactoryReplyWorkbook(s, file),
    /Q열/,
  );
});

test("native archive and conflict UI are wired with backup and review, not legacy notReady", () => {
  const bridge = read("src/tauri-bridge.ts");
  const rust = read("src-tauri/src/lib.rs");
  const ui = read("src/FactoryReplyImport.tsx");
  const history = read("src/FactoryReplyHistory.tsx");
  const queue = read("src/WorkflowQueue.tsx");
  const notification = read("src/FactoryNotifications.tsx");
  assert.match(rust,/fn archive_factory_reply/);
  assert.match(rust,/fn open_factory_reply_file/);
  assert.match(rust,/Sha256::digest/);
  assert.match(bridge,/archiveFactoryReply: \(id, bytes\)/);
  assert.match(bridge,/openFactoryFile: \(id\) => invoke<void>/);
  assert.match(ui,/applyFactoryReplyPreview\(latest, review\)/);
  assert.match(ui,/await api\.backup\(\)/);
  assert.match(ui,/await api\.archiveFactoryReply/);
  assert.match(ui,/await onSave\(next\)/);
  assert.match(queue,/<FactoryReplyImport onSave=\{onSave\}/);
  assert.match(history,/approveFactoryConflict\(id, row, state\.revision \?\? 0\)/);
  assert.match(bridge,/invoke<void>\("approve_factory_conflict"/);
  assert.match(rust,/factory_conflict::approve_factory_conflict/);
  assert.match(notification,/window\.bando\.approveFactoryConflict/);
});


test("different XLSX files with already-applied identical waybill and postage are idempotent", async () => {
  const state = stateFixture();
  const first = await parseFactoryReplyWorkbook(state, await workbookFile([goodRow()]));
  const afterFirst = applyFactoryReplyPreview(state, first).next;
  afterFirst.revision = 6;
  const repeatRow = goodRow();
  repeatRow[10] = "같은 결과 재회신"; // distinct file bytes, same delivery identity and values
  const second = await parseFactoryReplyWorkbook(afterFirst, await workbookFile([repeatRow]));
  assert.equal(second.applied, 1);
  const beforeEvents = afterFirst.workflow.events.length;
  const result = applyFactoryReplyPreview(afterFirst, second).next;
  assert.equal(result.workflow.events.length, beforeEvents);
  assert.equal(result.factoryReplies.length, 2);
  assert.equal(result.workflow.shipments[0].tracking.FACTORY, "001234567891");
  assert.equal(result.workflow.shipments[0].actualFreight.FACTORY, 4000);
});

test("nonstandard Logen headers, filled J column, or extra R data reject entire workbook", async () => {
  const state = stateFixture();
  for (const [column, wrong] of [[3, "수하인전화"], [4, "수하인핸드폰"],
    [9, "메시지"], [10, "송하인명"], [16, "송장번호"]]) {
    const bad = [...headers];
    bad[column] = wrong;
    await assert.rejects(
      () => parseFactoryReplyWorkbook(state, await workbookFile([goodRow()], "bad.xlsx", bad)),
      /양식 불일치/,
    );
  }
  const nonblankJ = goodRow();
  nonblankJ[9] = "임의 데이터";
  await assert.rejects(
    () => parseFactoryReplyWorkbook(state, await workbookFile([nonblankJ])),
    /J열은 공백/,
  );
  const extraHeaders = [...headers, "추가 열"];
  await assert.rejects(
    () => parseFactoryReplyWorkbook(state, await workbookFile([goodRow()], "extra.xlsx", extraHeaders)),
    /추가 열 제목/,
  );
  const extraData = [...goodRow(), "추가 데이터"];
  await assert.rejects(
    () => parseFactoryReplyWorkbook(state, await workbookFile([extraData])),
    /추가 데이터/,
  );
});
