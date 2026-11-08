import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const load = (path) => JSON.parse(readFileSync(new URL("../" + path, import.meta.url), "utf8"));
const src = (path) => readFileSync(new URL("../" + path, import.meta.url), "utf8");
const current = load("src-tauri/resources/state-seed.json");
const historic = load("src-tauri/resources/legacy-state-seed-303.json");
const plan = load("src-tauri/resources/product-name-enrichment-20261109.json");
const byId = new Map(current.products.map(p => [p.id,p]));

test("360 independent products retain original historical identity and price data", () => {
  assert.equal(current.products.length,360);
  assert.equal(current.products.reduce((sum,p)=>sum+p.variants.length,0),360);
  assert.equal(new Set(current.products.map(p=>p.id)).size,360);
  const priceOriginal = new Map(historic.products.flatMap(p=>p.variants.map(v=>[v.id,v])));
  assert.equal(priceOriginal.size,360);
  for(const p of current.products) {
    assert.equal(p.variants.length,1,p.id);
    assert.equal(p.saleUnit,true,p.id);
    assert.equal(p.requiresOption,false,p.id);
    const previous = priceOriginal.get(p.variants[0].id);
    assert.ok(previous,p.id);
    for(const field of ["id","color","option","siteOptionId","wholesale","semi","retail","officialRetail","url","source","collectedAt"])
      assert.deepEqual(p.variants[0][field], previous[field],p.id+" / "+field);
    assert.ok(!p.name.includes("◆"),p.id);
  }
});

test("92 exact mapped names have source-grounded change records; no unproven descriptions are fabricated", ()=>{
  assert.equal(plan.changes.length,92);
  const ids = new Set();
  for (const row of plan.changes){
    assert.ok(!ids.has(row.id),row.id); ids.add(row.id);
    const target=byId.get(row.id);
    assert.ok(target);
    assert.equal(target.name,row.newName,row.id);
    assert.equal(target.code,row.oldName,row.id);
    assert.equal(target.originalName,row.originalName,row.id);
    assert.equal(target.variants[0].id,row.priceRecordId,row.id);
    assert.ok(row.newName.toLowerCase().startsWith((row.oldName+" / ").toLowerCase()),row.id);
    assert.ok(!row.newName.includes("◆"),row.id);
  }
  const held = current.products.filter(p=>p.name===p.code);
  assert.deepEqual(held.map(p=>p.name).sort(),[
    "BD BB-1","BD BB-2","BD BB-3","BD BB-4","BD BB-5","BD Desk 101"
  ].sort());
  assert.equal(current.products.filter(p=>p.name.includes(" / ")).length,340);
  assert.equal(current.products.find(p=>p.siteId==="312").name,"BD 777 / 고정형 보면대");
  assert.equal(current.products.find(p=>p.siteId==="241").name,"BD 803-1 / 성악 및 녹음용 보면대");
});

test("factory diamond never leaks into product names, buyer messages, or store export",()=>{
  const factory = src("src/factory-export.ts");
  assert.match(factory,/"◆ " \+ trim\(item\.name\)/);
  assert.ok(!src("src/hub-messages.ts").includes("◆"));
  assert.ok(!src("src/domain.ts").includes("◆"));
  assert.ok(!src("src/automatic-message.ts").includes("◆"));
  assert.ok(!src("src/store-export.ts").includes("◆"));
  assert.ok(current.products.every(p=>!p.name.includes("◆")));
  assert.ok(plan.changes.every(p=>!p.newName.includes("◆")));
});

test("all 360 curated product names are unbranded while official titles stay traceable", () => {
  assert.equal(current.products.length, 360);
  const raw = current.products.filter(p => p.originalName?.startsWith("반도스탠드 "));
  assert.equal(raw.length, 357);
  assert.ok(current.products.every(p => !p.name.startsWith("반도스탠드 ")));
  assert.equal(current.products.find(p => p.siteId==="246").name,
    "BD Desk JS-3 / 블랙 / 자바라 길이 43cm");
  assert.equal(current.products.find(p => p.siteId==="255").name,
    "BD Desk JS-3 / 실버 / 자바라 길이 43cm");
  assert.equal(current.products.find(p => p.siteId==="254").name,
    "BD Desk JS-2 / 실버 / 자바라 길이 35cm");
  assert.equal(current.products.find(p => p.siteId==="310").name,
    "BD Desk JS-4 / 블랙 / 자바라 길이 60cm");
  const manager = src("src/ProductManager.tsx");
  assert.match(manager, /\{p\.name\}/);
  assert.doesNotMatch(manager, /\{p\.originalName\}/);
});
