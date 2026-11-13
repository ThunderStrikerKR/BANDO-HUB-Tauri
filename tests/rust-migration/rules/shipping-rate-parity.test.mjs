/** Actual compiled Rust tariff history decision vs original ShippingManager. */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tsImport } from "tsx/esm/api";
const { combinationVersions }=await tsImport("../../../src/shipping.ts",import.meta.url);
const root=fileURLToPath(new URL("../../../",import.meta.url));
const cargo=fileURLToPath(new URL("../integration/Cargo.toml",import.meta.url));
const old={
  version:"old-version",at:"2026-11-01T00:00:00.000Z",
  fees:{"1":3000,"2":4000,"3":null},
  maxBundle:2,maxConfirmed:true,perItem:null,notes:"historical",
};
const shipping={
  epoch:2,combinations:[],groups:[
    {id:"g1",name:"보면대 그룹",current:old,history:[]},
    {id:"g2",name:"별도 그룹",current:{...old,version:"other-version"},history:[]},
  ],
};
const rule={
  ...old,notes:"직원 확인",maxBundle:3,
  fees:{"1":3000,"2":4500,"3":6000},
  validFrom:"old-date",validUntil:"new-date",basis:"historical",packable:true,
};
const now="2026-11-13T10:00:00.000Z";
function oracle(payload) {
  const next=structuredClone(payload.shipping);
  const group=next.groups.find(g=>g.id===payload.groupId);
  group.history.push(group.current);
  if(Object.entries(payload.rule.fees).some(([count,amount])=>
    typeof amount==="number" && payload.rule.maxBundle!==null &&
    Number(count)>payload.rule.maxBundle))
    throw Error("최대 묶음 수량을 초과하는 운임 구간을 확인하세요.");
  group.current={
    ...payload.rule,maxConfirmed:payload.rule.maxBundle!==null,
    version:payload.versionId,at:payload.now,
  };
  delete group.current.validFrom;
  delete group.current.validUntil;
  delete group.current.basis;
  delete group.current.packable;
  return {shipping:next};
}
const cases=[
  ["valid edited rate, full history",rule],
  ["unbounded group, numeric fees",{...rule,maxBundle:null}],
  ["reject fee above maximum",{...rule,maxBundle:1,fees:{"1":3000,"2":4000}}],
  ["keep unknown fee as null",{...rule,fees:{"1":null,"2":4500,"3":null}}],
  ["only update one group's price",{...rule,fees:{"1":3500,"2":4000,"3":null}}],
];
const requests=cases.map(([,modified])=>({
  domain:"rules",operation:"apply_shipping_action",
  payload:{
    action:"save_group_rule",shipping,groupId:"g1",
    rule:modified,versionId:"new-version",now,
  }
}));
const run=spawnSync("cargo",["run","--quiet","--manifest-path",cargo,
  "--bin","reception_runner"],{
  cwd:root,input:JSON.stringify(requests),encoding:"utf8",
  timeout:900000,maxBuffer:64*1024*1024,
});
if(run.error)throw run.error;
assert.equal(run.status,0,run.stderr);
const actual=JSON.parse(run.stdout);
assert.equal(actual.length,cases.length);
for(let i=0;i<cases.length;i++){
  const [name]=cases[i],payload=requests[i].payload;
  test("Rust group tariff: "+name,()=>{
    let expected,expectedError;
    try{expected=oracle(payload)}catch(e){expectedError=e.message}
    const result=actual[i];
    if(expectedError){
      assert.equal(result.ok,false);
      assert.equal(result.error,expectedError);
    }else{
      assert.equal(result.ok,true,JSON.stringify(result.error));
      assert.deepEqual(result.value,expected);
    }
    assert.equal(shipping.groups[0].history.length,0);
    assert.equal(shipping.groups[0].current.version,"old-version");
    assert.equal(shipping.groups[1].current.version,"other-version");
  });
}

const productPrevious={
  version:"product-old",at:"2026-11-01T00:00:00.000Z",
  fees:{"1":3000,"2":null},maxBundle:2,maxConfirmed:true,
  perItem:null,notes:"prior product price",
};
const individualCases=[
  ["new product rule creates the product map",{
    ...shipping,productRules:undefined,productHistory:undefined
  },rule],
  ["existing product rule appends immutable history",{
    ...shipping,productRules:{"product-1":productPrevious},productHistory:{}
  },rule],
  ["existing history is not overwritten",{
    ...shipping,productRules:{"product-1":productPrevious},
    productHistory:{"product-1":[{...productPrevious,version:"older"}]}
  },rule],
  ["invalid count beyond maximum is blocked",{
    ...shipping,productRules:{"product-1":productPrevious},
    productHistory:{}
  },{...rule,maxBundle:1,fees:{"1":3000,"2":4000}}],
  ["unset maximum preserves unknown rates",{
    ...shipping,productRules:{"product-1":productPrevious},productHistory:{}
  },{...rule,maxBundle:null,fees:{"1":null,"2":null}}],
];
function productOracle(payload) {
  const next=structuredClone(payload.shipping);
  const {productId,rule:editing}=payload;
  if(Object.entries(editing.fees).some(([count,amount])=>
    typeof amount==="number"&&editing.maxBundle!==null&&
    Number(count)>editing.maxBundle))
    throw Error("최대 묶음 수량을 초과하는 운임 구간을 삭제하거나 수량을 다시 설정하세요.");
  next.productRules??={};
  next.productHistory??={};
  const previous=next.productRules[productId];
  if(previous)next.productHistory[productId]=[...(next.productHistory[productId]??[]),previous];
  const value={
    ...editing,maxConfirmed:editing.maxBundle!==null,
    version:payload.versionId,at:payload.now,
  };
  delete value.validFrom;delete value.validUntil;
  delete value.basis;delete value.packable;
  next.productRules[productId]=value;
  return {shipping:next};
}
const productRequests=individualCases.map(([,state,editing])=>({
  domain:"rules",operation:"apply_shipping_action",
  payload:{
    action:"save_product_rule",shipping:state,productId:"product-1",
    rule:editing,versionId:"product-v2",now
  }
}));
const productRun=spawnSync("cargo",["run","--quiet","--manifest-path",cargo,
  "--bin","reception_runner"],{
  cwd:root,input:JSON.stringify(productRequests),encoding:"utf8",
  timeout:900000,maxBuffer:64*1024*1024
});
if(productRun.error)throw productRun.error;
assert.equal(productRun.status,0,productRun.stderr);
const productActual=JSON.parse(productRun.stdout);
assert.equal(productActual.length,individualCases.length);
for(let i=0;i<individualCases.length;i++){
  const [name]=individualCases[i],payload=productRequests[i].payload;
  test("Rust individual tariff: "+name,()=>{
    let expected,error;
    try{expected=productOracle(payload)}catch(e){error=e.message}
    const actual=productActual[i];
    if(error){
      assert.equal(actual.ok,false);
      assert.equal(actual.error,error);
    }else{
      assert.equal(actual.ok,true,JSON.stringify(actual.error));
      assert.deepEqual(actual.value,expected);
    }
    assert.equal(payload.shipping.groups[0].current.version,"old-version");
    assert.equal(payload.shipping.groups[1].current.version,"other-version");
  });
}

const currentRule={
  version:"p-older",at:"2026-11-01T00:00:00.000Z",
  fees:{"1":3500},maxBundle:1,maxConfirmed:true,
  perItem:null,notes:"직원 기록",
};
const assignmentState={
  shipping:{...structuredClone(shipping),
    productRules:{"p1":currentRule},productHistory:{}},
  products:[
    {id:"p1",name:"상품 1",shippingGroupId:"g1"},
    {id:"p2",name:"상품 2",shippingGroupId:"g1"},
    {id:"p3",name:"유지 상품",shippingGroupId:"g2"},
  ],
};
const assignmentCases=[
  ["assign existing product to another group",{"p1":"g2"}],
  ["unassign saves prior individual rate in history",{"p1":""}],
  ["unassign product without old individual rule",{"p2":""}],
  ["batch assignment and unassignment are atomic",{"p1":"","p2":"g2"}],
];
function assignmentOracle(payload){
  const next=structuredClone(payload.state);
  const changed=Object.entries(payload.assignments);
  for(const [pid,value] of changed)if(!value){
    next.shipping.productRules??={};
    next.shipping.productHistory??={};
    const old=next.shipping.productRules[pid];
    if(old)next.shipping.productHistory[pid]=[
      ...(next.shipping.productHistory[pid]??[]),old
    ];
    next.shipping.productRules[pid]={
      version:payload.versionIds[pid],at:payload.now,
      fees:{"1":null,"2":null,"3":null,"4":null,"5":null,"6":null},
      maxBundle:null,maxConfirmed:false,perItem:null,
      notes:"상품의 최대 묶음 수량과 운임을 확인해 입력하세요.",
    };
  }
  next.products=next.products.map(p=>{
    if(payload.assignments[p.id]===undefined)return p;
    const copy={...p,shippingGroupId:payload.assignments[p.id]||undefined};
    if(copy.shippingGroupId===undefined)delete copy.shippingGroupId;
    return copy;
  });
  return {state:next};
}
const assignmentRequests=assignmentCases.map(([,assignments])=>({
  domain:"rules",operation:"apply_shipping_action",
  payload:{
    action:"assign_products",state:assignmentState,assignments,
    versionIds:{"p1":"id-p1","p2":"id-p2"},now,
  },
}));
const batch=spawnSync("cargo",["run","--quiet","--manifest-path",cargo,
  "--bin","reception_runner"],{
  cwd:root,input:JSON.stringify(assignmentRequests),encoding:"utf8",
  timeout:900000,maxBuffer:64*1024*1024
});
if(batch.error)throw batch.error;
assert.equal(batch.status,0,batch.stderr);
const batchOutputs=JSON.parse(batch.stdout);
assert.equal(batchOutputs.length,assignmentCases.length);
for(let i=0;i<assignmentCases.length;i++){
  const [name]=assignmentCases[i];
  test("Rust group assignment: "+name,()=>{
    const expected=assignmentOracle(assignmentRequests[i].payload);
    assert.equal(batchOutputs[i].ok,true,JSON.stringify(batchOutputs[i].error));
    assert.deepEqual(batchOutputs[i].value,expected);
    assert.equal(assignmentState.products[0].shippingGroupId,"g1");
    assert.equal(assignmentState.shipping.productHistory["p1"],undefined);
  });
}

const copyState={
  ...structuredClone(shipping),
  productRules:{"p1":productPrevious},
  productHistory:{"p1":[{...productPrevious,version:"p1-older"}]},
};
const copyCases=[
  ["copy a confirmed group rate into a new product",["p2"]],
  ["copy a group rate and archive old product-specific price",["p1"]],
  ["copy same group rate into multiple products",["p1","p2"]],
  ["empty selection does not change tariff data",[]],
];
function copyOracle(payload){
  const next=structuredClone(payload.shipping);
  const group=next.groups.find(g=>g.id===payload.groupId);
  next.productRules??={};
  next.productHistory??={};
  for(const pid of payload.productIds){
    const previous=next.productRules[pid];
    if(previous)next.productHistory[pid]=[
      ...(next.productHistory[pid]??[]),previous
    ];
    next.productRules[pid]={
      ...structuredClone(group.current),version:payload.versionIds[pid],at:payload.now,
    };
  }
  return {shipping:next};
}
const copyRequests=copyCases.map(([,ids])=>({
  domain:"rules",operation:"apply_shipping_action",
  payload:{
    action:"copy_group_rule",shipping:copyState,groupId:"g1",
    productIds:ids,versionIds:{"p1":"new-p1","p2":"new-p2"},now,
  },
}));
const copyRun=spawnSync("cargo",["run","--quiet","--manifest-path",cargo,
  "--bin","reception_runner"],{
  cwd:root,input:JSON.stringify(copyRequests),encoding:"utf8",
  timeout:900000,maxBuffer:64*1024*1024
});
if(copyRun.error)throw copyRun.error;
assert.equal(copyRun.status,0,copyRun.stderr);
const copyActual=JSON.parse(copyRun.stdout);
assert.equal(copyActual.length,copyCases.length);
for(let i=0;i<copyCases.length;i++){
  const [name]=copyCases[i];
  test("Rust group-to-product copy: "+name,()=>{
    assert.equal(copyActual[i].ok,true,JSON.stringify(copyActual[i].error));
    assert.deepEqual(copyActual[i].value,copyOracle(copyRequests[i].payload));
    assert.equal(copyState.productHistory.p1.length,1);
    assert.equal(copyState.groups[0].current.version,"old-version");
  });
}

const baseCombo={
  id:"old-combination",key:"FACTORY|p1@1",epoch:2,
  versions:{"assignment:p1":"g1","group:g1":"old-version"},
  charge:3000,actual:2500,at:"2026-11-01T00:00:00.000Z",
  active:true,description:"확인된 합포장",
  shipmentId:"shipment-1",verifiedAt:"2026-11-02T00:00:00.000Z",
  sampleCount:3,observedCharge:2500,
};
const exceptionState={
  products:[{id:"p1",shippingGroupId:"g1"},{id:"p2",shippingGroupId:"g2"}],
  shipping:{...structuredClone(shipping),combinations:[baseCombo]},
};
const exceptionCases=[
  ["new exception amount retains historical actual and prior inactive",4500],
  ["zero verified exception is an allowed manual charge",0],
  ["revised charge keeps current group and assignment versions",3200],
];
function exceptionOracle(payload){
  const state=payload.state;
  const next=structuredClone(payload.shipping);
  const old=next.combinations.find(x=>x.id===payload.combinationId);
  old.active=false;
  next.combinations.push({
    ...old,verifiedAt:undefined,shipmentId:undefined,
    sampleCount:0,observedCharge:undefined,
    id:payload.newId,charge:payload.charge,epoch:next.epoch,
    versions:combinationVersions(old.key,state),
    at:payload.now,active:true,
  });
  return JSON.parse(JSON.stringify({shipping:next}));
}
const exceptionRequests=exceptionCases.map(([,price])=>({
  domain:"rules",operation:"apply_shipping_action",
  payload:{
    action:"revise_combination",state:exceptionState,
    shipping:exceptionState.shipping,
    combinationId:"old-combination",newId:"revised-combination",
    charge:price,now,
  }
}));
const exceptionRun=spawnSync("cargo",["run","--quiet","--manifest-path",cargo,
  "--bin","reception_runner"],{
  cwd:root,input:JSON.stringify(exceptionRequests),encoding:"utf8",
  timeout:900000,maxBuffer:64*1024*1024
});
if(exceptionRun.error)throw exceptionRun.error;
assert.equal(exceptionRun.status,0,exceptionRun.stderr);
const exceptionActual=JSON.parse(exceptionRun.stdout);
assert.equal(exceptionActual.length,exceptionCases.length);
for(let i=0;i<exceptionCases.length;i++){
  const [name]=exceptionCases[i];
  test("Rust exception freight: "+name,()=>{
    assert.equal(exceptionActual[i].ok,true,JSON.stringify(exceptionActual[i].error));
    assert.deepEqual(exceptionActual[i].value,exceptionOracle(exceptionRequests[i].payload));
    assert.equal(exceptionState.shipping.combinations[0].active,true);
    assert.equal(exceptionState.shipping.combinations.length,1);
  });
}

const groupCrudRequests=[
  {domain:"rules",operation:"apply_shipping_action",payload:{
    action:"create_group",shipping,groupId:"new-g3",name:"새 배송 그룹",
    versionId:"new-g3-v1",now,
  }},
  {domain:"rules",operation:"apply_shipping_action",payload:{
    action:"create_group",shipping,groupId:"new-g3",name:"보면대 그룹",
    versionId:"new-g3-v1",now,
  }},
  {domain:"rules",operation:"apply_shipping_action",payload:{
    action:"rename_group",shipping,groupId:"g1",name:"그룹명 수정",
  }},
];
const crudRun=spawnSync("cargo",["run","--quiet","--manifest-path",cargo,
  "--bin","reception_runner"],{
  cwd:root,input:JSON.stringify(groupCrudRequests),encoding:"utf8",
  timeout:900000,maxBuffer:64*1024*1024
});
if(crudRun.error)throw crudRun.error;
assert.equal(crudRun.status,0,crudRun.stderr);
const crudResults=JSON.parse(crudRun.stdout);
test("Rust group creation preserves existing tariff versions",()=>{
  assert.equal(crudResults[0].ok,true,JSON.stringify(crudResults[0].error));
  assert.deepEqual(crudResults[0].value.shipping.groups.slice(0,2),shipping.groups);
  assert.deepEqual(crudResults[0].value.shipping.groups[2],{
    id:"new-g3",name:"새 배송 그룹",
    current:{
      version:"new-g3-v1",at:now,fees:{},maxBundle:null,
      maxConfirmed:false,perItem:null,notes:"운임 확인 필요",
    },history:[],
  });
});
test("Rust group creation rejects a duplicate name",()=>{
  assert.equal(crudResults[1].ok,false);
  assert.equal(crudResults[1].error,"같은 배송 그룹이 있습니다.");
});
test("Rust rename retains current rate and historical records",()=>{
  assert.equal(crudResults[2].ok,true,JSON.stringify(crudResults[2].error));
  assert.deepEqual(crudResults[2].value.shipping.groups[0],{
    ...shipping.groups[0],name:"그룹명 수정",
  });
  assert.deepEqual(crudResults[2].value.shipping.groups[1],shipping.groups[1]);
});
