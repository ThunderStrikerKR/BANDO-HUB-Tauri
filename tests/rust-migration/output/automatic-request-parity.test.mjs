/** Independent actual TS automaticMessage request-phase oracle. */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tsImport } from "tsx/esm/api";

const { automaticMessage } = await tsImport("../../../src/automatic-message.ts",import.meta.url);
const { groupOrder, groupStep, workflowIssues } = await tsImport("../../../src/workflow.ts",import.meta.url);
const root=fileURLToPath(new URL("../../../",import.meta.url));
const manifest=fileURLToPath(new URL("./Cargo.toml",import.meta.url));
const gid="group:o1";
function base(){
  const now="2026-11-13T09:00:00+09:00";
  const client={
    id:"dealer-1",tier:"wholesale",payment:"POSTPAID",
    name:"가상 거래처",displayName:"가상 거래처",address:"서울시 가상로 1",
    phone:"02-1234-5678",mobile:"",overrides:{},shippingFeeExcluded:false,
    preferredAccountId:"account-1",
  };
  const item={
    id:"item1",productId:"p1",variantId:"v1",name:"가상 상품",
    quantity:2,unitPrice:30000,origin:"FACTORY",color:"Black",
    quantityConfirmed:true,issues:[],url:"",
    raw:"가상 상품",
  };
  const recipient={
    id:"r1",name:"가상 수취인",address:"서울시 가상로 1",
    phone:"010-1234-5678",mobile:"",items:[item],note:"",vatDefault:true,
  };
  const order={
    id:"o1",clientId:"dealer-1",recipients:[recipient],raw:"가상 발주서",
    freightCode:"010",shippingFee:3000,applyVat:true,vatAmount:null,
    orderType:"AGENCY",status:"REVIEW",createdAt:now,updatedAt:now,
  };
  return {
    products:[{id:"p1",name:"가상 상품",origin:"FACTORY",active:true,
      shippingGroupId:"music",variants:[{id:"v1",color:"Black",
        wholesale:30000,semi:35000,retail:40000}]}],
    clients:[client],orders:[order],queue:[],exports:[],aliases:[],
    shipping:{epoch:7,groups:[{id:"music",name:"일반 보면대",
      current:{version:"v1",at:now,maxBundle:4,maxConfirmed:true,
        fees:{"1":3000,"2":4000,"3":5000,"4":6000},perItem:null,notes:""},
      history:[]}],productRules:{},combinations:[]},
    settings:{accounts:[{id:"account-1",bank:"가상은행",
      number:"123-456",holder:"가상상호"}],
      defaultAccountId:"account-1",operatorName:"가상 담당자"},
    workflow:{
      sources:[{id:"source:o1",orderId:"o1",dealerId:"dealer-1",
        number:1,raw:"가상 발주서",createdAt:now}],
      groups:[{id:gid,sourceId:"source:o1",dealerId:"dealer-1",
        rootGroupId:gid,createdAt:now,notices:[],needsNotice:false}],
      shipments:[{id:"shipment:o1:r1",sourceId:"source:o1",orderId:"o1",
        recipientId:"r1",groupId:gid,step:1,
        completedAt:{"1":now},charges:{FACTORY:4000},
        chargeMode:"MANUAL",freightVersion:"v1",infoSignature:"stable",
        transferred:false}],
      payments:[],queue:[],events:[],deliveries:[],changeRequests:[],
      confirmations:[],
    },
  };
}
const scenarios=[
  ["ordinary valid request stage",()=>{}],
  ["missing recipient name",s=>{s.orders[0].recipients[0].name="";}],
  ["missing address",s=>{s.orders[0].recipients[0].address="";}],
  ["missing recipient contact",s=>{
    s.orders[0].recipients[0].phone="";
  }],
  ["unregistered product",s=>{
    s.orders[0].recipients[0].items[0].productId=null;
    s.orders[0].recipients[0].items[0].variantId=null;
  }],
  ["quantity missing",s=>{
    s.orders[0].recipients[0].items[0].quantity=null;
    s.orders[0].recipients[0].items[0].quantityConfirmed=false;
  }],
  ["custom name and contact templates",s=>{
    s.orders[0].recipients[0].name="";
    s.orders[0].recipients[0].phone="";
    s.settings.automaticMessageTemplates={
      recipientName:"성함 확인 부탁드려요.",
      contactMissing:"{수취인}님 연락처를 알려주세요.",
    };
  }],
  ["customer model proposal with valid URL",s=>{
    const item=s.orders[0].recipients[0].items[0];
    item.modelProposal={original:"보면대",required:true};
    item.url="https://www.bandostand.com/product/709";
  }],
  ["default color notice only",s=>{
    s.orders[0].recipients[0].items[0].appliedDefaultColor={
      groupId:"colors",color:"Black"};
  }],
  ["representative model notice only",s=>{
    s.orders[0].recipients[0].items[0].appliedRepresentativeModel={
      groupId:"models",productId:"p1",productName:"가상 상품"};
  }],
  ["custom request closing",s=>{
    s.orders[0].recipients[0].phone="";
    s.settings.automaticMessageTemplates={
      requestClosing:"회신을 부탁드립니다."};
  }],
  ["invalid product link ignored",s=>{
    const item=s.orders[0].recipients[0].items[0];
    item.modelProposal={original:"모델",required:true};
    item.url="https://other.example/product/709";
  }],
];
const cases=scenarios.map(([name,change])=>{
  const state=base();
  change(state);
  const order=groupOrder(state,gid);
  const payload={settings:state.settings,order,
    issues:workflowIssues(state,gid),step:groupStep(state,gid)};
  const source=automaticMessage(state,gid);
  const baseline={phase:source.phase,
    requestText:source.phase==="request"?source.text:null};
  return {name,payload,baseline};
});
const request=cases.map(c=>({
  operation:"render_automatic_request",payload:c.payload,
}));

test("original TS automatic inquiry phase matches compiled Rust",()=>{
  const r=spawnSync("cargo",["run","--quiet","--manifest-path",manifest,
    "--bin","parity_runner"],{cwd:root,
    input:JSON.stringify(request),encoding:"utf8",
    timeout:180000,maxBuffer:32*1024*1024});
  if(r.error)throw r.error;
  assert.equal(r.status,0,r.stderr);
  const result=JSON.parse(r.stdout);
  assert.equal(result.length,cases.length);
  const mismatches=[];
  cases.forEach((c,i)=>{
    const a=result[i];
    const actual=a.ok?{
      phase:a.value.phase,
      requestText:a.value.phase==="request"?a.value.requestText:null,
    }:a;
    try{assert.deepStrictEqual(actual,c.baseline);}
    catch{mismatches.push({name:c.name,ts:c.baseline,rust:actual});}
  });
  if(mismatches.length)console.error(JSON.stringify(mismatches,null,2));
  assert.equal(mismatches.length,0,`${mismatches.length} request cases differ`);
});
