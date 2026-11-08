import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const seed = JSON.parse(read("src-tauri/resources/state-seed.json"));
const legacy = JSON.parse(read("src-tauri/resources/legacy-state-seed-303.json"));
function load(path, imports) {
  const output = ts.transpileModule(read(path), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exported = {};
  vm.runInNewContext(output, {
    exports: exported, structuredClone, Date, Map, Set,
    require: (p) => {
      assert.ok(Object.hasOwn(imports, p), "Unexpected module: " + p);
      return imports[p];
    },
  }, { filename: path });
  return exported;
}
const active = (products) => products.filter((p) => p.active !== false && !p.deletedAt && !p.supersededBy);
const prices = load("src/catalog-price-sync.ts", {
  "./product-models": { registeredProducts: active },
});
const source = (id) => structuredClone(legacy.products.find((p) => p.siteId === id));
const target = (state, siteId, oldVariantId) => state.products.find(
  (p) => p.siteId === siteId && p.variants[0].id === oldVariantId,
);
const report = (product) => ({
  products: [product], collectedAt: "2026-12-01T00:00:00.000Z", categories: [], failures: [],
});

test("The 303 historical site listings become 360 independent products with exact mappings", () => {
  assert.equal(legacy.products.length, 303);
  assert.equal(seed.products.length, 360);
  assert.ok(seed.products.every((p) => p.variants.length === 1 && p.saleUnit));
  const pairs = legacy.products.flatMap((p) => p.variants.map((v) => [p, v]));
  for (const [p, v] of pairs) {
    const unit = target(seed, p.siteId, v.id);
    assert.ok(unit, v.id);
    assert.equal(unit.variants[0].retail, v.retail);
    assert.equal(unit.variants[0].siteOptionId, v.siteOptionId);
    if (p.variants.length > 1) assert.equal(seed.productMappings[p.id + "|" + v.id], unit.id);
  }
});

test("Official price sync links each independent product by exact historical site option identity", () => {
  const state = structuredClone(seed);
  const historical = source("343");
  const original = target(state, "343", historical.variants[1].id);
  assert.ok(original);
  original.variants[0].wholesale = 43000;
  original.variants[0].semi = 51000;
  historical.code = "P000TEST"; // site identity, not Cafe24 P-code nor model code, controls matching
  historical.variants[1].retail += 3000;
  historical.variants[1].officialRetail = historical.variants[1].retail;
  const before = JSON.stringify(state);
  const checked = prices.previewCatalogPriceSync(state, report(historical));
  assert.equal(checked.rows.filter((r) => r.status === "READY").length, 1);
  const { next, updated } = prices.applyCatalogPriceSync(state, report(historical), checked);
  assert.equal(updated, 1);
  assert.equal(JSON.stringify(state), before);
  const after = next.products.find((p) => p.id === original.id);
  assert.equal(after.variants[0].retail, original.variants[0].retail + 3000);
  assert.equal(after.variants[0].wholesale, 43000);
  assert.equal(after.variants[0].semi, 51000);
  assert.equal(after.priceHistory.at(-1).field, original.variants[0].id + ".retail");
  assert.equal(next.products.filter((p) => p.siteId === "343").length, 4);
});

test("Official sync refuses changed option identifiers even when model and site match", () => {
  const state = structuredClone(seed);
  const historical = source("343");
  historical.variants[0].retail += 1000;
  historical.variants[0].officialRetail = historical.variants[0].retail;
  historical.variants[0].siteOptionId = "ALTERED";
  const checked = prices.previewCatalogPriceSync(state, report(historical));
  assert.equal(checked.rows[0].status, "HOLD");
});

test("Official sync rejects stale approvals and never overwrites an employee price", () => {
  const state = structuredClone(seed);
  const historical = source("343");
  historical.variants[0].retail += 1000;
  historical.variants[0].officialRetail = historical.variants[0].retail;
  const checked = prices.previewCatalogPriceSync(state, report(historical));
  assert.equal(checked.rows[0].status, "READY");
  assert.throws(() => prices.applyCatalogPriceSync({ ...state, revision: 77 }, report(historical), checked),
    /데이터가 변경/);
  const manual = structuredClone(state);
  const unit = target(manual, "343", historical.variants[0].id);
  unit.variants[0].source = "MANUAL";
  assert.equal(prices.previewCatalogPriceSync(manual, report(historical)).rows[0].status, "HOLD");
});

test("Duplicated website option identity holds all affected rows", () => {
  const state = structuredClone(seed);
  const historical = source("343");
  historical.variants[1].siteOptionId = historical.variants[0].siteOptionId;
  historical.variants[1].retail += 9000;
  historical.variants[1].officialRetail = historical.variants[1].retail;
  const checked = prices.previewCatalogPriceSync(state, report(historical));
  assert.equal(checked.rows[0].status, "HOLD");
  assert.equal(checked.rows[1].status, "HOLD");
});

test("Old bulk approval cannot bypass review and backup", () => {
  const native = read("src-tauri/src/lib.rs");
  const ui = read("src/ManagementUI.tsx");
  assert.match(native, /fn catalog_approve\(_db: State<'_, Database>\)/);
  assert.match(native, /이전 방식의 일괄 승인은 안전하지 않아 중지/);
  assert.doesNotMatch(ui, /approveCatalog\(\)/);
  assert.match(ui, /applyCatalogPriceSync\(current, report, review\)/);
  assert.match(ui, /await window\.bando!\.backup\(\)/);
});

test("No staff-facing SKU split or multi-option creation path remains", () => {
  assert.equal(existsSync(new URL("../src/SkuSplitPanel.tsx", import.meta.url)), false);
  assert.equal(existsSync(new URL("../src/sku-split.ts", import.meta.url)), false);
  const admin = read("src/ProductManager.tsx");
  const alias = read("src/AliasManager.tsx");
  assert.doesNotMatch(admin, /SkuSplitPanel|판매 옵션 추가|manualOptionEditor/);
  assert.doesNotMatch(alias, /관리 별칭 옵션|기본 등록 옵션/);
  assert.match(admin, /p\.variants\.length !== 1/);
});

test("Independent product editor does not show legacy multi-option UI", () => {
  const admin = read("src/ProductManager.tsx");
  assert.doesNotMatch(admin, /기존 상품에 옵션이 여러 개 있습니다/);
  assert.doesNotMatch(admin, /product-detail-multi-note/);
  assert.doesNotMatch(admin, /variants\.length > 1/);
  assert.doesNotMatch(admin, /홈페이지 상품 연결 \(선택\) " \+ \(index \+ 1\)/);
  assert.match(admin, /<Field label="홈페이지 상품 연결 \(선택\)">/);
  assert.match(admin, /value=\{edit\.variants\[0\]\.url\}/);
  assert.match(admin, /edit\.variants\.length === 1 && \(/);
  assert.match(admin, /disabled=\{edit\.variants\.length !== 1\}/);
  assert.match(admin, /if \(p\.variants\.length !== 1\) throw Error/);
  assert.match(admin, /<Field label="상품명 \(거래처 \/ 매장 \/ 공장 공통\)">/);
  assert.match(admin, /<Field label="상품설명 \(매장 내부 참고\)">/);
  assert.match(admin, /edit\.priceHistory\?\.slice\(\)\.reverse\(\)/);
});
