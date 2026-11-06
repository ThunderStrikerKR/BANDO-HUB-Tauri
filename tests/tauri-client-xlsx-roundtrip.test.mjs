import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { File } from "node:buffer";
import { webcrypto } from "node:crypto";
import vm from "node:vm";
import ts from "typescript";
import ExcelJS from "exceljs";

const require = createRequire(import.meta.url);
const code = readFileSync(new URL("../src/client-workbook.ts", import.meta.url), "utf8");
const cjs = ts.transpileModule(code, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  esModuleInterop: true,
}}).outputText;
const exports = {};
vm.runInNewContext(cjs, { exports, require, structuredClone, crypto: webcrypto }, {
  filename: "src/client-workbook.ts",
});

function fixture() {
  return {
    revision: 19, products: [], orders: [{id:"order-1",recipients:[]}],
    aliases: [], settings: {accounts:[{id:"account-1",bank:"은행",holder:"반도"}]},
    clients: [{
      id:"client-1", name:"테스트 거래처", displayName:"", address:"서울 종로구 10",
      postcode:"03123", phone:"02-1234-5678", mobile:"010-0000-0000",
      person:"", contact:"", tier:"wholesale", payment:"PREPAID",
      shippingFeeExcluded:false, active:true, identifiers:"",
      shortNames:"", overrides:{"variant-1":14000},
    }, {
      id:"client-2", name:"다른 거래처", displayName:"", address:"경기 양주시 1",
      postcode:"11401", phone:"031-987-6543", mobile:"",
      person:"", contact:"", tier:"semi", payment:"POSTPAID",
      shippingFeeExcluded:false, active:true, identifiers:"",
      shortNames:"", overrides:{},
    }],
  };
}
async function makeWorkbook(state) {
  const buffer = await exports.exportClientWorkbook(state);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(buffer));
  // Diagnostic output from the generated workbook; no personal data.
  console.log("XLSX WORKSHEETS", JSON.stringify(workbook.worksheets.map((sheet) => ({
    name: sheet.name, rows: sheet.rowCount,
    A1: String(sheet.getCell("A1").value),
    B1: String(sheet.getCell("B1").value),
  }))));
  return workbook;
}
async function previewWorkbook(state, workbook) {
  const buffer = await workbook.xlsx.writeBuffer();
  const file = new File([Buffer.from(buffer)], "거래처_전체.xlsx", {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  return exports.previewClientWorkbook(state, file);
}

test("real XLSX binary roundtrip: unchanged full export means zero DB updates", async () => {
  const state = fixture();
  const original = JSON.stringify(state);
  const wb = await makeWorkbook(state);
  assert.equal(wb.getWorksheet("거래처 목록").rowCount, 3);
  assert.ok(wb.getWorksheet("입금 계좌 안내"));
  assert.ok(wb.getWorksheet("특수 단가 참고"));
  assert.equal(wb.getWorksheet("__반도허브_관리정보").getCell("B2").value, 19);
  assert.equal(wb.getWorksheet("거래처 목록").getCell("E2").value, "03123");
  const preview = await previewWorkbook(state, wb);
  assert.deepEqual(Array.from(preview.rows, r=>r.status), ["UNCHANGED","UNCHANGED"]);
  assert.equal(preview.missing, 0);
  const result = exports.applyClientWorkbook(state, preview);
  assert.equal(result.created, 0);
  assert.equal(result.updated, 0);
  assert.equal(JSON.stringify(state), original);
});

test("real XLSX: correct ID updates one client, blank ID creates one, missing row is not deleted", async () => {
  const state = fixture();
  const workbook = await makeWorkbook(state);
  const sheet = workbook.getWorksheet("거래처 목록");
  sheet.getCell("D2").value = "서울 종로구 45";
  sheet.spliceRows(3,1); // client-2 omitted; remains in DB
  const row = new Array(exports.CLIENT_HEADERS.length).fill("");
  row[1] = "신규 지점"; row[3] = "경기 성남시 1"; row[5] = "031-500-6000";
  row[9] = "소매"; row[10] = "후불";
  sheet.addRow(row);
  const preview = await previewWorkbook(state, workbook);
  assert.deepEqual(Array.from(preview.rows, r=>r.status), ["UPDATE","ADD"]);
  assert.equal(preview.missing, 1);
  const {next,created,updated} = exports.applyClientWorkbook(state, preview);
  assert.equal(created, 1);
  assert.equal(updated, 1);
  assert.equal(next.clients.length, 3);
  assert.equal(next.clients[0].address,"서울 종로구 45");
  assert.deepEqual(next.clients[0].overrides,{"variant-1":14000});
  assert.equal(next.clients[1].name,"다른 거래처");
  assert.equal(next.clients[1].active,true);
  assert.equal(next.clients[2].name,"신규 지점");
  assert.equal(next.clients[2].tier,"retail");
  assert.equal(next.clients[2].payment,"POSTPAID");
  assert.deepEqual(next.orders, state.orders);
});

test("real XLSX: corrupted existing ID and duplicated phone cannot be applied", async () => {
  const state = fixture();
  const wb = await makeWorkbook(state);
  const sh = wb.getWorksheet("거래처 목록");
  sh.getCell("A2").value = "changed-client-ID";
  const preview1 = await previewWorkbook(state, wb);
  assert.equal(preview1.rows[0].status,"ERROR");
  assert.throws(() => exports.applyClientWorkbook(state, preview1), /중복 또는 오류/);
  sh.getCell("A2").value = "client-1";
  const row = new Array(exports.CLIENT_HEADERS.length).fill("");
  row[1]="가짜 중복"; row[3]="서울 강남구 3"; row[5]="02-1234-5678";
  sh.addRow(row);
  const preview2 = await previewWorkbook(state, wb);
  assert.equal(preview2.rows.at(-1).status,"HOLD");
  assert.throws(() => exports.applyClientWorkbook(state, preview2), /중복 또는 오류/);
});

test("real XLSX: edited DB revision makes a downloaded workbook stale", async () => {
  const state = fixture();
  const wb = await makeWorkbook(state);
  const later = {...state,revision:20};
  await assert.rejects(() => previewWorkbook(later,wb), /데이터가 바뀌었습니다/);
});

test("real XLSX: Excel formula cells are blocked and numeric phone fields rejected", async () => {
  const state = fixture();
  const wb = await makeWorkbook(state);
  const sh = wb.getWorksheet("거래처 목록");
  sh.getCell("F2").value = {formula: "1+1", result: 2};
  await assert.rejects(() => previewWorkbook(state,wb), /수식이나 병합된 셀/);
  sh.getCell("F2").value = 212345678;
  await assert.rejects(() => previewWorkbook(state,wb), /앞자리 0이 사라질 수 있습니다/);
});
