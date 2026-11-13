/** End-to-end TS oracle: full automatic-message text, link, phase, invoice issues,
 * and historical payment-copy signature against the compiled Rust state renderer.
 * This is intentionally a production Rust call, not a source-pattern test.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tsImport } from "tsx/esm/api";

const { automaticMessage, paymentSignature, paymentWasCopied } =
  await tsImport("../../../src/automatic-message.ts",import.meta.url);
const { groupOrder } =
  await tsImport("../../../src/workflow.ts",import.meta.url);
const { validProductUrl } =
  await tsImport("../../../src/domain.ts",import.meta.url);
const root=fileURLToPath(new URL("../../../",import.meta.url));
const manifest=fileURLToPath(new URL("./Cargo.toml",import.meta.url));
const gid="group:o1";
const link="https://www.bandostand.com/product/709";

function base(){
  const now="2026-11-13T09:00:00+09:00";
  const item={id:"i1",productId:"p1",variantId:"v1",name:"BD 709",
    raw:"보면대 2개",color:"Black",quantity:2,quantityConfirmed:true,
    unitPrice:50000,origin:"FACTORY",url:link,issues:[]};
  const r={id:"r1",name:"김민수",address:"서울 종로구 청계천로 1",
    addressStatus:"COMPLETE",phone:"01012345678",mobile:"",
    items:[item],note:"",vatDefault:true};
  const o={id:"o1",clientId:"c1",orderType:"AGENCY",recipients:[r],
    raw:"가상 발주서",createdAt:now,updatedAt:now,freightCode:"010",
    shippingFee:3000,applyVat:true,vatAmount:null,pricesLocked:false,
    status:"REVIEW"};
  const c={id:"c1",name:"가상 거래처",displayName:"가상 상호",
    address:"서울 종로구 종로 1",phone:"02-1234-5678",mobile:"",
    tier:"wholesale",payment:"PREPAID",overrides:{},
    preferredAccountId:"a1",shippingFeeExcluded:false};
  return {
    orders:[o],clients:[c],products:[{id:"p1",code:"709",
      name:"BD 709 / 보면대",category:"보면대",origin:"FACTORY",
      colorStatus:"KNOWN",defaultColor:"Black",active:true,catalog:"BANDOSTAND",
      variants:[{id:"v1",color:"Black",wholesale:50000,semi:55000,
        retail:60000,url:link}]}],
    exports:[],queue:[],aliases:[],
    shipping:{epoch:1,groups:[],productRules:{},combinations:[]},
    settings:{operatorName:"직원",accounts:[{
      id:"a1",bank:"국민은행",number:"123-456",holder:"반도",
      memo:"현재 사용 계좌"
    }],defaultAccountId:"a1",
      senderName:"반도스탠드",senderAddress:"서울 종로구 종로 10",
      senderPhone:"02-742-9929",senderMobile:"",provisionalProductNotices:{}},
    workflow:{sources:[{id:"source:o1",orderId:"o1",dealerId:"c1",
      number:1,raw:"가상 발주서",createdAt:now}],
      groups:[{id:gid,sourceId:"source:o1",dealerId:"c1",
        rootGroupId:gid,createdAt:now,notices:[],needsNotice:false}],
      shipments:[{id:"ship1",sourceId:"source:o1",orderId:"o1",
        recipientId:"r1",groupId:gid,step:2,completedAt:{"1":now,"2":now},
        charges:{FACTORY:3000},chargeMode:"MANUAL",infoSignature:"stable",
        transferred:false}],payments:[],queue:[],events:[],deliveries:[],
      changeRequests:[],confirmations:[]},
  };
}
const scenarios=[];
function add(name,change=()=>{},includeLinks=false){
  const state=base();change(state);
  const original=automaticMessage(state,gid,includeLinks);
  const signature=paymentSignature(state,gid);
  const view=groupOrder(state,gid);
  const links=[...new Set(view.recipients.flatMap(r=>r.items)
    .filter(i=>i.url&&validProductUrl(i.url))
    .map(i=>i.name+"\n"+i.url))];
  scenarios.push({
    name,operation:"render_automatic_message",
    payload:{state,groupId:gid,includeLinks,
      accountWire:state.settings.accounts.map(a=>({
        id:a.id,json:JSON.stringify(a)
      }))},
    baseline:{phase:original.phase,text:original.text,
      paymentIssues:original.paymentIssues,signature,
      validRequestLinks:links},
  });
}
add("valid payment preview at stage 2");
add("valid payment preview with product link",()=>{},true);
add("stage 1 inquiry",s=>{s.workflow.shipments[0].step=1;});
add("missing name blocks request",s=>{s.orders[0].recipients[0].name="";});
add("missing contact blocks request",s=>{s.orders[0].recipients[0].phone="";});
add("missing product model blocks request",s=>{
  const i=s.orders[0].recipients[0].items[0];i.productId=null;i.variantId=null;
});
add("quantity unconfirmed",s=>{
  const i=s.orders[0].recipients[0].items[0];
  i.quantityConfirmed=false;i.quantityApproval={quantity:1,actor:"직원",at:"2026-11-13"};
  i.quantity=1;
});
add("custom customer and payment templates",s=>{
  s.orders[0].recipients[0].phone="";
  s.settings.automaticMessageTemplates={
    contactMissing:"{수취인}님 연락처 확인 요청",
    paymentGreeting:"금액 안내드립니다.",
    paymentItem:"{상품명} / {수량}개 / {금액}",
    paymentAccount:"{은행명} / {계좌번호} / {예금주}",
  };
});
add("representative model notice",s=>{
  s.orders[0].recipients[0].items[0].appliedRepresentativeModel={
    groupId:"models",productId:"p1",productName:"BD 709"
  };
});
add("color default notification",s=>{
  s.orders[0].recipients[0].items[0].appliedDefaultColor={
    groupId:"colors",color:"Black"
  };
});
add("conditional employee product notice",s=>{
  const i=s.orders[0].recipients[0].items[0];
  i.selectionEvidence={expression:"보면대",productId:"p1",variantId:"v1"};
  s.settings.provisionalProductNotices={p1:"상판 구멍 여부를 확인하세요."};
});
add("provisional notice suppressed by explicit model",s=>{
  const i=s.orders[0].recipients[0].items[0];
  i.selectionEvidence={expression:"BD 709",productId:"p1",variantId:"v1"};
  s.settings.provisionalProductNotices={p1:"표시되면 안 되는 안내"};
});
add("collect freight",s=>{s.orders[0].freightCode="020";});
add("VAT separately",s=>{s.orders[0].applyVat=false;
  s.orders[0].recipients[0].vatDefault=false;});
add("manual bank account",s=>{s.orders[0].accountMode="MANUAL";
  s.orders[0].accountId="a2";s.settings.accounts.push({
    id:"a2",bank:"농협",number:"555-123",holder:"새 계좌"
  });});
add("missing account",s=>{s.settings.accounts=[];});
add("mixed VAT across two recipients",s=>{
  const next=structuredClone(s.orders[0].recipients[0]);
  next.id="r2";next.name="박민수";next.items[0].id="i2";
  next.vatOverride=false;s.orders[0].recipients.push(next);
  s.workflow.shipments.push({...structuredClone(s.workflow.shipments[0]),
    id:"ship2",recipientId:"r2",charges:{FACTORY:4000}});
},true);
add("customer confirmed proposed product",s=>{
  const i=s.orders[0].recipients[0].items[0];
  i.modelProposal={original:"보면대",required:true};
});
const requests=scenarios.map(({operation,payload})=>({operation,payload}));

test("full TS automatic message and copy signature match compiled Rust",()=>{
  const result=spawnSync("cargo",["run","--quiet","--manifest-path",manifest,
    "--bin","parity_runner"],{cwd:root,input:JSON.stringify(requests),
      encoding:"utf8",timeout:180000,maxBuffer:64*1024*1024});
  if(result.error)throw result.error;
  assert.equal(result.status,0,result.stderr);
  const actual=JSON.parse(result.stdout), mismatches=[];
  assert.equal(actual.length,scenarios.length);
  scenarios.forEach((scenario,i)=>{
    try{assert.deepStrictEqual(actual[i],{ok:true,value:scenario.baseline});}
    catch{mismatches.push({name:scenario.name,ts:scenario.baseline,rust:actual[i]});}
  });
  if(mismatches.length)console.error(JSON.stringify(mismatches,null,2));
  assert.equal(mismatches.length,0,
    mismatches.length+" of "+scenarios.length+" full automatic cases differ");
});
test("an already-copied payment uses the identical stored original TS signature",()=>{
  const state=base();
  state.workflow.events.push({id:"copy-1",groupId:gid,
    action:"메시지 복사",after:{type:"PAYMENT",signature:paymentSignature(state,gid)}});
  assert.equal(paymentWasCopied(state,gid),true);
  const input=[{operation:"payment_copy_status",
    payload:{state,groupId:gid,mode:"payment_copy_status",
      accountWire:state.settings.accounts.map(a=>({id:a.id,json:JSON.stringify(a)}))}}];
  const r=spawnSync("cargo",["run","--quiet","--manifest-path",manifest,
    "--bin","parity_runner"],{cwd:root,input:JSON.stringify(input),
      encoding:"utf8",timeout:180000,maxBuffer:64*1024*1024});
  if(r.error)throw r.error;
  assert.equal(r.status,0,r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout),[{ok:true,value:{copied:true}}]);
});
