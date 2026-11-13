import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { tsImport } from "tsx/esm/api";
const load = name => JSON.parse(readFileSync(new URL("../"+name,import.meta.url),"utf8"));
const seed = load("src-tauri/resources/state-seed.json");
const old = load("src-tauri/resources/legacy-state-seed-303.json");
const map = load("src-tauri/resources/product-name-enrichment-20261109.json");
const byId = new Map(seed.products.map(p => [p.id,p]));
const oldById = new Map(old.products.map(p => [p.id,p]));
const specifications = [
  ["228","BD LED-3 / Mighty Bright Light","bando-228-single",31000],
  ["229","BD LED-2S / Mighty Bright Light","bando-229-single",31000],
  ["301","BD LED-2W / Mighty Bright Wonderflex / 보면대등","bando-301-single",38000],
  ["302","BD LED-3N / Mighty Bright Nuflex / 보면대등","bando-302-single",45000],
];

test("four Mighty Bright products have consistent BD LED-model-first business names",()=>{
  for(const [site,name,priceId,retail] of specifications) {
    const p=byId.get("bando-site-"+site);
    assert.ok(p,site);
    assert.equal(p.name,name,site);
    assert.equal(p.variants.length,1,site);
    assert.equal(p.variants[0].id,priceId,site);
    assert.equal(p.variants[0].retail,retail,site);
    assert.deepEqual(p.variants[0],oldById.get(p.id).variants[0],site);
    assert.equal(p.originalName,oldById.get(p.id).originalName,site);
    assert.ok(p.name.startsWith("BD LED-"),site);
    assert.ok(!p.name.includes("색상 확인 필요"),site);
  }
  assert.equal(seed.products.length,360);
  assert.ok(seed.products.every(p=>p.variants.length===1));
});

test("Mighty Bright descriptions are not repeated and source titles remain available",()=>{
  for(const site of ["228","229"]) {
    const p=byId.get("bando-site-"+site);
    assert.ok(!p.subtitle?.trim(),site);
  }
  for(const site of ["301","302"]) {
    const p=byId.get("bando-site-"+site);
    assert.equal(p.subtitle,"건전지 및 어댑터 방식");
    assert.ok(p.originalName.includes("LED-"));
  }
  const old229 = map.changes.find(c=>c.id==="bando-site-229");
  assert.equal(old229.newName,"BD LED-2S / Mighty Bright Light");
  assert.equal(old229.oldName,"BD LED-2s");
  assert.equal(map.changes.length,92);
});

test("customer-facing order item uses new normalized LED title, not raw homepage title",async()=>{
  const {itemFromProduct,unassignedClient}=await tsImport("../src/domain.ts",import.meta.url);
  for(const [site,name] of specifications) {
    const p=byId.get("bando-site-"+site);
    const item=itemFromProduct(p,unassignedClient,p.variants[0].color,1,p.variants[0].id);
    assert.equal(item.name,name,site);
    assert.equal(item.productId,p.id,site);
    assert.equal(item.variantId,p.variants[0].id,site);
  }
});
