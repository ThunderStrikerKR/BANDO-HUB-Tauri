/** The React staff checklist reads preview_order.issues.
 * Compare that actual production projection with the original TS orderIssues
 * on identical draft inputs; never substitute an authored expected stub.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {tsImport} from "tsx/esm/api";
const {orderIssues}=await tsImport("../../../src/validation.ts",import.meta.url);
const root=fileURLToPath(new URL("../../../",import.meta.url));
const manifest=fileURLToPath(new URL("./Cargo.toml",import.meta.url));
const copy=x=>structuredClone(x);
function baseline() {
  const client={id:"c1",name:"가상 거래처",tier:"wholesale",
    payment:"PREPAID",shippingFeeExcluded:false,overrides:{},
    address:"서울",phone:"02-1234-5678"};
  const item={id:"i1",productId:"p1",variantId:"v1",name:"BD 709",
    raw:"BD 709 2개",quantity:2,quantityConfirmed:true,
    unitPrice:10000,origin:"FACTORY",color:"Black",issues:[],
    sources:[]};
  const recipient={id:"r1",name:"가상 수취인",address:"서울특별시 중구 세종대로 1",
    addressStatus:"COMPLETE",phone:"02-1234-5678",mobile:"",
    items:[item],sources:[],note:""};
  const order={id:"o1",clientId:"c1",raw:"BD 709 2개",analysisRaw:"BD 709 2개",
    createdAt:"2026-11-14T00:00:00Z",updatedAt:"2026-11-14T00:00:00Z",
    orderType:"AGENCY",receptionVersion:1,recipients:[recipient],
    freightCode:"010",shippingFee:3000,status:"REVIEW"};
  return {
    orders:[order],clients:[client],products:[],aliases:[],
    settings:{operatorName:"직원",accounts:[]},
    workflow:{sources:[],groups:[],shipments:[],payments:[],queue:[],events:[]},
    shipping:{epoch:0,groups:[],productRules:{},combinations:[]},
  };
}
const scenarios=[];
function add(name,change=()=>{}) {
  const state=baseline(),draft=copy(state.orders[0]);
  change(draft,state);
  scenarios.push({name,payload:{state,draft,orderId:draft.id},
    expected:JSON.parse(JSON.stringify(orderIssues(draft)))});
}
add("valid staff review");
add("recipient name missing",o=>{o.recipients[0].name="";});
add("address incomplete",o=>{
  o.recipients[0].address="서울";o.recipients[0].addressStatus="INCOMPLETE";
});
add("contact missing",o=>{o.recipients[0].phone="";});
add("unregistered product",o=>{
  o.recipients[0].items[0].productId=null;o.recipients[0].items[0].variantId=null;
});
add("quantity awaiting employee confirmation",o=>{
  o.recipients[0].items[0].quantityConfirmed=false;
});
add("unknown item price",o=>{o.recipients[0].items[0].unitPrice=null;});
add("confirmed alias and model proposal",o=>{
  const item=o.recipients[0].items[0];
  item.match={kind:"COMMON_ALIAS",term:"악보대",productIds:["p1"]};
  item.modelProposal={original:"보면대",required:true};
});
add("multiple candidate recipient names",o=>{
  o.recipients[0].candidates=[
    {field:"name",value:"박가상",label:"박가상"},
    {field:"name",value:"이가상",label:"이가상"},
  ];
});
add("draft changed after persisted baseline",o=>{
  o.recipients[0].name="수정 중인 수취인";
  o.recipients[0].items[0].issues.push("색상 확인 필요");
});
add("pending customer issue decision",o=>{
  const item=o.recipients[0].items[0];
  item.modelProposal={original:"보면대",required:true};
  o.issueResolutions={};
});
add("no recipients in received raw",o=>{o.recipients=[];});

test("real Rust order-preview staff issue projection equals original TS for every draft",()=>{
  const requests=scenarios.map(({payload})=>({
    operation:"preview_order",payload,
  }));
  const run=spawnSync("cargo",["run","--quiet","--manifest-path",manifest,
    "--bin","json_rules"],{
    cwd:root,encoding:"utf8",input:requests.map(JSON.stringify).join("\n")+"\n",
    timeout:180000,maxBuffer:20*1024*1024,
  });
  if(run.error)throw run.error;
  assert.equal(run.status,0,run.stderr);
  const rows=run.stdout.trim().split(/\r?\n/).map(JSON.parse);
  assert.equal(rows.length,scenarios.length);
  const bad=[];
  for(let i=0;i<rows.length;i++){
    const actual=rows[i];
    if(!actual.ok){bad.push({scenario:scenarios[i].name,rust:actual});continue;}
    try{assert.deepStrictEqual(actual.value.issues,scenarios[i].expected);}
    catch{bad.push({scenario:scenarios[i].name,ts:scenarios[i].expected,rust:actual.value.issues});}
  }
  if(bad.length)console.error(JSON.stringify(bad,null,2));
  assert.equal(bad.length,0,"native staff checklist and source TS differ");
});
