import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import { createRequire } from "node:module";
import vm from "node:vm";
import ts from "typescript";
import ExcelJS from "exceljs";

const requireModule = createRequire(import.meta.url);
const read = (path) => readFileSync(new URL("../" + path, import.meta.url), "utf8");
const cache = new Map();
function load(name) {
  if (cache.has(name)) return cache.get(name);
  const exported = {};
  cache.set(name, exported);
  const transpiled = ts.transpileModule(read("src/" + name + ".ts"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
  const fn = vm.runInThisContext(
    "(function(exports, require, crypto, structuredClone){\n" + transpiled + "\n})",
    { filename: "src/" + name + ".ts" },
  );
  fn(exported, (name) => name.startsWith("./")
    ? load(name.slice(2).replace(/\.js$/, ""))
    : requireModule(name), webcrypto, structuredClone);
  return exported;
}
const {
  previewStoreExport, createStoreWorkbook, recordStoreExport,
} = load("store-export");
const { LOGEN_HEADERS } = load("factory-export");
function fixture() {
  const recipient = {
    id: "recipient-1", name: "김수취", address: "서울 강남구 123",
    phone: "", mobile: "010-0011-2233", note: "문 앞",
    items: [{
      id: "string-1", origin: "STORE", name: "기타줄", color: "블랙", quantity: 3,
    }],
  };
  const sender = {
    id: "dealer-1", name: "한빛악기", displayName: "한빛악기",
    address: "경기도 의정부시 12", postcode: "04506",
    phone: "031-1234-5678", mobile: "",
  };
  const shipment = {
    id: "shipment-1", orderId: "order-1", recipientId: recipient.id,
    transferred: true, step: 4,
  };
  return {
    revision: 3, products: [], clients: [sender],
    orders: [{ id: "order-1", clientId: sender.id,
      orderType: "AGENCY", recipients: [recipient] }],
    aliases: [], queue: [], exports: [], settings: { operatorName: "매장 직원" },
    workflow: {
      shipments: [shipment],
      queue: [{
        id: "store-queue-1", shipmentId: shipment.id, origin: "STORE",
        status: "QUEUED",
        snapshot: {
          recipient, sender, freightCode: "010",
          subtotal: 20000, shipping: 2500, vat: 0, total: 22500,
        },
      }],
      events: [],
    },
  };
}
test("real XLSX: store queue produces 15 Logen columns without guessing parcel count or postage", async () => {
  const state = fixture();
  const preview = previewStoreExport(state, ["store-queue-1"]);
  assert.equal(preview.rows.length, 1);
  assert.equal(preview.rows[0].values.length, LOGEN_HEADERS.length);
  const bytes = await createStoreWorkbook(preview);
  assert.deepEqual(bytes.slice(0, 4), [80, 75, 3, 4]);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(bytes));
  const sheet = workbook.getWorksheet("로젠택배");
  assert.ok(sheet);
  assert.equal(sheet.rowCount, 2);
  assert.deepEqual(sheet.getRow(1).values.slice(1), [...LOGEN_HEADERS]);
  const row = sheet.getRow(2);
  assert.equal(row.getCell(1).value, "김수취");
  assert.equal(row.getCell(5).value, "010-0011-2233");
  assert.equal(row.getCell(2).value, null); // Never guess consignee postcodes.
  assert.equal(row.getCell(6).value, null); // Parcel count is staff-entered.
  assert.equal(row.getCell(7).value, null); // Billed shipping != actual postage.
  assert.equal(row.getCell(8).value, "010");
  assert.equal(row.getCell(9).value, "기타줄 블랙 3개");
  assert.equal(row.getCell(10).value, "문 앞");
  assert.equal(row.getCell(11).value, "한빛악기"); // Proxy sender, never the hub.
  assert.equal(row.getCell(12).value, "04506");
  assert.equal(row.getCell(13).value, "경기도 의정부시 12");
  assert.equal(row.getCell(14).value, "031-1234-5678");
  assert.equal(JSON.stringify(state), JSON.stringify(fixture()));
});

test("store export logs an immutable snapshot without marking shipment as sent", () => {
  const state = fixture(), prior = structuredClone(state);
  const preview = previewStoreExport(state, ["store-queue-1"]);
  const { next, filename, exportId } = recordStoreExport(
    state, preview, "C:\\BANDO\\매장출고.xlsx",
  );
  assert.equal(JSON.stringify(state), JSON.stringify(prior));
  assert.equal(filename, "매장출고.xlsx");
  assert.equal(next.workflow.queue[0].status, "EXPORTED");
  assert.equal(next.workflow.queue[0].fileOnly, true);
  assert.equal(next.workflow.queue[0].exportId, exportId);
  assert.equal(next.exports[0].id, exportId);
  assert.equal(next.exports[0].queueEntryIds[0], "store-queue-1");
  assert.equal(next.exports[0].snapshots[0].snapshot.recipient.mobile, "010-0011-2233");
  assert.equal(next.workflow.events[0].action, "매장 발송 Excel 작성");
  assert.equal(next.workflow.queue[0].status === "STORE_SENT", false);
  assert.throws(() => previewStoreExport(next, ["store-queue-1"]), /대기 상태/);
  assert.throws(() => recordStoreExport(state, preview, "file.txt"), /경로/);
  assert.throws(() => recordStoreExport({ ...state, revision: 4 }, preview,
    "C:\\BANDO\\매장출고.xlsx"), /변경/);
});

test("store preview refuses factory origin, duplicate selection, incomplete addresses and mixed goods", () => {
  const state = fixture();
  assert.throws(() => previewStoreExport(state, []), /1~500/);
  assert.throws(() => previewStoreExport(state, ["store-queue-1", "store-queue-1"]), /중복/);
  const factory = structuredClone(state);
  factory.workflow.queue[0].origin = "FACTORY";
  assert.throws(() => previewStoreExport(factory, ["store-queue-1"]), /매장 발송 대기/);
  const wrongGoods = structuredClone(state);
  wrongGoods.workflow.queue[0].snapshot.recipient.items[0].origin = "FACTORY";
  assert.throws(() => previewStoreExport(wrongGoods, ["store-queue-1"]), /매장 출고 품목명/);
  const noSender = structuredClone(state);
  noSender.workflow.queue[0].snapshot.sender.address = "";
  assert.throws(() => previewStoreExport(noSender, ["store-queue-1"]), /송하인/);
  const noPhone = structuredClone(state);
  noPhone.workflow.queue[0].snapshot.recipient.mobile = "";
  assert.throws(() => previewStoreExport(noPhone, ["store-queue-1"]), /수취인/);
  const untransferred = structuredClone(state);
  untransferred.workflow.shipments[0].transferred = false;
  assert.throws(() => previewStoreExport(untransferred, ["store-queue-1"]), /이관/);
  const previously = structuredClone(state);
  previously.exports.push({id:"existing",filename:"매장출고.xlsx",
    queueEntryIds:["store-queue-1"],orderIds:["order-1"],at:"now"});
  assert.throws(() => previewStoreExport(previously, ["store-queue-1"]), /이미 작성한/);
});
test("out-of-date or tampered selected snapshots are rejected before any state write", () => {
  const state = fixture(), preview = previewStoreExport(state, ["store-queue-1"]);
  const changed = structuredClone(state);
  changed.workflow.queue[0].snapshot.recipient.items[0].quantity = 5;
  assert.throws(() => recordStoreExport(changed, preview, "C:\\BANDO\\출고.xlsx"), /변경/);
});
