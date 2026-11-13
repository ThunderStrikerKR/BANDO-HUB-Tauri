import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const read = file => JSON.parse(readFileSync(new URL("../"+file,import.meta.url),"utf8"));
const seed=read("src-tauri/resources/state-seed.json");
const legacy=read("src-tauri/resources/legacy-state-seed-303.json");
const spec=read("src-tauri/resources/microphone-stand-specifications-20261109.json");

test("both specification tables cover 18 physical models in 21 independent sale records",()=>{
  assert.equal(spec.modelCount,18);
  assert.equal(spec.independentProducts,21);
  assert.equal(spec.items.length,21);
  assert.equal(new Set(spec.items.map(i=>i.id)).size,21);
  assert.equal(new Set(spec.items.map(i=>i.type+" "+i.model)).size,18);
  assert.equal(seed.products.length,360);
  assert.ok(seed.products.every(p=>p.variants.length===1));
});
test("all DESK and FLOOR titles/descriptions correspond to their exact cited specification",()=>{
  const byId=new Map(seed.products.map(p=>[p.id,p]));
  const oldById=new Map(legacy.products.map(p=>[p.id,p]));
  for(const item of spec.items) {
    const p=byId.get(item.id);
    assert.ok(p,item.id);
    assert.equal(p.siteId,item.siteId);
    assert.equal(p.name,item.name,item.id);
    assert.equal(p.subtitle,item.subtitle,item.id);
    assert.equal(p.originalName,item.originalName,item.id);
    assert.equal(p.variants[0].id,item.priceRecordId,item.id);
    assert.deepEqual(p.variants,oldById.get(item.id).variants,item.id);
    assert.ok(p.name.includes(item.color),item.id);
    assert.ok(p.subtitle.includes("높이 "+item.heightCm+"cm"),item.id);
    assert.ok(p.subtitle.includes("무게 "+item.weightKg+"kg"),item.id);
    assert.ok(p.subtitle.includes("베이스 높이 "+item.baseHeightCm+"cm"),item.id);
    assert.ok(p.subtitle.includes(item.baseSize),item.id);
    if(item.boomCm!==null)assert.ok(p.subtitle.includes("붐암 길이 "+item.boomCm+"cm"),item.id);
    assert.ok(!p.name.includes("색상 확인 필요"),item.id);
  }
});
test("IS-3 height does not overwrite its distinct official bar length",()=>{
  const p=seed.products.find(p=>p.siteId==="250");
  assert.equal(p.name,"BD Desk IS-3 / 블랙 / Bar 길이 26cm");
  assert.ok(p.subtitle.includes("높이 25cm"));
  assert.ok(p.originalName.includes("Bar 길이 26cm"));
});
test("JS dual colors remain separate with unchanged IDs and no invented configurations",()=>{
  const items=spec.items.filter(x=>x.type==="Desk"&&["JS-2","JS-3","JS-4"].includes(x.model));
  assert.equal(items.length,6);
  for(const model of ["JS-2","JS-3","JS-4"]){
    const row=items.filter(x=>x.model===model);
    assert.deepEqual(new Set(row.map(x=>x.color)),new Set(["블랙","실버"]));
    assert.notEqual(row[0].id,row[1].id);
  }
  assert.equal(spec.items.filter(x=>x.type==="Desk"&&x.model==="JS-1").length,1);
});


test("IS uses exact Bar length and JS uses exact gooseneck length in sellable product names",()=>{
  const bySite=new Map(seed.products.map(p=>[p.siteId,p]));
  const isLengths=[["252",10],["251",15],["250",26]];
  const jsLengths=[["253",25],["245",35],["254",35],["246",43],["255",43],["310",60],["256",60],["319",35],["320",43],["321",60]];
  for(const [site,length] of isLengths){
    const p=bySite.get(site);
    assert.ok(p?.name.includes("Bar 길이 "+length+"cm"),site);
    assert.ok(!p.name.includes("자바라 길이"),site);
  }
  for(const [site,length] of jsLengths){
    const p=bySite.get(site);
    assert.ok(p?.name.includes("자바라 길이 "+length+"cm"),site);
    assert.ok(!p.name.includes(" / 높이 "),site);
  }
  for(const [site,model,length] of [["319",2,35],["320",3,43],["321",4,60]]){
    const item=spec.items.find(p=>p.siteId===site);
    assert.deepEqual(item.previousNames,["BD FloorJS-"+model+"BK / 블랙 / 높이 "+length+"cm"]);
    assert.equal(item.name,"BD FloorJS-"+model+"BK / 블랙 / 자바라 길이 "+length+"cm");
  }
});
