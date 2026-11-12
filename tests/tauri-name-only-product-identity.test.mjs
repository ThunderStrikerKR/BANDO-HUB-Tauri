import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { tsImport } from "tsx/esm/api";

const seed = JSON.parse(readFileSync(new URL("../src-tauri/resources/state-seed.json",import.meta.url),"utf8"));
const {productModelNames,productNameEvidence,registeredNameCandidates} =
  await tsImport("../src/product-name-match.ts",import.meta.url);
const {aliasProblems,sameProduct} = await tsImport("../src/matching.ts",import.meta.url);
const {previewCsv} = await tsImport("../src/csv.ts",import.meta.url);

const cart10 = seed.products.find(p=>p.siteId==="83");
const cart20 = seed.products.find(p=>p.siteId==="84");

test("explicit Cart-10 and Cart-20 in registered NAMES work without legacy codes",()=>{
  assert.deepEqual(productModelNames(cart10),["Cart-10"]);
  assert.equal(registeredNameCandidates([cart10,cart20],"보면대카트 Cart-10 2개")[0].id,cart10.id);
  assert.equal(registeredNameCandidates([cart10,cart20],"보면대카트 Cart-20 2개")[0].id,cart20.id);
  assert.equal(registeredNameCandidates([cart10,cart20],"보면대카트 2개").length,0);
  const renamed = {...cart10,code:"unrelated-hidden-value",modelCodes:["WRONG"]};
  assert.ok(productNameEvidence("보면대카트 Cart-10 2개",renamed));
});

test("709 cannot match 709-1; Cart-10 cannot match Cart-100",()=>{
  const originals=seed.products.filter(p=>/BD 709(?:-1)? /.test(p.name));
  const hole=originals.find(p=>/^BD 709 \//.test(p.name));
  assert.ok(hole);
  assert.equal(productNameEvidence("BD 709-1 1개",hole),null);
  assert.equal(productNameEvidence("Cart-100 1개",cart10),null);
});

test("two distinct products with the exact same name remain ambiguous",()=>{
  const products=seed.products.filter(p=>p.name==="마이크물림쇠 세트 / 35cm / 블랙");
  assert.equal(products.length,2);
  assert.equal(registeredNameCandidates(products,"마이크물림쇠 세트 / 35cm / 블랙 1개").length,2);
  assert.equal(sameProduct(products[0],products[1]),false);
});

test("alias cannot impersonate a different registered product name",()=>{
  const alias={id:"synthetic-alias",clientId:null,text:"Cart-20",productId:cart10.id};
  assert.ok(aliasProblems(alias,[],[cart10,cart20]).some(v=>v.includes("충돌")));
});

test("code-free CSV produces one independent product per sale row",()=>{
  const previews=previewCsv([
    "name,category,origin,defaultColor,color,wholesale,semi,retail,url,source,collectedAt",
    "Cart-99 / 보면대카트,보면대,FACTORY,단일,단일,100,200,300,,MANUAL,",
  ].join("\n"),[]);
  assert.equal(previews.length,1);
  assert.equal(previews[0].product.name,"Cart-99 / 보면대카트");
  assert.equal(previews[0].product.variants.length,1);
  assert.equal(previews[0].product.code,previews[0].product.id);
  assert.deepEqual(previews[0].warnings,[]);
});

test("obsolete CSV code column is ignored instead of becoming a product identity",()=>{
  const previews=previewCsv([
    "code,name,category,origin,defaultColor,color,wholesale,semi,retail,url,source,collectedAt",
    "P00000DE,Cart-99 / 보면대카트,보면대,FACTORY,단일,단일,100,200,300,,MANUAL,",
  ].join("\n"),[]);
  assert.notEqual(previews[0].product.code,"P00000DE");
  assert.equal(previews[0].product.code,previews[0].product.id);
});
