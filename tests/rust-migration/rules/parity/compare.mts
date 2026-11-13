/**
 * Execute the real TypeScript baseline and the actual Rust rules module on
 * identical JSON fixtures. This is intentionally not a Rust-only unit test.
 *
 * From repository root, with npm dependencies and Cargo available:
 *   npx tsx tests/rust-migration/rules/parity/compare.mts
 *
 * Any mismatch fails the process. Fixtures contain synthetic data only.
 */
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePrice, totals } from "../../../../src/domain.ts";
import {
  recommendShipping,
  editableShippingRule,
  combinationVersions,
  combinationCurrent,
  upgradeShipping,
} from "../../../../src/shipping.ts";
import { shipmentTotals, validateWorkflow, reconcileWorkflow, deleteOrder, workflowIssues, stageIssues } from "../../../../src/workflow.ts";
import { orderIssues, approveMissingQuantity, pendingIssue } from "../../../../src/validation.ts";

const root=resolve(dirname(fileURLToPath(import.meta.url)),"../../../..");
const now="2026-11-13T09:00:00+09:00";
const client={
  id:"dealer-1",tier:"wholesale",payment:"POSTPAID",
  name:"가상 거래처",displayName:"가상 거래처",address:"서울시 가상로 1",
  phone:"02-1234-5678",mobile:"",overrides:{},
  shippingFeeExcluded:false,preferredAccountId:"account-1"
};
const product={
  id:"p1",name:"가상 상품",origin:"FACTORY",active:true,
  shippingGroupId:"music",variants:[{
    id:"v1",color:"Black",wholesale:30000,semi:35000,retail:40000,
    legacyIds:["old-v1"]
  }]
};
const item={
  id:"item1",productId:"p1",variantId:"v1",name:"가상 상품",
  quantity:2,unitPrice:30000,origin:"FACTORY",color:"Black",
  issues:[],url:"",raw:"가상 상품"
};
const recipient={
  id:"r1",name:"가상 수취인",address:"서울시 가상로 1",
  phone:"010-1234-5678",mobile:"",items:[item],note:"",vatDefault:true
};
const order={
  id:"o1",clientId:"dealer-1",recipients:[recipient],raw:"가상 발주서",
  freightCode:"010",shippingFee:3000,applyVat:true,vatAmount:null,
  orderType:"AGENCY",status:"REVIEW",createdAt:now,updatedAt:now
};
const shipping={
  epoch:7,groups:[{id:"music",name:"일반 보면대",
    current:{version:"v1",at:now,maxBundle:4,maxConfirmed:true,
      fees:{"1":3000,"2":4000,"3":5000,"4":6000},perItem:null,
      notes:"가상 테스트 운임표"},
    history:[]}],productRules:{},combinations:[]
};
const settings={
  accounts:[{id:"account-1",bank:"가상은행",number:"123-456",holder:"가상상호"}],
  defaultAccountId:"account-1",operatorName:"가상 담당자",
  senderName:"반도스탠드",senderAddress:"서울시 가상로 1",
  senderPhone:"02-1234-5678",senderMobile:""
};
const workflow={
  sources:[{id:"source:o1",orderId:"o1",dealerId:"dealer-1",number:1,raw:order.raw,createdAt:now}],
  groups:[{id:"group:o1",sourceId:"source:o1",dealerId:"dealer-1",
    rootGroupId:"group:o1",createdAt:now,notices:[],needsNotice:false}],
  shipments:[{id:"shipment:o1:r1",sourceId:"source:o1",orderId:"o1",
    recipientId:"r1",groupId:"group:o1",step:2,
    completedAt:{"1":now,"2":now},charges:{FACTORY:4000},
    chargeMode:"MANUAL",freightVersion:"v1",infoSignature:"stable",
    transferred:false}],
  payments:[],queue:[],events:[],deliveries:[],changeRequests:[],confirmations:[]
};
const baseState={
  products:[product],clients:[client],orders:[order],
  shipping,settings,workflow,queue:[],exports:[]
};
const copy=<T>(obj:T):T=>structuredClone(obj);
const cases: Array<{
  name:string; operation:string; payload:Record<string,unknown>;
  baseline:()=>unknown;
}>=[];
function add(name:string,operation:string,payload:Record<string,unknown>,baseline:()=>unknown) {
  cases.push({name,operation,payload,baseline});
}
function priceCase(name:string,change:(o:typeof order,c:typeof client)=>void) {
  const o=copy(order),c=copy(client);change(o,c);
  add(name,"calculate_price",{order:o,client:c},()=>totals(o as any,c as any));
}
priceCase("VAT and prepaid shipping",()=>{});
priceCase("collect shipping 020",(o)=>{o.freightCode="020";});
priceCase("shipping fee excluded",(_o,c)=>{c.shippingFeeExcluded=true;});
priceCase("VAT off",(o)=>{o.applyVat=false;});
for(const tier of ["retail","semi","wholesale","special"] as const) {
  const c:any=copy(client);c.tier=tier;
  if(tier==="special")c.overrides={"old-v1":27000};
  add("tier "+tier,"resolve_unit_price",{product,variantId:"v1",client:c},
    ()=>({unitPrice:resolvePrice(product as any,"v1",c)}));
}
const shippingState=copy(baseState);
add("factory tariff","calculate_shipping",{order,state:shippingState},
  ()=>recommendShipping(order as any,shippingState as any));
const withCombination=copy(baseState);
withCombination.shipping.combinations.push({
  id:"combo-1",key:"FACTORY|p1@v1:2",epoch:7,active:true,
  charge:4500,actual:4500,at:now,
  description:"가상 운임 조합",
  versions:{"assignment:p1":"music","group:music":"v1"}
} as any);
add("current verified combination","calculate_shipping",{order,state:withCombination},
  ()=>recommendShipping(order as any,withCombination as any));
const oldCombination=copy(withCombination);
oldCombination.shipping.epoch=8;
add("expired combination epoch","calculate_shipping",{order,state:oldCombination},
  ()=>recommendShipping(order as any,oldCombination as any));
add("shipment totals","calculate_shipment_totals",{
  state:baseState,shipmentId:"shipment:o1:r1"},
  ()=>shipmentTotals(baseState as any,baseState.workflow.shipments[0] as any));
add("valid workflow","validate_workflow",{state:baseState},
  ()=>{validateWorkflow(baseState as any);return {valid:true};});
const rule=copy(shipping.groups[0].current);
rule.perItem=5000;
add("edit legacy per-item tariff","apply_shipping_action",{
  action:"editable_rule",rule},
  ()=>({rule:editableShippingRule(rule as any)}));
add("combination version token","apply_shipping_action",{
  action:"combination_versions",key:"FACTORY|p1@v1:2",state:baseState},
  ()=>({versions:combinationVersions("FACTORY|p1@v1:2",baseState as any)}));
add("current combination check","apply_shipping_action",{
  action:"combination_current",state:withCombination,
  combination:withCombination.shipping.combinations[0]},
  ()=>({current:combinationCurrent(withCombination.shipping.combinations[0] as any,
    withCombination as any)}));
const beforeReconcile=copy(baseState);
delete (beforeReconcile as any).workflow;
add("full reconcile output (must match decision synchronization)","reconcile_workflow",{
  state:beforeReconcile,now,eventIds:[]},
  ()=>({state:reconcileWorkflow(beforeReconcile as any),emittedEvents:0}));


const frozenOrder:any=copy(order),frozenClient:any=copy(client);
frozenClient.shippingFeeExcluded=true;
frozenOrder.confirmedAt=now;
frozenOrder.pricesLocked=true;
frozenOrder.clientSnapshot=frozenClient;
frozenOrder.vatAmount=3000;
add("frozen VAT and dealer fee terms","calculate_price",{
  order:frozenOrder,client},()=>totals(frozenOrder,frozenClient));

const unknownProduct:any=copy(order);
unknownProduct.recipients[0].items[0].productId="unregistered";
add("unknown product has manual shipping","calculate_shipping",{
  order:unknownProduct,state:baseState
},()=>recommendShipping(unknownProduct,baseState as any));

const zeroQuantity:any=copy(order);
zeroQuantity.recipients[0].items[0].quantity=0;
add("zero quantity is not a priceable bundle","calculate_shipping",{
  order:zeroQuantity,state:baseState
},()=>recommendShipping(zeroQuantity,baseState as any));

const negativeQuantity:any=copy(order);
negativeQuantity.recipients[0].items[0].quantity=-2;
add("negative quantity exact baseline outcome","calculate_shipping",{
  order:negativeQuantity,state:baseState
},()=>recommendShipping(negativeQuantity,baseState as any));

const dualOrigin:any=copy(order);
const storeItem:any=copy(item);
storeItem.id="store-item";
storeItem.origin="STORE";
storeItem.name="가상 매장 상품";
storeItem.productId="store-p";
storeItem.variantId="store-v";
storeItem.quantity=1;
dualOrigin.recipients[0].items.push(storeItem);
const dualState:any=copy(baseState);
dualState.products.push({
  ...copy(product),id:"store-p",name:"가상 매장 상품",
  origin:"STORE",shippingGroupId:"store-group",
  variants:[{id:"store-v",color:"Black",retail:15000,semi:14000,wholesale:13000}]
});
dualState.shipping.groups.push({
  id:"store-group",name:"매장 포장",
  current:{version:"store-v1",at:now,maxBundle:null,maxConfirmed:false,
    fees:{"1":2500},perItem:null,notes:"가상 매장"},
  history:[]
});
add("mixed STORE FACTORY bundles","calculate_shipping",{
  order:dualOrigin,state:dualState
},()=>recommendShipping(dualOrigin,dualState));

const multipleRecipients:any=copy(order);
const otherRecipient:any=copy(recipient);
otherRecipient.id="r2";
otherRecipient.name="가상 수취인 2";
multipleRecipients.recipients.push(otherRecipient);
add("two recipients and independent shipping","calculate_shipping",{
  order:multipleRecipients,state:baseState
},()=>recommendShipping(multipleRecipients,baseState as any));

const duplicateConfirmation:any=copy(baseState);
duplicateConfirmation.workflow.confirmations=[
  {id:"confirm-1",groupId:"group:o1",dealerId:"dealer-1",
    amount:0,allocations:[],shipmentIds:[]},
  {id:"confirm-1",groupId:"group:o1",dealerId:"dealer-1",
    amount:0,allocations:[],shipmentIds:[]}
];
add("duplicate confirmation ID rejection","validate_workflow",{
  state:duplicateConfirmation
},()=>{validateWorkflow(duplicateConfirmation);return {valid:true};});

const immutableBefore:any=copy(baseState);
immutableBefore.workflow.queue.push({
  id:"excel-1",shipmentId:"shipment:o1:r1",origin:"FACTORY",
  at:now,actor:"가상 담당자",status:"EXPORTED",
  snapshot:{total:34000,subtotal:30000,shipping:4000,vat:0}
});
const immutableAfter:any=copy(immutableBefore);
immutableAfter.workflow.queue[0].snapshot.total=1;
add("exported billing snapshot cannot be rewritten","validate_workflow",{
  state:immutableAfter,before:immutableBefore
},()=>{validateWorkflow(immutableAfter,immutableBefore);return {valid:true};});

const missingRecipientName:any=copy(baseState);
delete missingRecipientName.workflow;
missingRecipientName.orders[0].recipients[0].name="";
add("reconciliation synchronizes missing receiver issue","reconcile_workflow",{
  state:missingRecipientName,now,eventIds:[]
},()=>({state:reconcileWorkflow(missingRecipientName),emittedEvents:0}));

const staleDecision:any=copy(baseState);
delete staleDecision.workflow;
staleDecision.orders[0].issueResolutions={
  "issue:o1:r1:item1:OPTION":{
    resolution:"UNRESOLVED",resolutionSource:"직원",
    evidence:"stale-option",updatedAt:now
  }
};
add("reconciliation resolves obsolete issue decision","reconcile_workflow",{
  state:staleDecision,now,eventIds:[]
},()=>({state:reconcileWorkflow(staleDecision),emittedEvents:0}));


// TypeScript's orderIssues is the UI/approval source, not merely an issue-map
// snapshot. Compare complete title, stage, resolution, evidence and source span.
const issueOrder:any=copy(order);
add("order issues clean input","order_issues",{order:issueOrder},
  ()=>({issues:orderIssues(issueOrder)}));
const issueMissingName:any=copy(order);
issueMissingName.recipients[0].name="";
add("order issues missing name","order_issues",{order:issueMissingName},
  ()=>({issues:orderIssues(issueMissingName)}));
const issueMissingAddress:any=copy(order);
issueMissingAddress.receptionVersion=1;
issueMissingAddress.recipients[0].address="가상주소";
issueMissingAddress.recipients[0].addressStatus="INCOMPLETE";
add("order issues incomplete address","order_issues",{order:issueMissingAddress},
  ()=>({issues:orderIssues(issueMissingAddress)}));
const issueMissingQuantity:any=copy(order);
issueMissingQuantity.recipients[0].items[0].quantityConfirmed=false;
issueMissingQuantity.recipients[0].items[0].quantity=null;
add("order issues missing quantity","order_issues",{order:issueMissingQuantity},
  ()=>({issues:orderIssues(issueMissingQuantity)}));
const issueOption:any=copy(order);
issueOption.recipients[0].items[0].issues=["색상 확인 필요"];
issueOption.recipients[0].items[0].name="BD 709";
add("order issues color option confirmation","order_issues",{order:issueOption},
  ()=>({issues:orderIssues(issueOption)}));
const issueContact:any=copy(order);
issueContact.recipients[0].phone="010-123";
issueContact.recipients[0].mobile="";
add("order issues phone format detail","order_issues",{order:issueContact},
  ()=>({issues:orderIssues(issueContact)}));
const issueCustomerDecision:any=copy(issueMissingName);
issueCustomerDecision.issueResolutions={
  "issue:o1:r1:recipient:NAME":{
    resolution:"PENDING_CUSTOMER",resolutionSource:"직원 확인 요청",
    evidence:JSON.stringify(""),updatedAt:now
  }
};
add("order issues pending customer decision","order_issues",{order:issueCustomerDecision},
  ()=>({issues:orderIssues(issueCustomerDecision)}));
const issueAlias:any=copy(order);
issueAlias.recipients[0].items[0].match={kind:"COMMON_ALIAS",aliasId:"alias-1"};
add("order issues common alias auto applied","order_issues",{order:issueAlias},
  ()=>({issues:orderIssues(issueAlias)}));


const actionNow=new Date(now).toISOString();
function frozenDate<T>(callback:()=>T):T {
  const original=globalThis.Date;
  const RealDate=original;
  class FixedDate extends RealDate {
    constructor(...args:any[]) {
      super(args.length?args[0]:now);
    }
    static now(){return new RealDate(now).getTime();}
  }
  (globalThis as any).Date=FixedDate;
  try{return callback();}
  finally{(globalThis as any).Date=original;}
}
const approvalOrder:any=copy(order);
approvalOrder.recipients[0].items[0].quantity=null;
approvalOrder.recipients[0].items[0].quantityConfirmed=false;
add("approve missing quantity explicit actor","apply_issue_action",{
  action:"approve_missing_quantity",order:approvalOrder,
  recipientId:"r1",itemId:"item1",actor:"검증직원",now:actionNow
},()=>({order:frozenDate(()=>approveMissingQuantity(approvalOrder,"r1","item1","검증직원"))}));
const ambiguousApproval:any=copy(approvalOrder);
ambiguousApproval.recipients[0].items[0].issues=["여러 모델 가능"];
add("reject ambiguous quantity approval","apply_issue_action",{
  action:"approve_missing_quantity",order:ambiguousApproval,
  recipientId:"r1",itemId:"item1",actor:"검증직원",now:actionNow
},()=>({order:approveMissingQuantity(ambiguousApproval,"r1","item1","검증직원")}));
add("customer question issue decision","apply_issue_action",{
  action:"pending_issue",order:issueMissingName,
  issueId:"issue:o1:r1:recipient:NAME",actor:"검증직원",now:actionNow
},()=>({order:frozenDate(()=>pendingIssue(
  issueMissingName,"issue:o1:r1:recipient:NAME","검증직원"))}));
add("nonexistent issue is not recorded","apply_issue_action",{
  action:"pending_issue",order,issueId:"absent",actor:"검증직원",now:actionNow
},()=>({order:pendingIssue(order as any,"absent","검증직원")}));


function deterministicIds<T>(ids:string[],fn:()=>T):T {
  const descriptor=Object.getOwnPropertyDescriptor(globalThis,"crypto");
  let index=0;
  Object.defineProperty(globalThis,"crypto",{
    configurable:true,
    value:{randomUUID:()=>{
      if(index>=ids.length)throw Error("Not enough injected UUIDs in baseline");
      return ids[index++];
    }}
  });
  try{return frozenDate(fn);}
  finally{
    if(descriptor)Object.defineProperty(globalThis,"crypto",descriptor);
    else delete (globalThis as any).crypto;
  }
}
const missingDelete:any=copy(baseState);
add("delete missing order is rejected","delete_order",{
  state:missingDelete,orderId:"absent",now:actionNow,eventId:"delete-1",eventIds:[]
},()=>({state:deleteOrder(missingDelete,"absent")}));
const transferredDelete:any=copy(baseState);
transferredDelete.workflow.shipments[0].transferred=true;
add("transferred order ordinary delete blocked","delete_order",{
  state:transferredDelete,orderId:"o1",now:actionNow,eventId:"delete-1",eventIds:[]
},()=>({state:deleteOrder(transferredDelete,"o1")}));
const deletedOrder:any=copy(baseState);
deletedOrder.orders[0].deletedAt=now;
add("already deleted order no-op","delete_order",{
  state:deletedOrder,orderId:"o1",now:actionNow,eventId:"delete-1",eventIds:[]
},()=>({state:deleteOrder(deletedOrder,"o1")}));
const removeDraft:any=copy(baseState);
removeDraft.workflow.shipments[0].step=0;
add("delete unsent draft preserves receipt state","delete_order",{
  state:removeDraft,orderId:"o1",now:actionNow,eventId:"delete-1",eventIds:[]
},()=>({state:deterministicIds(["delete-1"],()=>deleteOrder(removeDraft,"o1"))}));
const removeStepTwo:any=copy(baseState);
add("delete step-two order writes recheck and deletion audit","delete_order",{
  state:removeStepTwo,orderId:"o1",now:actionNow,eventId:"delete-2",eventIds:["recheck-2"]
},()=>({state:deterministicIds(["recheck-2","delete-2"],()=>deleteOrder(removeStepTwo,"o1"))}));


const upgradeVersions=Object.fromEntries(
  ["music","microphone"].flatMap(prefix=>[1,2,3]
    .map(i=>[prefix+"-type-"+i,prefix+"-version-"+i]))
);
const upgradeIds=["music-version-1","music-version-2","music-version-3",
  "microphone-version-1","microphone-version-2","microphone-version-3"];
add("upgrade missing legacy shipping classification groups","apply_shipping_action",{
  action:"upgrade",shipping,now:actionNow,groupVersions:upgradeVersions
},()=>({shipping:deterministicIds(upgradeIds,()=>upgradeShipping(shipping as any))}));
const upgradedShipping:any=deterministicIds(upgradeIds,
  ()=>upgradeShipping(shipping as any));
add("upgrade existing classifications is idempotent","apply_shipping_action",{
  action:"upgrade",shipping:upgradedShipping,now:actionNow,groupVersions:{}
},()=>({shipping:upgradeShipping(upgradedShipping)}));


// Original TypeScript workflowIssues and stageIssues are executed directly.
// Each fixture copies the same state, including matching order/group/payment
// context. The Rust returned issue fields and list ordering are compared.
function wfCase(name:string,mutate:(state:any)=>void,stages:number[]=[1,2,3,4]){
  const state:any=copy(baseState);
  mutate(state);
  add("workflow issues: "+name,"workflow_issues",
    {state,groupId:"group:o1"},
    ()=>({issues:workflowIssues(state,"group:o1")}));
  for(const next of stages){
    add("stage "+next+" blockers: "+name,"stage_issues",
      {state,groupId:"group:o1",next},
      ()=>({issues:stageIssues(state,"group:o1",next)}));
  }
}
wfCase("clean unconfirmed order",()=>{});
wfCase("missing receiver name and delivery address",(s)=>{
  s.orders[0].recipients[0].name="";
  s.orders[0].recipients[0].address="";
});
wfCase("sender missing",s=>{
  s.clients[0].name="";
  s.clients[0].address="";
  s.clients[0].phone="";
});
wfCase("payment account missing",s=>{
  s.settings.accounts=[];
  s.settings.defaultAccountId="";
  s.clients[0].preferredAccountId="";
});
wfCase("reconfirmation notice",s=>{s.workflow.groups[0].needsNotice=true;});
wfCase("unknown product origin",s=>{
  s.orders[0].recipients[0].items[0].origin="UNKNOWN";
});
wfCase("missing selected product",s=>{
  s.orders[0].recipients[0].items[0].variantId="other-v";
});
wfCase("out of sale status",s=>{
  s.products[0].saleStatus="품절";
});
wfCase("deleted product",s=>{
  s.products[0].deletedAt=now;
});
wfCase("archived historical product",s=>{
  s.products[0].sourceProductId="parent-p";
  s.orders[0].recipients[0].items[0].productId="parent-p";
  s.productMappings={"parent-p|v1":"p1"};
});
wfCase("confirmed order with model mismatch",s=>{
  s.orders[0].confirmedAt=now;
  s.orders[0].recipients[0].items[0].variantId="missing-v";
});
wfCase("collect shipping no confirmed charge",s=>{
  s.orders[0].freightCode="020";
  s.workflow.shipments[0].charges={FACTORY:null};
});
wfCase("prepaid payment balance",s=>{
  s.clients[0].payment="PREPAID";
  s.workflow.shipments[0].step=3;
});
wfCase("postpaid payment",s=>{
  s.clients[0].payment="POSTPAID";
  s.workflow.shipments[0].step=3;
});
wfCase("retail order skip payment blockers",s=>{
  s.orders[0].orderType="RETAIL";
  s.orders[0].clientSnapshot={...copy(client),payment:"PREPAID"};
  s.workflow.shipments[0].step=0;
  s.workflow.shipments[0].charges={FACTORY:null};
});
wfCase("multiple recipients same group",s=>{
  const second=copy(s.orders[0].recipients[0]);
  second.id="r2";
  second.name="두번째 수취인";
  const secondItem=copy(second.items[0]);
  secondItem.id="item2";second.items=[secondItem];
  s.orders[0].recipients.push(second);
  const secondShip=copy(s.workflow.shipments[0]);
  secondShip.id="shipment:o1:r2";secondShip.recipientId="r2";
  s.workflow.shipments.push(secondShip);
},[1,2,4]);


wfCase("explicit sender raw text",s=>{
  s.orders[0].analysisRaw=[
    "발주 번호 001",
    "송하인: 별도 대리점",
    "연락처: 010-2345-6789",
    "송하인주소: 서울시 중구 가상길 15"
  ].join("\n");
});
wfCase("explicit sender without address or phone",s=>{
  s.orders[0].raw="보내는 분: 가상 발송업체";
});
wfCase("manual account selected and invalid",s=>{
  s.orders[0].accountMode="MANUAL";
  s.orders[0].accountId="not-an-account";
});
wfCase("brand-only BANDOMALL account selection",s=>{
  s.clients[0].preferredAccountId="";
  s.settings.brandAccounts={BANDOMALL:"mall-account",BANDOSTAND:"account-1"};
  s.settings.accounts.push({id:"mall-account",bank:"가상은행2",
    number:"234-567",holder:"쇼핑몰"});
  s.products[0].catalog="BANDOMALL";
});
wfCase("prepaid partially paid after notice",s=>{
  s.clients[0].payment="PREPAID";
  s.workflow.shipments[0].step=3;
  s.workflow.payments.push({id:"paid-1",dealerId:"dealer-1",
    account:copy(s.settings.accounts[0]),amount:20000,
    allocations:[{shipmentId:"shipment:o1:r1",amount:20000}]});
});
wfCase("prepaid confirmation intact",s=>{
  s.clients[0].payment="PREPAID";
  s.workflow.shipments[0].step=3;
  s.workflow.confirmations.push({id:"confirmation-1",groupId:"group:o1",
    dealerId:"dealer-1",shipmentIds:["shipment:o1:r1"],
    amount:70400,announcedAccount:copy(s.settings.accounts[0]),
    amounts:{"shipment:o1:r1":70400},
    allocations:[{shipmentId:"shipment:o1:r1",amount:70400}]});
});
wfCase("prepaid confirmation recheck required",s=>{
  s.clients[0].payment="PREPAID";
  s.workflow.shipments[0].step=3;
  s.workflow.confirmations.push({id:"confirmation-1",groupId:"group:o1",
    dealerId:"dealer-1",shipmentIds:["shipment:o1:r1"],
    amount:70400,announcedAccount:copy(s.settings.accounts[0]),
    amounts:{"shipment:o1:r1":70400},
    allocations:[{shipmentId:"shipment:o1:r1",amount:70400}]});
  s.workflow.events.push({id:"event-recheck",action:"입금 승인 재확인 필요",
    before:"confirmation-1",shipmentIds:["shipment:o1:r1"]});
});
wfCase("approved staff issue has pending customer confirmation",s=>{
  s.orders[0].recipients[0].name="";
  s.orders[0].issueResolutions={
    "issue:o1:r1:recipient:NAME":{
      resolution:"PENDING_CUSTOMER",resolutionSource:"직원",
      evidence:JSON.stringify(""),updatedAt:now
    }
  };
});
wfCase("confirmed order in separated shipment groups",s=>{
  s.orders[0].confirmedAt=now;
  const second=copy(s.orders[0].recipients[0]);
  second.id="r2";second.name="";
  second.items[0].id="item2";second.items[0].productId="missing-p";
  s.orders[0].recipients.push(second);
  // Only r1 belongs to the currently checked group.
});
wfCase("historical parent variant mismatch",s=>{
  s.products[0].sourceProductId="legacy-parent";
  s.productMappings={"legacy-parent|wrong-v":"p1"};
  s.orders[0].recipients[0].items[0].productId="legacy-parent";
  s.orders[0].recipients[0].items[0].variantId="wrong-v";
});
wfCase("product marked as sale preparation",s=>{
  s.products[0].saleStatus="판매준비중";
});
wfCase("product active false",s=>{
  s.products[0].active=false;
});
wfCase("multiple freight origins with missing charge",s=>{
  const store=copy(s.orders[0].recipients[0].items[0]);
  store.id="store-item";store.origin="STORE";
  s.orders[0].recipients[0].items.push(store);
  s.workflow.shipments[0].charges.STORE=null;
});
wfCase("unknown quantity but freight already entered",s=>{
  s.orders[0].recipients[0].items[0].quantity=null;
  s.workflow.shipments[0].charges={FACTORY:4000};
});

wfCase("retail without any dealer or historical snapshot",s=>{
  s.orders[0].orderType="RETAIL";
  s.orders[0].clientId="";
  delete s.orders[0].clientSnapshot;
  s.workflow.groups[0].dealerId="";
});
wfCase("prepaid missing total with unconfirmed quantity",s=>{
  s.clients[0].payment="PREPAID";
  s.workflow.shipments[0].step=3;
  s.orders[0].recipients[0].items[0].quantity=0;
});
wfCase("missing source all recipient inputs",s=>{
  s.orders[0].recipients[0].name="";
  s.orders[0].recipients[0].address="";
  s.orders[0].recipients[0].phone="";
  s.orders[0].recipients[0].mobile="";
  s.orders[0].recipients[0].items=[];
});
wfCase("recipient confirmedFields with conflicting candidates",s=>{
  s.orders[0].recipients[0].candidates=[
    {field:"name",value:"A"},{field:"name",value:"B"}
  ];
  s.orders[0].recipients[0].confirmedFields=[];
});
wfCase("customer model proposal pending",s=>{
  s.orders[0].recipients[0].items[0].modelProposal={required:true};
});
wfCase("historical confirmed order skips missing product validation",s=>{
  s.orders[0].confirmedAt=now;
  s.orders[0].recipients[0].items[0].productId="missing-p";
  s.orders[0].recipients[0].items[0].variantId="other-v";
});


wfCase("sender line with spaced 010 number",s=>{
  s.clients[0].phone="";
  s.orders[0].raw=[
    "송하인명: 가상 발송자",
    "전화번호 010 2345 6789",
    "송하인주소: 서울시 종로구 가상로 17"
  ].join("\n");
});
wfCase("sender marked with full-width colon",s=>{
  s.clients[0].phone="";
  s.orders[0].raw="보내는 사람：테스트 발송자\n휴대폰：010.2345.6789\n주소：서울시 종로구 가상로 17";
});
wfCase("sender marker with malformed address",s=>{
  s.orders[0].raw="송하인: 테스트 발송자\n연락처: 010-2345-6789";
});
function normalized(v:unknown):string {
  if(Array.isArray(v))return "["+v.map(normalized).join(",")+"]";
  if(v&&typeof v==="object") {
    const o=v as Record<string,unknown>;
    return "{"+Object.keys(o).sort()
      .map(key=>JSON.stringify(key)+":"+normalized(o[key])).join(",")+"}";
  }
  return JSON.stringify(v);
}
function differentialPaths(a:unknown,b:unknown,path="$",limit=50):string[] {
  if(normalized(a)===normalized(b))return [];
  if(a===null||b===null||typeof a!=="object"||typeof b!=="object"||
      Array.isArray(a)!==Array.isArray(b))return [path];
  const aa=a as Record<string,unknown>,bb=b as Record<string,unknown>;
  const keys=new Set([...Object.keys(aa),...Object.keys(bb)]);
  const changed:string[]=[];
  for(const key of keys){
    if(changed.length>=limit)break;
    const child=Array.isArray(a)?path+"["+key+"]":path+"."+key;
    if(!(key in aa)||!(key in bb))changed.push(child+" (missing)");
    else changed.push(...differentialPaths(aa[key],bb[key],child,limit-changed.length));
  }
  return changed;
}
function outcome(run:()=>unknown) {
  try {
    // The Rust entry point exchanges JSON, so normalize the original TS
    // object across that same boundary (undefined object keys disappear).
    return {ok:true,value:JSON.parse(JSON.stringify(run()))};
  }
  catch(error) {return {ok:false,error:error instanceof Error?error.message:String(error)};}
}
const rustBinary=process.env.TSBH_RULES_BIN;
const runner=spawnSync(rustBinary||"cargo",rustBinary?[]:[
  "run","--quiet","--manifest-path",
  "tests/rust-migration/rules/Cargo.toml","--bin","json_rules"
],{
  cwd:root,encoding:"utf8",timeout:180_000,maxBuffer:8*1024*1024,
  // CI's cargo test already built the rules binary; avoid a nested cargo lock.
  input:cases.map(c=>JSON.stringify({operation:c.operation,payload:c.payload})).join("\n")+"\n"
});
if(runner.error||runner.status!==0){
  console.error("Rust JSON runner unavailable:",runner.error?.message||runner.stderr);
  process.exit(2);
}
const output=runner.stdout.trim().split(/\r?\n/);
if(output.length!==cases.length){
  console.error("Unexpected Rust response count",output.length,"expected",cases.length);
  console.error(runner.stderr);
  process.exit(2);
}
let passed=0;
for(let i=0;i<cases.length;i++){
  const c=cases[i];
  const ts=outcome(c.baseline);
  let rust:unknown;
  try{rust=JSON.parse(output[i]);}
  catch {console.error("Invalid Rust JSON",c.name,output[i]);process.exit(2);}
  if(normalized(ts)===normalized(rust)){
    console.log("PARITY PASS",c.name);passed++;
  } else {
    console.error("PARITY FAIL",c.name);
    console.error("  DIFFERENT PATHS",differentialPaths(ts,rust).join(", "));
    console.error("  TS  ",normalized(ts).slice(0,2000));
    console.error("  Rust",normalized(rust).slice(0,2000));
  }
}
console.log("TS-Rust parity:",passed+"/"+cases.length,"matching");
if(passed!==cases.length)process.exitCode=1;
