import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { tsImport } from "tsx/esm/api";
const read = path => readFileSync(new URL("../"+path,import.meta.url),"utf8");
const seed = JSON.parse(read("src-tauri/resources/state-seed.json"));
const p709=seed.products.find(p=>p.code==="BD 709");
const p709NoHoles=seed.products.find(p=>p.code==="BD 709-1");
const info="709는 구멍이 있는 상판입니다. 구멍이 없는 제품을 원하시면 709-1을 확인해 주세요.";

function item(expression,product=p709){
  return {
    productId:product.id,variantId:product.variants[0].id,
    selectionEvidence:{
      expression,productId:product.id,variantId:product.variants[0].id,
    },
  };
}

test("no preloaded product-specific provisional notices and manual management tab",()=>{
  assert.ok(p709 && p709NoHoles);
  assert.equal(seed.settings.provisionalProductNotices,undefined);
  const clientUI=read("src/ClientManager.tsx");
  assert.match(clientUI,/잠정 상품 선택 안내/);
  assert.match(clientUI,/ProvisionalProductNoticeManager/);
  assert.doesNotMatch(read("src/ProductManager.tsx"),/ProvisionalProductNoticeManager/);
});

test("employees add or delete independent product notices with stable product IDs",async()=>{
  const {validateProvisionalProductNotices}=await tsImport("../src/provisional-product-notices.ts",import.meta.url);
  const s=structuredClone(seed);
  s.settings.provisionalProductNotices={
    [p709.id]:info,
    [p709NoHoles.id]:"709-1은 구멍이 없는 상판입니다.",
  };
  assert.doesNotThrow(()=>validateProvisionalProductNotices(s));
  delete s.settings.provisionalProductNotices[p709NoHoles.id];
  assert.doesNotThrow(()=>validateProvisionalProductNotices(s));
  s.settings.provisionalProductNotices.invalid="존재하지 않는 상품";
  assert.throws(()=>validateProvisionalProductNotices(s),/등록된 상품/);
  delete s.settings.provisionalProductNotices.invalid;
  s.settings.provisionalProductNotices[p709.id]="";
  assert.throws(()=>validateProvisionalProductNotices(s),/1자 이상/);
});

test("explicit 709 orders must NOT print product-specific notes",async()=>{
  const {provisionalProductNotice}=await tsImport("../src/provisional-product-notices.ts",import.meta.url);
  const state=structuredClone(seed);
  state.settings.provisionalProductNotices={[p709.id]:info};
  for(const text of ["709 3개","BD 709 3개","BD709 3개","709 모델 2개","보면대 BD 709"]){
    assert.equal(provisionalProductNotice(item(text),state),"",text);
  }
  assert.equal(provisionalProductNotice({...item("보면대"),selectionEvidence:undefined},state),"");
});

test("manually resolving '보면대' as 709 prints note whether or not a link exists",async()=>{
  const {provisionalProductNotice}=await tsImport("../src/provisional-product-notices.ts",import.meta.url);
  const state=structuredClone(seed);
  state.settings.provisionalProductNotices={[p709.id]:info};
  assert.equal(provisionalProductNotice(item("보면대 3개"),state),info);
  assert.equal(provisionalProductNotice({...item("보면대"),url:""},state),info);
  assert.equal(provisionalProductNotice({...item("보면대"),url:"https://www.bandostand.com/"},state),info);
  assert.equal(provisionalProductNotice({...item("보면대"),modelProposal:{original:"보면대",required:false}},state),info);
  assert.equal(provisionalProductNotice({...item("보면대"),productId:p709NoHoles.id},state),"");
});

test("709 vs 709-1 are not mistaken for exact code matches",async()=>{
  const {originalStatesChosenCode}=await tsImport("../src/provisional-product-notices.ts",import.meta.url);
  assert.equal(originalStatesChosenCode("709-1 2개",p709),false);
  assert.equal(originalStatesChosenCode("709G 2개",p709),false);
  assert.equal(originalStatesChosenCode("709 2개",p709NoHoles),false);
  assert.equal(originalStatesChosenCode("BD 709-1 2개",p709NoHoles),true);
});

test("copy message orders all finance lines, then provisional note, then links",()=>{
  const s=read("src/hub-messages.ts");
  const idxTotal=s.indexOf('parts.push(renderAutomaticTemplate(state.settings,"paymentTotal"');
  const idxAccount=s.indexOf('parts.push("", accountLine);');
  const idxNotice=s.indexOf('const provisionalNotices = recipients.flatMap');
  const idxLinks=s.indexOf('const paymentLinks = links.payment');
  assert.ok(idxTotal>=0&&idxAccount>idxTotal&&idxNotice>idxAccount&&idxLinks>idxNotice);
  assert.match(s,/if \(provisionalNotices\.length\) parts\.push\("", \.\.\.provisionalNotices\);\s*if \(paymentLinks\.length\) parts\.push\("", \.\.\.paymentLinks\)/);
  assert.doesNotMatch(s,/if \(links\.payment\)\s*for \(const line/);
  assert.match(read("src/ProvisionalProductNoticeManager.tsx"),/합계, 입금 계좌[\s\S]*?content\.trim\(\)[\s\S]*?상품 링크/);
});

test("native settings-only patch saves notice map without touching sale products",()=>{
  const s=read("src/ProvisionalProductNoticeManager.tsx");
  const native=read("src-tauri/src/lib.rs");
  assert.match(s,/await window\.bando\.backup\(\)/);
  assert.match(s,/await window\.bando\.patchSettings\(/);
  assert.match(s,/provisionalProductNotices:baseline/);
  assert.match(native,/"provisionalProductNotices"/);
  assert.match(native,/validate_provisional_product_notices\(&state\)/);
});
