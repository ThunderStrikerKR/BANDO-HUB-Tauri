import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { tsImport } from "tsx/esm/api";

const read = (path) => JSON.parse(readFileSync(new URL("../" + path, import.meta.url), "utf8"));
const state = read("src-tauri/resources/state-seed.json");
const source = read("src-tauri/resources/catalog.json");
const byId = new Map(source.products.map((p) => [p.id, p]));
const product = (siteId) => {
  const value = state.products.find((item) => item.siteId === siteId);
  assert.ok(value, "Unknown site product " + siteId);
  return value;
};

test("303 curated business names retain every official original and stable identity", () => {
  assert.equal(state.products.length, 303);
  assert.equal(source.products.length, 303);
  assert.equal(new Set(state.products.map((p) => p.id)).size, 303);
  assert.equal(new Set(state.products.map((p) => p.siteId)).size, 303);
  assert.equal(state.products.filter((p) => p.originalName !== p.name).length, 303);
  assert.ok(state.products.filter((p) => p.subtitle?.trim()).length >= 90);
  assert.ok(state.products.every((p) => p.name.trim() && !/^반도스탠드\s/i.test(p.name)));
  for (const p of state.products) {
    const before = byId.get(p.id);
    assert.ok(before, p.id);
    assert.equal(p.siteId, before.siteId);
    assert.equal(p.siteCode, before.siteCode);
    assert.equal(p.code, before.code);
    assert.equal(p.originalName, before.name);
    assert.equal(p.variants.length, before.variants.length);
    for (const variant of p.variants) {
      const previous = before.variants.find((v) => v.id === variant.id);
      assert.ok(previous, variant.id);
      for (const field of ["id", "color", "wholesale", "semi", "retail", "siteOptionId", "url"]) {
        assert.deepEqual(variant[field], previous[field], p.id + ":" + field);
      }
    }
  }
});

test("Curated identifiers, contents, family distinctions and notes are preserved", () => {
  assert.equal(product("259").name, "BD 700 / 가방 포함");
  assert.equal(product("240").name, "BD 803");
  assert.match(product("240").subtitle, /성악용/);
  assert.equal(product("84").name, "Cart-20 / 보면대카트");
  assert.match(product("84").subtitle, /단종예정/);
  assert.match(product("329").name, /마이크홀더 미포함/);
  assert.match(product("168").name, /일렉 및 베이스 전용/);
  assert.match(product("167").name, /통기타 전용/);
  assert.match(product("201").name, /A타입 상판/);
  assert.match(product("356").name, /B타입 상판/);
  assert.match(product("356").subtitle, /확인 필요/);
});

test("Three observed wheel option families explicitly label both present and absent", () => {
  for (const siteId of ["134", "135", "136"]) {
    assert.deepEqual(new Set(product(siteId).variants.map((v) => v.option)),
      new Set(["바퀴 포함", "바퀴 미포함"]));
  }
  // The original historical option labels remain in catalog.json.
  assert.match(byId.get(product("136").id).variants[0].option, /추가 안함/);
});

test("Automatic name cleanup UI and bulk classifier are deleted", () => {
  for (const path of ["src/product-name-cleanup.ts", "src/ProductNameCleanupPanel.tsx"]) {
    assert.equal(existsSync(new URL("../" + path, import.meta.url)), false, path);
  }
  const ui = readFileSync(new URL("../src/ProductManager.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(ui, /ProductNameCleanupPanel/);
  assert.match(ui, /상품설명 \(매장 내부 참고\)/);
});

test("Reception and SKU split retain the selected option and curated family identity", async () => {
  const { itemFromProduct, unassignedClient } = await tsImport("../src/domain.ts", import.meta.url);
  const { previewSkuSplit, applySkuSplit } = await tsImport("../src/sku-split.ts", import.meta.url);
  const guitar = product("168");
  const item = itemFromProduct(guitar, unassignedClient,
    guitar.variants[0].color, 1, guitar.variants[0].id);
  assert.match(item.name, /일렉 및 베이스 전용/);
  assert.ok(item.name.includes(guitar.variants[0].option));
  const acrylic = product("351");
  const preview = previewSkuSplit(state, acrylic.id);
  assert.deepEqual(preview.blockers, []);
  const { next, created } = applySkuSplit(state, preview);
  assert.equal(created, acrylic.variants.length);
  const units = next.products.filter((p) => p.sourceProductId === acrylic.id);
  assert.equal(units.length, acrylic.variants.length);
  for (const unit of units) {
    assert.ok(unit.name.includes(unit.variants[0].option));
    const generated = itemFromProduct(unit, unassignedClient, unit.variants[0].color,
      1, unit.variants[0].id);
    assert.ok(generated.name.includes(unit.variants[0].option));
  }
});
