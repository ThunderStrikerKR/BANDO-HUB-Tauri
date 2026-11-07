import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const read = (path) => readFileSync(new URL("../" + path, import.meta.url), "utf8");

function loadCleanupModule() {
  const source = read("src/product-name-cleanup.ts");
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(output, {
    exports, structuredClone,
    require: (name) => {
      assert.equal(name, "./product-models");
      return {
        registeredProducts: (products) =>
          products.filter((p) => p.active !== false && !p.deletedAt && !p.supersededBy),
        normalizeModel: (value) => value.trim()
          .replace(/^bd\s*/i, "BD ")
          .replace(/^BD (\d[A-Za-z0-9-]*)$/i, (_, suffix) => "BD " + suffix.toUpperCase()),
      };
    },
  });
  return exports;
}

const seed = JSON.parse(read("src-tauri/resources/state-seed.json"));
const { previewProductNameCleanup, applyProductNameCleanup } = loadCleanupModule();

test("Initial catalog name cleanup has reviewed ready/hold items", () => {
  const preview = previewProductNameCleanup(seed);
  assert.ok(preview.rows.length >= 250);
  assert.ok(preview.rows.some((r) => r.status === "READY"));
  assert.ok(preview.rows.some((r) => r.status === "HOLD"));
  assert.ok(preview.rows.every((r) => r.oldName.startsWith("반도스탠드")));
});

test("Model names are concise and use cases move to the description", () => {
  const preview = previewProductNameCleanup(seed);
  const find = (siteId) => {
    const p = seed.products.find((p) => p.siteId === siteId);
    assert.ok(p, "Missing fixture: " + siteId);
    return preview.rows.find((r) => r.productId === p.id);
  };
  const vocal = find("240");
  assert.equal(vocal.status, "READY");
  assert.equal(vocal.newName, "BD 803");
  assert.match(vocal.newDescription, /성악용 녹음용 보면대/);
  const desktop = find("239");
  assert.equal(desktop.newName, "BD 610");
  assert.match(desktop.newDescription, /탁상,국악용 보면대/);
  const bag = find("259");
  assert.equal(bag.newName, "BD 700 / 가방 포함");
  assert.doesNotMatch(bag.newDescription, /가방포함|가방 포함/);
  const cart = find("84");
  assert.equal(cart.newName, "Cart-20");
  assert.match(cart.newDescription, /보면대카트/);
});

test("Placeholder Cafe24 product codes are never treated as model names", () => {
  const preview = previewProductNameCleanup(seed);
  const wheel = seed.products.find((p) => p.siteId === "358");
  assert.ok(wheel);
  const row = preview.rows.find((r) => r.productId === wheel.id);
  assert.equal(row.status, "HOLD");
  assert.equal(row.newName, wheel.name);
  assert.ok(!row.newName.startsWith("P000"));
});

test("Applying approved rows never edits IDs, variants, prices or the input state", () => {
  const original = JSON.stringify(seed);
  const before = seed.products.map((p) => ({
    id: p.id, code: p.code, variants: p.variants, siteId: p.siteId,
    category: p.category, catalog: p.catalog,
  }));
  const preview = previewProductNameCleanup(seed);
  const result = applyProductNameCleanup(seed, preview);
  assert.equal(JSON.stringify(seed), original, "State argument was mutated");
  assert.equal(result.changed, preview.rows.filter((r) => r.status === "READY").length);
  assert.equal(JSON.stringify(result.next.products.map((p) => ({
    id: p.id, code: p.code, variants: p.variants, siteId: p.siteId,
    category: p.category, catalog: p.catalog,
  }))), JSON.stringify(before));
  const sample = result.next.products.find((p) => p.siteId === "240");
  assert.equal(sample.name, "BD 803");
  assert.ok(sample.originalName.includes("반도스탠드"));
});

test("Stale approval is rejected and second pass does not rename approved products", () => {
  const preview = previewProductNameCleanup(seed);
  assert.throws(() => applyProductNameCleanup({ ...seed, revision: 1 }, preview), /변경되었습니다/);
  const { next } = applyProductNameCleanup(seed, preview);
  const second = previewProductNameCleanup(next);
  assert.equal(second.rows.filter((r) => r.status === "READY").length, 0);
});

test("Name cleanup is available only with a preview, acknowledgment, backup and explicit save", () => {
  const ui = read("src/ProductNameCleanupPanel.tsx");
  const manager = read("src/ProductManager.tsx");
  assert.match(ui, /previewProductNameCleanup\(current\)/);
  assert.match(ui, /await window\.bando!\.backup\(\)/);
  assert.match(ui, /applyProductNameCleanup\(latest, preview\)/);
  assert.match(ui, /await onSave\(next\)/);
  assert.match(ui, /!accepted/);
  assert.match(manager, /<ProductNameCleanupPanel/);
  assert.match(manager, /p\.originalName \?\? ""/);
});

test("Explicit included and excluded contents stay in shared product names", () => {
  const original=seed.products.find((p)=>p.siteId==="259");
  assert.ok(original);
  const pairs=[
    ["가방 포함","BD 700 / 가방 포함"],
    ["가방 미포함","BD 700 / 가방 미포함"],
    ["바퀴 포함","BD 700 / 바퀴 포함"],
    ["바퀴 미포함","BD 700 / 바퀴 미포함"],
    ["바퀴없음","BD 700 / 바퀴 미포함"],
  ];
  for(const [suffix, expected] of pairs) {
    const fixture=structuredClone(seed);
    const target=fixture.products.find((p)=>p.siteId==="259");
    target.name="반도스탠드 BD 700 "+suffix;
    const report=previewProductNameCleanup(fixture).rows.find((r)=>r.productId===target.id);
    assert.equal(report.status,"READY");
    assert.equal(report.newName,expected);
    assert.doesNotMatch(report.newDescription,/가방|바퀴/);
    const result=applyProductNameCleanup(fixture,previewProductNameCleanup(fixture));
    const saved=result.next.products.find((p)=>p.id===target.id);
    assert.equal(saved.name,expected);
    assert.deepEqual(saved.variants,target.variants);
  }
});

test("Missing opposite configuration is not silently assumed or auto-created", () => {
  const fixture=structuredClone(seed);
  const parent=fixture.products.find((p)=>p.siteId==="259");
  const sibling={...structuredClone(parent),id:"synthetic-bag-unknown",
    name:"반도스탠드 BD 700",siteId:"SYNTHETIC",siteRefs:["SYNTHETIC"],
    variants:[{...structuredClone(parent.variants[0]),id:"synthetic-variant"}]};
  fixture.products.push(sibling);
  const preview=previewProductNameCleanup(fixture);
  const row=preview.rows.find((r)=>r.productId===sibling.id);
  assert.equal(row.status,"HOLD");
  assert.match(row.reason,/미포함/);
  const applied=applyProductNameCleanup(fixture,preview);
  assert.equal(applied.next.products.length,fixture.products.length);
  assert.equal(applied.next.products.find((p)=>p.id===sibling.id).name,sibling.name);
});

test("One unlabeled variant in a bag or wheel option group is held for review", () => {
  const fixture=structuredClone(seed);
  const p=fixture.products.find((x)=>x.siteId==="259");
  p.variants.push({...structuredClone(p.variants[0]),id:"synthetic-missing",
    option:"",color:"색상 확인 필요"});
  p.variants[0].option="가방 포함";
  const report=previewProductNameCleanup(fixture).rows.find((r)=>r.productId===p.id);
  assert.equal(report.status,"HOLD");
  assert.match(report.reason,/포함/);
});
