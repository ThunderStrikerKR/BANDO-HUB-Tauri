import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { tsImport } from "tsx/esm/api";

const read = (p) => JSON.parse(readFileSync(new URL("../" + p, import.meta.url), "utf8"));
const seed = read("src-tauri/resources/state-seed.json");
const { resolveHistoricalProductReference: resolve } =
  await tsImport("../src/historical-product-reference.ts", import.meta.url);

test("frozen parent and price IDs map to one correct independent sale unit",()=>{
  const old="bando-site-351";
  const clear="bando-351-P00000NN000B";
  const frost="bando-351-P00000NN000C";
  const first=resolve(seed,old,clear);
  const second=resolve(seed,old,frost);
  assert.equal(first?.via,"HISTORICAL");
  assert.equal(second?.via,"HISTORICAL");
  assert.notEqual(first.product.id,second.product.id);
  assert.equal(first.product.variants.length,1);
  assert.equal(first.product.variants[0].id,clear);
  assert.equal(second.product.variants[0].id,frost);
  assert.match(first.product.name,/클리어/);
  assert.match(second.product.name,/프로스트/);
});

test("current product references resolve directly without changing ID or price",()=>{
  const original=seed.products.find((p)=>p.siteId==="351"&&/클리어/.test(p.name));
  const reference=resolve(seed,original.id,original.variants[0].id);
  assert.equal(reference?.via,"CURRENT");
  assert.equal(reference?.product,original);
});

test("unknown and ambiguous identities never select by same code, name or color",()=>{
  const state=structuredClone(seed);
  const before=JSON.stringify(state);
  const old="bando-site-351", clear="bando-351-P00000NN000B";
  assert.equal(resolve(state,old,null),null);
  assert.equal(resolve(state,old,"unknown-variant"),null);
  assert.equal(resolve(state,"not-real",clear),null);
  const target=state.productMappings[old+"|"+clear];
  state.productMappings[old+"|"+clear]="another-product";
  assert.equal(resolve(state,old,clear),null);
  state.productMappings[old+"|"+clear]=target;
  const p=state.products.find((p)=>p.id===target);
  p.variants[0].id="rewritten-price-id";
  assert.equal(resolve(state,old,clear),null);
  p.variants[0].id=clear;
  p.sourceProductId="different-parent";
  assert.equal(resolve(state,old,clear),null);
  const stable=JSON.parse(before);
  assert.equal(resolve(stable,old,clear)?.product.id,target);
});

test("a direct product ID with an incorrect price ID cannot fall back to a mapping",()=>{
  const state=structuredClone(seed);
  const direct=state.products.find((p)=>p.siteId==="351"&&/클리어/.test(p.name));
  state.productMappings[direct.id+"|invalid-price"]=direct.id;
  assert.equal(resolve(state,direct.id,"invalid-price"),null);
});

test("looking up historical references never mutates frozen orders or the catalogue",()=>{
  const state=structuredClone(seed);
  const originalOrder={
    id:"historical-order", confirmedAt:"2026-11-07T23:00:00+09:00",
    recipients:[{id:"r",items:[{id:"i",productId:"bando-site-351",
      variantId:"bando-351-P00000NN000B",name:"확정 당시 상품명",
      quantity:2,unitPrice:123456}]}],
    confirmationSnapshot:{raw:"가상 과거 원문",recipients:[{items:[{
      productId:"bando-site-351",variantId:"bando-351-P00000NN000B",
      name:"확정 당시 상품명",unitPrice:123456}]}]},
  };
  const frozen=JSON.stringify(originalOrder), before=JSON.stringify(state);
  const item=originalOrder.recipients[0].items[0];
  const found=resolve(state,item.productId,item.variantId);
  assert.ok(found);
  assert.equal(found.via,"HISTORICAL");
  assert.equal(JSON.stringify(originalOrder),frozen);
  assert.equal(JSON.stringify(state),before);
  assert.equal(item.unitPrice,123456);
});

test("historical references do not appear falsely discontinued in sale-status reviews",async()=>{
  const { saleIssues } = await tsImport("../src/sale-status.ts", import.meta.url);
  const old="bando-site-351",price="bando-351-P00000NN000B";
  const order={recipients:[{name:"가상 수취인",items:[{
    id:"historic",productId:old,variantId:price,name:"과거의 상품명",
  }]}]};
  assert.deepEqual(saleIssues(seed,order),[]);
  order.recipients[0].items[0].variantId="unverified-price";
  assert.match(saleIssues(seed,order)[0],/상품 연결 확인 필요/);
  assert.doesNotMatch(saleIssues(seed,order)[0],/판매중지/);
});
