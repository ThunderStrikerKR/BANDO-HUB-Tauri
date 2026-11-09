import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { tsImport } from "tsx/esm/api";
const read = (path) => JSON.parse(readFileSync(new URL("../" + path, import.meta.url), "utf8"));
const seed = read("src-tauri/resources/state-seed.json");
const old = read("src-tauri/resources/legacy-state-seed-303.json");
const byOldId = new Map(old.products.map((p) => [p.id, p]));
const byId = new Map(seed.products.map((p) => [p.id, p]));
const byPriceId = new Map(seed.products.map((p) => [p.variants[0].id, p]));
const siteProduct = (id) => seed.products.filter((p) => p.siteId === id);

test("Every one of the 360 sale units is its own product, never an internal option selection", () => {
  assert.equal(old.products.length, 303);
  assert.equal(seed.products.length, 360);
  assert.equal(new Set(seed.products.map((p) => p.id)).size, 360);
  assert.equal(new Set(seed.products.map((p) => p.variants[0].id)).size, 360);
  assert.ok(seed.products.every((p) => p.variants.length === 1 && p.saleUnit && !p.requiresOption));
  assert.equal(seed.products.filter((p) => !/^반도스탠드\s/.test(p.name)).length, 360);
  assert.ok(seed.products.filter((p) => p.subtitle?.trim()).length >= 90);
});

test("All original 360 price records, site references, and official IDs remain intact", () => {
  const source = old.products.flatMap((p) => p.variants.map((v) => ({ p, v })));
  assert.equal(source.length, 360);
  for (const { p, v } of source) {
    const target = byPriceId.get(v.id);
    assert.ok(target, "Missing old source record " + v.id);
    const unit = target.variants[0];
    assert.equal(target.siteId, p.siteId);
    assert.equal(target.siteCode, p.siteCode);
    assert.equal(target.originalName, p.originalName);
    for (const field of ["id", "color", "wholesale", "semi", "retail", "siteOptionId", "url"]) {
      assert.deepEqual(unit[field], v[field], target.id + " / " + field);
    }
    const expected = p.variants.length > 1 ? seed.productMappings[p.id + "|" + v.id] : p.id;
    assert.equal(target.id, expected);
  }
});

test("Naming covers perforation, color, wheels, bag and distinct family use", () => {
  assert.deepEqual(siteProduct("48").map((p) => p.name), [
    "BD 709 / 블랙 / 타공 상판",
    "BD 709-1 / 블랙 / 비타공 상판",
  ]);
  assert.deepEqual(siteProduct("136").map((p) => p.name), [
    "BD Z-2 / 바퀴 미포함", "BD Z-2 / 바퀴 포함",
  ]);
  assert.equal(siteProduct("259")[0].name, "BD 700 / 가방 포함");
  assert.match(siteProduct("329")[0].name, /마이크홀더 미포함/);
  assert.match(siteProduct("168")[0].name, /일렉 및 베이스 전용/);
  assert.match(siteProduct("167")[0].name, /통기타 전용/);
  assert.equal(siteProduct("201")[0].name, "BD LP-WB / A타입 상판");
  assert.equal(siteProduct("356")[0].name, "BD LP-WB / B타입 상판");
  assert.match(siteProduct("84")[0].subtitle, /단종예정/);
});

test("No employee-facing automatic cleanup or SKU splitting entry point remains", () => {
  for (const path of [
    "src/ProductNameCleanupPanel.tsx", "src/product-name-cleanup.ts",
    "src/SkuSplitPanel.tsx", "src/sku-split.ts",
  ]) assert.equal(existsSync(new URL("../" + path, import.meta.url)), false, path);
  const management = readFileSync(new URL("../src/ProductManager.tsx", import.meta.url), "utf8");
  const item = readFileSync(new URL("../src/OrderItemEditor.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(management, /판매 옵션 추가|SkuSplitPanel|manualOptionEditor/);
  assert.doesNotMatch(item, /label="옵션"|\.variants\.map/);
  assert.match(management, /<Field label="상품설명" help=\{\{/);
  assert.match(management, /매장 직원이 상품 특징을 기억/);
});

test("Order line names use the entire independently registered product name", async () => {
  const { itemFromProduct, unassignedClient } = await tsImport("../src/domain.ts", import.meta.url);
  const stand = siteProduct("48")[1];
  const orderLine = itemFromProduct(stand, unassignedClient, stand.variants[0].color, 1, stand.variants[0].id);
  assert.equal(orderLine.productId, stand.id);
  assert.equal(orderLine.variantId, stand.variants[0].id);
  assert.equal(orderLine.name, stand.name);
});
