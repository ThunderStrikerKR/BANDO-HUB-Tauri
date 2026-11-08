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
const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const exports = {};
const compiled = ts.transpileModule(read("src/product-sync-workbook.ts"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
const execute = vm.runInThisContext(
  "(function(exports, require, crypto, structuredClone) {\n" + compiled + "\n})",
  { filename: "src/product-sync-workbook.ts" },
);
const active = (products) => products.filter((p) => !p.deletedAt && !p.supersededBy && p.active !== false);
const normalizeCode = (code) => code.toUpperCase().replace(/\s/g, "");
const normalizeColor = (color) => ({ 검정: "Black", 블랙: "Black" }[color] ?? color).trim();
execute(exports, (path) => {
  if (path === "./domain") return {
    normalizeCode, normalizeColor,
    validateProduct: (p, products) => {
      if (!p.id || !p.code || !p.name || !p.variants.length) throw Error("필수 상품 필드 오류");
      if (products.some((old) => old.id !== p.id && old.code === p.code && !p.saleUnit)) {
        throw Error("같은 모델코드의 상품이 있습니다.");
      }
      if (!p.variants.some((v) => normalizeColor(v.color) === normalizeColor(p.defaultColor))) {
        throw Error("기본 색상 확인");
      }
    },
  };
  if (path === "./product-models") return { registeredProducts: active };
  return require(path);
}, webcrypto, structuredClone);
const seed = JSON.parse(read("src-tauri/resources/state-seed.json"));
const example = () => structuredClone(seed);

async function exportAndReload(state) {
  const bytes = await exports.exportProductSyncWorkbook(state);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(bytes));
  return workbook;
}
async function previewWorkbook(state, workbook) {
  const bytes = await workbook.xlsx.writeBuffer();
  const file = new File([Buffer.from(bytes)], "상품전체.xlsx", {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  return exports.previewProductSyncWorkbook(state, file);
}

test("real XLSX: all 360 independent products and 360 price rows survive export and re-import unchanged", async () => {
  const state = example();
  const original = JSON.stringify(state);
  const wb = await exportAndReload(state);
  assert.equal(wb.getWorksheet("상품 목록").rowCount, 361);
  assert.equal(wb.getWorksheet("상품별 가격").rowCount, 361);
  assert.ok(wb.getWorksheet("카테고리 및 브랜드 참고"));
  assert.equal(wb.getWorksheet("__반도허브_관리정보").getCell("B2").value, state.revision ?? 0);
  const preview = await previewWorkbook(state, wb);
  assert.equal(preview.rows.filter((r) => r.status === "ERROR").length, 0);
  assert.equal(preview.rows.filter((r) => r.status === "UPDATE").length, 0);
  assert.equal(preview.rows.filter((r) => r.status === "ADD").length, 0);
  assert.equal(preview.missingProducts, 0);
  assert.equal(preview.missingOptions, 0);
  const applied = exports.applyProductSyncWorkbook(state, preview);
  assert.equal(JSON.stringify(applied.next), original);
  assert.equal(JSON.stringify(state), original);
});

test("real XLSX: modify one official-product retail price but keep option ID, other tiers and catalog IDs", async () => {
  const state = example();
  const wb = await exportAndReload(state);
  const options = wb.getWorksheet("상품별 가격");
  const original = state.products.find((p) => p.siteId === "351");
  const row = options.getRows(2, options.rowCount - 1).find((item) =>
    item.getCell(1).value === original.id && item.getCell(3).value === original.variants[0].id);
  assert.ok(row);
  row.getCell(8).value = 128000;
  const review = await previewWorkbook(state, wb);
  assert.equal(review.rows.filter((r) => r.status === "UPDATE").length, 1);
  const after = exports.applyProductSyncWorkbook(state, review).next.products
    .find((p) => p.id === original.id);
  assert.equal(after.variants[0].retail, 128000);
  assert.equal(after.variants[0].id, original.variants[0].id);
  assert.equal(after.variants[0].wholesale, original.variants[0].wholesale);
  assert.equal(after.variants[0].semi, original.variants[0].semi);
  assert.equal(after.variants[0].siteOptionId, original.variants[0].siteOptionId);
  assert.equal(after.variants[0].source, "MANUAL");
  const sibling = state.products.find((p) => p.siteId === original.siteId && p.id !== original.id);
  assert.ok(sibling);
  assert.equal(sibling.variants[0].retail,
    exports.applyProductSyncWorkbook(state, review).next.products.find((p) => p.id === sibling.id).variants[0].retail);
  assert.equal(after.siteId, original.siteId);
  assert.equal(after.siteCode, original.siteCode);
  assert.equal(after.priceHistory.at(-1).source, "MANUAL_EXCEL");
});

test("real XLSX: two colors create two independent products with one price each", async () => {
  const state = example();
  const wb = await exportAndReload(state);
  const products = wb.getWorksheet("상품 목록");
  const prices = wb.getWorksheet("상품별 가격");
  for (const [key, color, retail] of [["NEW900BLACK", "블랙", 90000], ["NEW900WHITE", "화이트", 99000]]) {
    const p = new Array(exports.PRODUCT_SYNC_HEADERS.length).fill("");
    p[1] = key; p[2] = "BD 900 / " + color; p[4] = "BD 900";
    p[5] = "반도스탠드"; p[6] = "공장"; p[11] = color; p[12] = "사용";
    products.addRow(p);
    const price = new Array(exports.OPTION_SYNC_HEADERS.length).fill("");
    price[1] = key; price[3] = color; price[5] = 50000; price[6] = 65000; price[7] = retail;
    prices.addRow(price);
  }
  const preview = await previewWorkbook(state, wb);
  assert.equal(preview.rows.filter((r) => r.status === "ERROR").length, 0,
    JSON.stringify(preview.rows.filter((r) => r.status === "ERROR")));
  assert.equal(preview.createdProducts, 2);
  assert.equal(preview.createdOptions, 2);
  const applied = exports.applyProductSyncWorkbook(state, preview);
  const added = applied.next.products.filter((p) => p.code === "BD 900");
  assert.equal(added.length, 2);
  assert.deepEqual(added.map((p) => p.name), ["BD 900 / 블랙", "BD 900 / 화이트"]);
  assert.ok(added.every((p) => p.variants.length === 1 && p.saleUnit && !p.siteId));
  assert.deepEqual(added.map((p) => p.variants[0].retail), [90000, 99000]);
  assert.equal(applied.next.products.length, state.products.length + 2);
});

test("real XLSX: second price row for one product is rejected", async () => {
  const state = example();
  const wb = await exportAndReload(state);
  const prices = wb.getWorksheet("상품별 가격");
  const first = state.products[0];
  const extra = new Array(exports.OPTION_SYNC_HEADERS.length).fill("");
  extra[0] = first.id; extra[3] = "화이트"; extra[7] = 99000;
  prices.addRow(extra);
  const review = await previewWorkbook(state, wb);
  assert.ok(review.rows.some((r) => r.status === "ERROR" && /두 번째 가격 구성/.test(r.errors.join(" "))));
});

test("real XLSX: unlisted options remain, and unknown or repeated IDs block saving", async () => {
  const state = example();
  const wb = await exportAndReload(state);
  const sheet = wb.getWorksheet("상품별 가격");
  sheet.spliceRows(2,1);
  let review = await previewWorkbook(state, wb);
  assert.equal(review.missingOptions, 1);
  assert.equal(review.rows.filter((r)=>r.status==="ERROR").length,0);
  assert.equal(exports.applyProductSyncWorkbook(state,review).next.products.length,state.products.length);
  const productSheet=wb.getWorksheet("상품 목록");
  productSheet.getCell("A2").value="invented-product-id";
  review=await previewWorkbook(state,wb);
  assert.ok(review.rows.some((r)=>r.status==="ERROR"));
  assert.throws(()=>exports.applyProductSyncWorkbook(state,review),/오류나 중복 의심/);
});

test("real XLSX: old DB version, formula and unknown original source fields are rejected", async () => {
  const state = example();
  const wb = await exportAndReload(state);
  await assert.rejects(()=>previewWorkbook({...state,revision:19},wb),/다시 내려받으세요/);
  const products = wb.getWorksheet("상품 목록");
  products.getCell("C2").value={formula:"2+2",result:4};
  await assert.rejects(()=>previewWorkbook(state,wb),/병합된 셀이나 수식/);
  products.getCell("C2").value=state.products[0].name;
  const variants=wb.getWorksheet("상품별 가격");
  variants.getCell("I2").value="MANUAL";
  const review=await previewWorkbook(state,wb);
  assert.ok(review.rows.some((r)=>r.status==="ERROR"));
  assert.throws(()=>exports.applyProductSyncWorkbook(state,review),/오류나 중복 의심/);
});

test("real XLSX: archived product and option records remain untouched after full export", async () => {
  const state = example();
  state.products[0].deletedAt = "2026-11-01T00:00:00Z";
  const wb=await exportAndReload(state);
  const review=await previewWorkbook(state,wb);
  assert.equal(review.rows.filter((r)=>r.status==="ERROR").length,0,
    JSON.stringify(review.rows.filter((r)=>r.status==="ERROR")));
  const result=exports.applyProductSyncWorkbook(state,review);
  assert.deepEqual(result.next.products[0],state.products[0]);
});

test("safe approvals are backed up, revision-checked and wired to Tauri native Save As", () => {
  const native=read("src-tauri/src/lib.rs");
  const bridge=read("src/tauri-bridge.ts");
  const ui=read("src/ProductSyncWorkbookTools.tsx");
  const manager=read("src/ProductManager.tsx");
  assert.match(native,/async fn save_product_sync_workbook/);
  assert.match(native,/save_product_sync_workbook,/);
  assert.match(bridge,/saveProductSyncWorkbook: \(bytes\)/);
  assert.match(manager,/<ProductSyncWorkbookTools onSave=\{onSave\}/);
  assert.match(ui,/await window\.bando!\.backup\(\)/);
  assert.match(ui,/applyUnifiedProductWorkbook\(state, review\)/);
  assert.match(ui,/await onSave\(result\.next\)/);
});


test("real XLSX: a new row with a duplicate business model is held, not registered", async () => {
  const state=example();
  const wb=await exportAndReload(state);
  const products=wb.getWorksheet("상품 목록");
  const options=wb.getWorksheet("상품별 가격");
  const original=state.products.find((p)=>p.siteId==="351");
  const row=new Array(exports.PRODUCT_SYNC_HEADERS.length).fill("");
  row[1]="DUPLICATE_MODEL"; row[2]=original.name;
  row[4]=original.code; row[5]="반도스탠드";
  row[6]="공장"; row[11]="클리어"; row[12]="사용";
  products.addRow(row);
  const option=new Array(exports.OPTION_SYNC_HEADERS.length).fill("");
  option[1]="DUPLICATE_MODEL"; option[3]="클리어"; option[7]="135000";
  options.addRow(option);
  const preview=await previewWorkbook(state,wb);
  assert.ok(preview.rows.some((r)=>r.status==="HOLD" || r.status==="ERROR"));
  assert.throws(()=>exports.applyProductSyncWorkbook(state,preview),/오류나 중복 의심/);
});

test("real XLSX: an option without a matching parent key cannot be imported", async () => {
  const state=example();
  const wb=await exportAndReload(state);
  const variants=wb.getWorksheet("상품별 가격");
  const option=new Array(exports.OPTION_SYNC_HEADERS.length).fill("");
  option[1]="UNKNOWN_NEW_PRODUCT"; option[3]="블랙"; option[7]="110000";
  variants.addRow(option);
  const preview=await previewWorkbook(state,wb);
  assert.ok(preview.rows.some((r)=>r.status==="ERROR" && /상품 행을 찾지 못했습니다/.test(r.errors.join(" "))));
  assert.throws(()=>exports.applyProductSyncWorkbook(state,preview),/오류나 중복 의심/);
});

test("real XLSX: changing an existing product name preserves all original technical IDs", async () => {
  const state=example();
  const wb=await exportAndReload(state);
  const products=wb.getWorksheet("상품 목록");
  const original=state.products.find((p)=>p.siteId==="358");
  const row=products.getRows(2,products.rowCount-1).find((r)=>r.getCell(1).value===original.id);
  assert.ok(row);
  row.getCell(3).value="보면대 바퀴";
  row.getCell(4).value="4개 1세트";
  const preview=await previewWorkbook(state,wb);
  assert.equal(preview.updatedProducts,1);
  const newProduct=exports.applyProductSyncWorkbook(state,preview).next.products.find((p)=>p.id===original.id);
  assert.equal(newProduct.name,"보면대 바퀴");
  assert.equal(newProduct.subtitle,"4개 1세트");
  assert.equal(newProduct.code,original.code);
  assert.equal(newProduct.siteCode,original.siteCode);
  assert.equal(newProduct.siteId,original.siteId);
  assert.deepEqual(newProduct.variants,original.variants);
});
