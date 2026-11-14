/**
 * Exact original saveOrder TypeScript decision oracle vs the actual compiled
 * Rust three-domain dispatcher. No HTTP, fake IPC, or separate mock Rust logic.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tsImport } from "tsx/esm/api";
const root=fileURLToPath(new URL("../../../",import.meta.url));
const cargo=fileURLToPath(new URL("../integration/Cargo.toml",import.meta.url));
const seed=JSON.parse(readFileSync(new URL(
  "../../../src-tauri/resources/state-seed.json",import.meta.url),"utf8"));
const { totals, reviewIssues, canQueue }=await tsImport("../../../src/domain.ts",import.meta.url);
const { blankOrder }=await tsImport("../../../src/seed.ts",import.meta.url);
const { billingSnapshot }=await tsImport("../../../src/replies.ts",import.meta.url);
const at="2026-11-13T01:05:12.000Z";
const baseClient={
  id:"synthetic-dealer",name:"가상 거래처",displayName:"가상 거래처",
  tier:"wholesale",payment:"PREPAID",active:true,
  address:"서울특별시 마포구 월드컵로 20",phone:"0212345678",
  mobile:"",shippingFeeExcluded:false,identifiers:"",overrides:{},
};
const baseOrder=blankOrder(baseClient.id);
baseOrder.id="synthetic-order";
baseOrder.confirmedAt="2026-11-12T02:00:00.000Z";
baseOrder.receptionVersion=1;
baseOrder.raw="BD 709 2개";
baseOrder.analysisRaw=baseOrder.raw;
baseOrder.shippingFee=3000;
baseOrder.applyVat=true;
baseOrder.freightCode="010";
baseOrder.recipients=[{
  id:"synthetic-recipient",name:"김가상",
  address:"서울특별시 마포구 월드컵로 20",addressStatus:"COMPLETE",
  phone:"01012345678",mobile:"",note:"",
  items:[{
    id:"synthetic-item",productId:"synthetic-product",variantId:"synthetic-variant",
    raw:"BD 709 2개",name:"BD 709",color:"Black",
    quantity:2,quantityConfirmed:true,unitPrice:12000,
    origin:"FACTORY",defaulted:false,issues:[],url:"",
    match:{kind:"NAME",term:"BD 709",productIds:["synthetic-product"]},
  }],
}];
function oracle(payload){
  const {state,order: draft,client:c,mode,now}=payload;
  if(draft.receptionVersion===1 && !draft.confirmedAt &&
      !state.orders.some(o=>o.id===draft.id))
    throw Error("최종 검수 후 주문 확인 완료로 정식 접수하세요.");
  if(!c)throw Error("거래처를 선택하세요.");
  if(draft.status==="EXPORTED")throw Error("공장 전달 완료 주문은 변경할 수 없습니다.");
  const o=structuredClone(draft),next=structuredClone(state);
  // The original TS billingSnapshot is the oracle for the Rust save-time
  // transition. The UI records the first-edit time, not a TS monetary value.
  if(o.pendingBillingSnapshot){
    const original=state.orders.find(x=>x.id===o.id);
    if(!original)throw Error("과거 청구 이력을 작성할 기존 주문이 없습니다.");
    const linked=state.workflow?.shipments.some(x=>
      x.orderId===original.id && !x.legacyArchived);
    if(original.pricesLocked&&!linked){
      const historical=billingSnapshot(original,state,o.pendingBillingSnapshot.reason);
      historical.at=o.pendingBillingSnapshot.at;
      o.billingHistory=[...(o.billingHistory??[]),historical];
    }
  }
  delete o.pendingBillingSnapshot;
  o.clientSnapshot=structuredClone(c);
  o.updatedAt=now;
  o.vatAmount=totals(o,c).vat;
  const complete=!reviewIssues(o).length && totals(o,c).total!==null;
  if(mode==="notify"){
    if(!complete)throw Error("상품 / 배송 정보 / 금액을 먼저 확인하세요.");
    o.notified=true;
    o.status="NOTIFIED";
  }else if(mode==="pay"){
    if(!o.notified||!complete)throw Error("주문 검토와 안내 완료를 먼저 처리하세요.");
    if(c.payment==="PREPAID")o.paid=true;
    else o.postpaidApproved=true;
    o.status="APPROVED";
  }else if(mode==="wait"){
    if(!o.notified||c.payment!=="PREPAID")
      throw Error("선입금 주문의 안내 완료 후 입금 대기를 처리하세요.");
    o.status="WAITING";
  }else if(mode==="queue"){
    const missing=canQueue(o,c,state.settings);
    if(missing.length)throw Error(missing.join("\n"));
    o.status="QUEUED";
    next.queue=[...new Set([...next.queue,o.id])];
  }else if(!o.notified&&!o.paid&&!o.postpaidApproved)
    o.status=complete?"STATEMENT":"REVIEW";
  if(mode!=="queue"&&o.status!=="QUEUED")
    next.queue=next.queue.filter(id=>id!==o.id);
  o.pricesLocked=complete;
  const i=next.orders.findIndex(x=>x.id===o.id);
  if(i<0)next.orders.unshift(o);else next.orders[i]=o;
  return {state:next,order:o,complete,totals:totals(o,c)};
}
const scenarios=[];
const add=(name,modify=()=>{},mode="save")=>{
  const client=structuredClone(baseClient),order=structuredClone(baseOrder);
  const state=structuredClone(seed);state.clients=[client];state.orders=[];state.queue=[];
  const input={state,order,client,mode,now:at};
  modify(input);
  scenarios.push({name,input});
};
add("new valid confirmed order");
add("notify accepted",undefined,"notify");
add("pay without notice rejected",undefined,"pay");
add("wait without notice rejected",undefined,"wait");
add("queue without payment rejected",undefined,"queue");
add("notify invalid recipient rejected",x=>{x.order.recipients[0].name="";},"notify");
add("save incomplete address",x=>{x.order.recipients[0].address="";});
add("save VAT excluded",x=>{x.order.applyVat=false;});
add("save freight COD",x=>{x.order.freightCode="020";});
add("save client shipping excluded",x=>{x.client.shippingFeeExcluded=true;});
add("save missing price",x=>{x.order.recipients[0].items[0].unitPrice=null;});
add("save quantity unconfirmed",x=>{x.order.recipients[0].items[0].quantityConfirmed=false;});
add("save existing order and preserve order ordering",x=>{
  x.state.orders=[{...structuredClone(x.order),id:"other-order"},structuredClone(x.order)];
});
add("notified payment approved",x=>{x.order.notified=true;},"pay");
add("notified prepaid waiting",x=>{x.order.notified=true;},"wait");
add("postpaid paid approval",x=>{
  x.client.payment="POSTPAID";x.order.notified=true;
},"pay");
add("fully approved queued",x=>{
  x.order.notified=true;x.order.paid=true;
},"queue");
add("already queued membership not duplicated",x=>{
  x.order.notified=true;x.order.paid=true;x.state.queue=[x.order.id];
},"queue");
add("previously queued order save preserves status",x=>{
  x.order.status="QUEUED";x.order.notified=true;x.order.paid=true;
  x.state.queue=[x.order.id];
},"save");
add("exported order cannot change",x=>{x.order.status="EXPORTED";},"pay");
add("unconfirmed first reception cannot be stored",x=>{
  delete x.order.confirmedAt;
});
add("invalid contact blocked",x=>{x.order.recipients[0].mobile="010123";},"notify");
add("locked past invoice is frozen before first draft edit",x=>{
  const old=structuredClone(x.order);
  old.pricesLocked=true;old.status="APPROVED";
  old.notified=true;old.paid=true;
  old.clientSnapshot=structuredClone(x.client);
  x.state.orders=[old];
  x.order.pricesLocked=false;
  x.order.status="REVIEW";
  x.order.recipients[0].items[0].quantity=3;
  x.order.pendingBillingSnapshot={at:"2026-11-13T00:59:00.000Z",
    reason:"수취인 / 배송 정보 수정"};
});
add("frozen history append preserves pre-existing snapshots",x=>{
  const old=structuredClone(x.order);
  old.pricesLocked=true;
  old.billingHistory=[{at:"2026-11-12T02:00:00.000Z",
    reason:"가상 이력",recipients:[],shippingFee:3000,vatAmount:0,
    applyVat:false,total:3000,status:"REVIEW",paid:false,notified:false,
    postpaidApproved:false,client:structuredClone(x.client)}];
  x.state.orders=[old];
  x.order.pricesLocked=false;
  x.order.billingHistory=structuredClone(old.billingHistory);
  x.order.pendingBillingSnapshot={at:"2026-11-13T00:59:00.000Z",reason:"주문 정보 수정"};
});
add("no duplicate snapshot when previous order was not price-locked",x=>{
  x.state.orders=[structuredClone(x.order)];
  x.order.pendingBillingSnapshot={at:"2026-11-13T00:59:00.000Z",reason:"주문 정보 수정"};
});
add("linked shipment disallows new standalone billing snapshot",x=>{
  const old=structuredClone(x.order);old.pricesLocked=true;
  x.state.orders=[old];
  x.state.workflow.shipments.push({
    id:"synthetic-linked-shipment",orderId:x.order.id,recipientId:"synthetic-recipient",
    sourceId:"test",groupId:"g",step:1,transferred:false
  });
  x.order.pricesLocked=false;
  x.order.pendingBillingSnapshot={at:"2026-11-13T00:59:00.000Z",reason:"주문 정보 수정"};
});
add("missing original order refuses to invent historical invoice",x=>{
  x.order.pendingBillingSnapshot={at:"2026-11-13T00:59:00.000Z",reason:"주문 정보 수정"};
});

const requests=scenarios.map(({input})=>({
  domain:"rules",operation:"save_order",payload:input,
}));
const run=spawnSync("cargo",["run","--quiet","--manifest-path",cargo,
  "--bin","reception_runner"],{
  cwd:root,input:JSON.stringify(requests),encoding:"utf8",
  timeout:900_000,maxBuffer:60*1024*1024
});
if(run.error)throw run.error;
assert.equal(run.status,0,run.stderr);
const answers=JSON.parse(run.stdout);
for(let n=0;n<scenarios.length;n++){
  const {name,input}=scenarios[n],native=answers[n];
  test("TypeScript saveOrder vs native Rust: "+name,()=>{
    let expected,expectedError;
    try{expected=oracle(input)}catch(e){expectedError=e.message}
    if(expectedError){
      assert.equal(native.ok,false);
      assert.equal(native.error,expectedError,"error parity must preserve UI wording");
      return;
    }
    assert.equal(native.ok,true,JSON.stringify(native.error));
    assert.deepEqual(native.value.order,expected.order);
    assert.deepEqual(native.value.state,expected.state);
    assert.equal(native.value.complete,expected.complete);
    assert.deepEqual(native.value.totals,expected.totals);
    assert.deepEqual(input.order,scenarios[n].input.order,
      "native must not mutate the original draft");
  });
}
