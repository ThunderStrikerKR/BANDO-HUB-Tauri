import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { File } from "node:buffer";
import { webcrypto } from "node:crypto";
import ts from "typescript";
import vm from "node:vm";
import ExcelJS from "exceljs";

const require = createRequire(import.meta.url);
const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const normalizeColor = (v) => ({ 검정: "Black", 블랙: "Black" }[v] ?? v).trim();
const domain = {
  normalizeCode: (v) => v.toUpperCase().replace(/\s/g, ""),
  normalizeColor,
  validateProduct: (p) => {
    if (!p.id || !p.name || !p.code || p.variants.length !== 1) throw Error("상품 검증 실패");
  },
};
const stateSeed = JSON.parse(read("src-tauri/resources/state-seed.json"));
const load = (path, imports) => {
  const target = {};
  const compiled = ts.transpileModule(read(path), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  vm.runInThisContext("(function(exports, require, crypto, structuredClone) {\n" +
    compiled + "\n})", { filename: path })(target,
    (name) => imports[name] ?? require(name), webcrypto, structuredClone);
  return target;
};
const legacy = load("src/product-sync-workbook.ts", {
  "./domain": domain,
  "./product-models": { registeredProducts: (ps) => ps.filter((p) => !p.deletedAt && !p.supersededBy && p.active !== false) },
});
const unified = load("src/product-unified-workbook.ts", { "./product-sync-workbook": legacy });

async function workbook(state) {
  const out = new ExcelJS.Workbook();
  await out.xlsx.load(Buffer.from(await unified.exportUnifiedProductWorkbook(state)));
  return out;
}
async function review(state, book) {
  const data = await book.xlsx.writeBuffer();
  return unified.previewUnifiedProductWorkbook(state, new File([data], "상품 전체.xlsx"));
}
test("360 independent products export to 360 rows in one sheet with unchanged round-trip", async () => {
  const state = structuredClone(stateSeed);
  const before = JSON.stringify(state);
  const x = await workbook(state);
  const sheet = x.getWorksheet("상품 목록");
  assert.equal(sheet.rowCount, 361);
  assert.equal(x.getWorksheet("상품별 가격"), undefined);
  assert.equal(sheet.getCell("C2").value, state.products[0].name);
  assert.equal(sheet.getCell("E2").value, state.products[0].variants[0].color);
  assert.equal(sheet.getCell("H2").value, state.products[0].variants[0].retail);
  const p = await review(state, x);
  assert.equal(p.rows.length, 360);
  assert.equal(p.rows.filter((r) => r.status !== "UNCHANGED").length, 0);
  assert.equal(p.missingProducts, 0);
  assert.equal(p.missingOptions, 0);
  assert.equal(JSON.stringify(unified.applyUnifiedProductWorkbook(state, p).next), before);
  assert.equal(JSON.stringify(state), before);
});
test("editing name and retail price in same row retains stable product and price identities", async () => {
  const state = structuredClone(stateSeed);
  const x = await workbook(state);
  const product = state.products.find((p) => p.siteId === "351");
  const sheet = x.getWorksheet("상품 목록");
  const row = sheet.getRows(2, 360).find((r) => r.getCell(1).value === product.id);
  row.getCell(3).value = product.name + " 수정";
  row.getCell(8).value = 128000;
  const p = await review(state, x);
  assert.equal(p.rows.filter((r) => r.status === "UPDATE").length, 1);
  const next = unified.applyUnifiedProductWorkbook(state, p).next;
  const found = next.products.find((r) => r.id === product.id);
  assert.equal(found.name, product.name + " 수정");
  assert.equal(found.variants[0].retail, 128000);
  assert.equal(found.variants[0].id, product.variants[0].id);
  assert.equal(found.variants[0].siteOptionId, product.variants[0].siteOptionId);
  assert.equal(found.priceHistory.at(-1).source, "MANUAL_EXCEL");
});
test("new colors become separate independently priced product rows", async () => {
  const state = structuredClone(stateSeed), x = await workbook(state);
  const sheet = x.getWorksheet("상품 목록");
  for (const [key, color, price] of [["B900", "블랙", 90000], ["W900", "화이트", 99000]]) {
    const values = new Array(unified.UNIFIED_PRODUCT_HEADERS.length).fill("");
    values[1] = key; values[2] = "BD 900 " + color; values[4] = color;
    values[5] = 50000; values[6] = 70000; values[7] = price;
    values[8] = "BD 900"; values[9] = "반도스탠드"; values[10] = "공장";
    values[15] = "사용";
    sheet.addRow(values);
  }
  const p = await review(state, x);
  assert.equal(p.rows.filter((r) => r.status === "ERROR").length, 0, JSON.stringify(p.rows.filter((r) => r.status === "ERROR")));
  assert.equal(p.rows.filter((r) => r.status === "ADD").length, 2);
  const added = unified.applyUnifiedProductWorkbook(state, p).next.products.filter((q) => q.code === "BD 900");
  assert.equal(added.length, 2);
  assert.ok(added.every((q) => q.variants.length === 1));
  assert.deepEqual(added.map((q) => q.variants[0].retail), [90000, 99000]);
});
test("protected internal IDs, duplicate product rows and formulas reject approval", async () => {
  const state = structuredClone(stateSeed), x = await workbook(state);
  const sheet = x.getWorksheet("상품 목록");
  sheet.getCell("R2").value = "altered-price-id";
  let p = await review(state, x);
  assert.ok(p.rows.some((r) => r.status === "ERROR"));
  assert.throws(() => unified.applyUnifiedProductWorkbook(state, p), /오류나 중복 의심/);
  sheet.getCell("R2").value = state.products[0].variants[0].id;
  sheet.addRow(sheet.getRow(2).values.slice(1));
  p = await review(state, x);
  assert.ok(p.rows.some((r) => r.status === "ERROR"));
  sheet.spliceRows(sheet.rowCount, 1);
  sheet.getCell("C2").value = { formula: "2+2", result: 4 };
  await assert.rejects(() => review(state, x), /병합된 셀이나 수식/);
});
test("legacy two-sheet upload is rejected rather than silently misinterpreted", async () => {
  const state = structuredClone(stateSeed);
  const old = new ExcelJS.Workbook();
  await old.xlsx.load(Buffer.from(await legacy.exportProductSyncWorkbook(state)));
  await assert.rejects(() => review(state, old), /통합 상품 목록을 새로 다운로드/);
});
