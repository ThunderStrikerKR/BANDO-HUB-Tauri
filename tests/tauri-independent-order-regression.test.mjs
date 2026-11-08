import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { tsImport } from "tsx/esm/api";

// Baseline-only tests: do not mutate company data, the working branch, or SQLite.
// The deliberate KNOWN-ISSUE reproducers record observable legacy behavior;
// strict business-rule tests identify where current logic fails.
const read = (path) => JSON.parse(readFileSync(new URL("../" + path, import.meta.url), "utf8"));
const seed = read("src-tauri/resources/state-seed.json");
const { itemFromProduct, resolvePrice, validateProduct, unassignedClient } =
  await tsImport("../src/domain.ts", import.meta.url);
const { parseSmart } = await tsImport("../src/parser.ts", import.meta.url);
const { applyOfficialProductPreview } =
  await tsImport("../src/official-product-import.ts", import.meta.url);
const { resolveHistoricalProductReference } =
  await tsImport("../src/historical-product-reference.ts", import.meta.url);
const client = {
  ...unassignedClient,
  id: "synthetic-order-test-client",
  name: "가상 테스트 거래처",
  tier: "retail",
  overrides: {},
};
const bySite = (site, phrase) => {
  const products = seed.products.filter((p) => p.siteId === site);
  return phrase ? products.find((p) => p.name.includes(phrase)) : products[0];
};
const itemsFor = (raw, state = seed) =>
  parseSmart(raw, client, state).flatMap((r) => r.items);
const itemFor = (raw, state = seed) => {
  const items = itemsFor(raw, state);
  assert.ok(items.length > 0, "No parsed order item for " + raw);
  return items[0];
};

test("T01: BD 709 quantity is extracted and resolved only to a valid product", () => {
  const item = itemFor("BD 709 3개");
  assert.equal(item.quantity, 3);
  if (item.productId) {
    const product = seed.products.find((p) => p.id === item.productId);
    assert.ok(product, "Selected product must exist");
    assert.equal(item.variantId, product.variants[0].id);
    assert.match(product.name, /709/);
  } else {
    assert.ok(item.issues.length > 0, "Uncertain product must require review");
  }
});

test("T02: wheel-included wording resolves to the included independent product", () => {
  const item = itemFor("BD Z-2 바퀴 포함 2개");
  assert.equal(item.quantity, 2);
  assert.equal(item.productId, bySite("136", "바퀴 포함").id);
});

test("T03: wheel-excluded wording resolves to the excluded independent product", () => {
  const item = itemFor("BD Z-2 바퀴 미포함 2개");
  assert.equal(item.quantity, 2);
  assert.equal(item.productId, bySite("136", "바퀴 미포함").id);
});

test("T04: bare shared model does not silently pick included or excluded wheels", () => {
  const item = itemFor("BD Z-2 2개");
  assert.equal(item.quantity, 2);
  assert.equal(item.productId, null, "Unspecified wheels need independent-product confirmation");
  assert.ok(item.issues.length > 0);
});

test("T05: A-type tabletop name resolves to A-type independent product", () => {
  const item = itemFor("BD LP-WB A타입 상판 1개");
  assert.equal(item.productId, bySite("201", "A타입").id);
});

test("T06: B-type tabletop name resolves to B-type independent product", () => {
  const item = itemFor("BD LP-WB B타입 상판 1개");
  assert.equal(item.productId, bySite("356", "B타입").id);
});

test("T07: explicit color resolves within multiple BD 700S color products", () => {
  const candidate = seed.products.find((p) => p.code === "BD 700S" && p.name.includes("화이트"));
  assert.ok(candidate, "White BD 700S product should be present in current seed");
  const item = itemFor("BD 700S 화이트 1개");
  assert.equal(item.productId, candidate.id);
  assert.equal(item.variantId, candidate.variants[0].id);
});

test("T08: explicit choice of one valid product binds its sole price record", () => {
  const product = bySite("48", "타공 상판");
  const item = itemFromProduct(product, client, product.variants[0].color, 1, product.variants[0].id);
  assert.equal(item.productId, product.id);
  assert.equal(item.variantId, product.variants[0].id);
  assert.equal(item.unitPrice, product.variants[0].retail);
  assert.equal(item.name, product.name);
});

test("T09: replacing an item with another independent product updates ID and price", () => {
  const original = bySite("48", "타공 상판");
  const replacement = bySite("48", "비타공 상판");
  const before = itemFromProduct(original, client, original.variants[0].color, 4, original.variants[0].id);
  const after = itemFromProduct(replacement, client, replacement.variants[0].color,
    before.quantity, replacement.variants[0].id);
  assert.equal(after.quantity, 4);
  assert.equal(after.productId, replacement.id);
  assert.equal(after.variantId, replacement.variants[0].id);
  assert.equal(after.unitPrice, replacement.variants[0].retail);
  assert.notEqual(before.productId, after.productId);
});

test("T10 KNOWN-ISSUE baseline: legacy requiresOption blocks manual implicit price linking", (t) => {
  const product = structuredClone(bySite("48", "타공 상판"));
  product.requiresOption = true;
  assert.equal(product.variants.length, 1);
  const item = itemFromProduct(product, client, product.variants[0].color, 2);
  if (item.variantId === null && item.unitPrice === null) {
    t.diagnostic("REPRODUCED: one-price product loses variantId and unitPrice when requiresOption=true");
  } else {
    t.diagnostic("NOT REPRODUCED: price record remained linked");
  }
  assert.equal(item.productId, product.id);
});

test("T11: a product with zero or two price records is rejected by validation", () => {
  const original = bySite("48", "타공 상판");
  for (const records of [[], [original.variants[0], {...original.variants[0], id:"extra-price"}]]) {
    const product = {...structuredClone(original), variants: records};
    assert.throws(() => validateProduct(product, []));
  }
});

test("T12: special dealer price uses the sole price-record identifier", () => {
  const product = bySite("48", "타공 상판");
  const vid = product.variants[0].id;
  const special = {...client, tier: "special", overrides: {[vid]: 43210}};
  assert.equal(resolvePrice(product, vid, special), 43210);
  const item = itemFromProduct(product, special, product.variants[0].color, 1, vid);
  assert.equal(item.unitPrice, 43210);
});

test("T13 KNOWN-ISSUE baseline: compare auto parse against manual legacy option guard", (t) => {
  const product = structuredClone(bySite("48", "타공 상판"));
  product.id = "synthetic-unique-product";
  product.code = "BD 987XY";
  product.name = "BD 987XY / 블랙 / 바퀴 포함";
  product.variants[0].id = "synthetic-unique-price";
  product.variants[0].color = "Black";
  product.defaultColor = "Black";
  product.requiresOption = true;
  product.saleUnit = true;
  product.familyKey = "synthetic-unique-family";
  const state = {...structuredClone(seed), products: [product], aliases: []};
  const manual = itemFromProduct(product, client, product.variants[0].color, 1);
  const automatically = itemsFor("BD 987XY 1개", state)[0];
  assert.ok(automatically, "Synthetic order should produce an item for comparison");
  const discrepancy = manual.variantId === null && automatically.variantId === product.variants[0].id;
  t.diagnostic(discrepancy
    ? "REPRODUCED: automatic parsing linked a price record blocked by manual selection"
    : "NOT REPRODUCED: check whether both paths applied the same safeguards");
  assert.ok(automatically.variantId === null || automatically.variantId === product.variants[0].id);
});

test("T14: ambiguous official-page options are refused before write", () => {
  const product = structuredClone(bySite("48", "타공 상판"));
  product.requiresOption = true;
  const preview = {
    product, canApply: true, optionEvidence: [{group: "구성",kind: "SELECT",values: [{label:"포함"}]}],
    revision: seed.revision ?? 0, sourceUrl: "https://www.bandostand.com/product/test/48/",
    existingId: null,
  };
  assert.throws(() => applyOfficialProductPreview(seed, preview), /옵션|모델/);
});

test("T15: historical source IDs map without modifying a confirmed order", () => {
  const productId = "bando-site-351";
  const priceRecordId = "bando-351-P00000NN000B";
  const order = {id: "synthetic-locked-order", recipients: [{
    id: "recipient", items: [{
      id: "item", productId, variantId: priceRecordId,
      name: "과거 확정 당시 상품명", quantity: 2, unitPrice: 123456,
    }],
  }]};
  const before = JSON.stringify(order);
  const resolved = resolveHistoricalProductReference(seed, productId, priceRecordId);
  assert.equal(resolved.via, "HISTORICAL");
  assert.equal(resolved.product.variants[0].id, priceRecordId);
  assert.equal(JSON.stringify(order), before);
});
