import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { tsImport } from "tsx/esm/api";
const read = path => readFileSync(new URL("../" + path, import.meta.url), "utf8");
const seed = JSON.parse(read("src-tauri/resources/state-seed.json"));
const itemByCode = code => seed.products.find(p => p.code === code);
const siteProduct = site => seed.products.find(p => p.siteId === site);

test("No model code based auto-family groups or prefilled color groups",async()=>{
  const {suggestGroupColor}=await tsImport("../src/color-guidance.ts",import.meta.url);
  const state=structuredClone(seed);
  assert.equal(state.settings.colorGuidanceGroups,undefined);
  const black=siteProduct("245"), silver=siteProduct("254");
  assert.equal(suggestGroupColor(state,[black,silver]),undefined);
  const ui=read("src/ColorGuidanceManager.tsx");
  assert.match(ui,/그룹 생성/);
  assert.match(ui,/<h3>상품 추가<\/h3>/);
  assert.match(ui,/대표모델/);
  assert.match(ui,/validateModelGroups/);
  assert.match(ui,/await window.bando.backup\(\)/);
  assert.match(ui,/window.bando.patchSettings/);
  assert.doesNotMatch(read("src/parser.ts"),/baseModelCandidates|modelRepresentatives|modelGroup\(/);
  assert.doesNotMatch(read("src/ProductManager.tsx"),/RepresentativeManager|isRepresentative/);
});

test("Same price JS-2 colors can form a user-registered representative group",async()=>{
  const {suggestGroupColor,validateColorGuidance}=await tsImport("../src/color-guidance.ts",import.meta.url);
  const state=structuredClone(seed),black=siteProduct("245"),silver=siteProduct("254");
  assert.equal(black.variants[0].retail,46000);
  assert.equal(silver.variants[0].retail,46000);
  state.settings.colorGuidanceGroups={staff:{name:"Desk JS-2",productIds:[black.id,silver.id],representativeColor:"Black"}};
  assert.doesNotThrow(()=>validateColorGuidance(state));
  assert.deepEqual(suggestGroupColor(state,[black,silver]),{groupId:"staff",color:"블랙"});
});

test("709 Black perforated-top is its own model; unlike Gray it costs 59,000",async()=>{
  const {validateColorGuidance}=await tsImport("../src/color-guidance.ts",import.meta.url);
  const black=itemByCode("BD 709"),gray=itemByCode("BD 709G");
  assert.equal(black.name,"BD 709 / 블랙 / 타공 상판");
  assert.equal(gray.name,"BD 709G / 그레이");
  assert.equal(black.variants[0].retail,59000);
  assert.equal(gray.variants[0].retail,65000);
  const state=structuredClone(seed);
  state.settings.colorGuidanceGroups={bad:{name:"709",productIds:[black.id,gray.id],representativeColor:"Black"}};
  assert.throws(()=>validateColorGuidance(state),/가격/);
});

test("Same-color perforated and nonperforated tops must not be mistaken for color variants",async()=>{
  const {validateColorGuidance}=await tsImport("../src/color-guidance.ts",import.meta.url);
  const state=structuredClone(seed);
  const a=itemByCode("BD 709"),b=itemByCode("BD 709-1");
  state.settings.colorGuidanceGroups={bad:{name:"상판",productIds:[a.id,b.id],representativeColor:"Black"}};
  assert.throws(()=>validateColorGuidance(state),/같은 색상/);
});

test("Unspecified color JS-2 stays unresolved until staff chooses from error dialog",async()=>{
  const {parseSmart}=await tsImport("../src/parser.ts",import.meta.url);
  const {appliedDefaultColorNotice,suggestGroupColor}=await tsImport("../src/color-guidance.ts",import.meta.url);
  const {resolveProduct}=await tsImport("../src/issue-actions.ts",import.meta.url);
  const state=structuredClone(seed),black=siteProduct("245"),silver=siteProduct("254");
  const client={id:"test-client",name:"가상 거래처",contact:"",identifiers:"",active:true,tier:"wholesale",shippingFeeExcluded:false,payment:"PREPAID",overrides:{}};
  state.clients.push(client);
  state.settings.colorGuidanceGroups={staff:{name:"JS-2",productIds:[black.id,silver.id],representativeColor:"Black"}};
  const recipients=parseSmart("BD Desk JS-2 3개",client,state);
  const item=recipients.flatMap(r=>r.items).find(i=>i.raw.includes("JS-2"));
  assert.ok(item,JSON.stringify(recipients));
  assert.equal(item.productId,null);
  assert.equal(item.variantId,null);
  assert.equal(item.appliedDefaultColor,undefined);
  const candidates=(item.productCandidates??[]).map(x=>state.products.find(p=>p.id===x.productId)).filter(Boolean);
  assert.deepEqual(suggestGroupColor(state,candidates),{groupId:"staff",color:"블랙"});
  const order={id:"test-order",clientId:client.id,recipients:[{id:"r1",items:[item]}]};
  const result=resolveProduct(state,order,"r1",item.id,black.id,"once",false,black.variants[0].id,"staff");
  const selected=result.order.recipients[0].items[0];
  assert.equal(selected.productId,black.id);
  assert.equal(selected.variantId,black.variants[0].id);
  assert.equal(selected.appliedDefaultColor.color,"Black");
  assert.equal(selected.modelProposal,undefined);
  assert.equal(appliedDefaultColorNotice(selected),"블랙으로 보내드릴게요.");
  assert.doesNotMatch(appliedDefaultColorNotice(selected),/진행해도 될까요/);
});

test("Explicit color or unrelated products never receive default-color notification",async()=>{
  const {parseSmart}=await tsImport("../src/parser.ts",import.meta.url);
  const {appliedDefaultColorNotice}=await tsImport("../src/color-guidance.ts",import.meta.url);
  const state=structuredClone(seed),client={id:"c",name:"가상 거래처"};
  for(const input of ["BD 709 3개","BD 709G 3개","BD Desk JS-2 블랙 3개"]){
    const rows=parseSmart(input,client,state).flatMap(r=>r.items);
    assert.ok(rows.length,input);
    for(const row of rows){
      assert.equal(row.appliedDefaultColor,undefined);
      assert.equal(appliedDefaultColorNotice(row),"");
    }
  }
});

test("Copy messages notify only after employee action, without dealer choice request",()=>{
 const helper=read("src/color-guidance.ts");
 const a=read("src/automatic-message.ts"),h=read("src/hub-messages.ts");
 assert.doesNotMatch(helper,/진행해도 될까요/);
 assert.match(a,/appliedDefaultColorNotice/);
 assert.match(h,/appliedDefaultColorNotice/);
 assert.match(read("src/IssueResolver.tsx"),/대표모델.*선택/);
 assert.match(read("src/issue-actions.ts"),/validateColorGroupProducts/);
 const native=read("src-tauri/src/lib.rs");
 assert.match(native,/"colorGuidanceGroups"/);
 assert.match(native,/색상별 가격이 다른 상품/);
 assert.doesNotMatch(native,/"modelRepresentatives", "modelFamilies"/);
});
