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
import { resolvePrice, totals, parseOrder } from "../../../../src/domain.ts";
import {
  recommendShipping,
  editableShippingRule,
  combinationVersions,
  combinationCurrent,
  upgradeShipping,
} from "../../../../src/shipping.ts";
import { shipmentTotals, validateWorkflow, reconcileWorkflow, deleteOrder, workflowIssues, stageIssues, applyOrderRawEdit, migrateWorkflow } from "../../../../src/workflow.ts";
import { orderIssues, approveMissingQuantity, pendingIssue } from "../../../../src/validation.ts";
import { validateReceptionBoundary } from "../../../../src/orders/reception.ts";
import { companyClient, companyParty } from "../../../../src/order-types.ts";
import { explicitSender } from "../../../../src/explicit-sender.ts";

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
  expectedOk?:boolean;
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


// The parser remains the original TypeScript authority for this test. We
// inject the exact parsedRecipients it returned into the Rust workflow rule
// and replay the same generated IDs and clock in original applyOrderRawEdit.
function withIdCapture<T>(ids:string[],fn:()=>T):{result:T;used:number}{
  const descriptor=Object.getOwnPropertyDescriptor(globalThis,"crypto");
  let used=0;
  Object.defineProperty(globalThis,"crypto",{
    configurable:true,value:{randomUUID:()=>{
      if(used>=ids.length)throw Error("Insufficient test UUIDs");
      return ids[used++];
    }}
  });
  try{return {result:frozenDate(fn),used};}
  finally{
    if(descriptor)Object.defineProperty(globalThis,"crypto",descriptor);
    else delete (globalThis as any).crypto;
  }
}
function rawCase(name:string,raw:string,mutate:(s:any)=>void=()=>{},
  strictIdentity=false){
  const state:any=copy(baseState);
  // The source parser's normal app state has an alias list.
  state.aliases=[];
  state.products[0].defaultColor="Black";
  state.products[0].createdAt=now;
  state.products[0].updatedAt=now;
  mutate(state);
  const generated=Array.from({length:120},(_,i)=>"source-raw-"+(i+1));
  const orderRow=state.orders.find((o:any)=>o.id==="o1");
  const party=state.clients.find((c:any)=>c.id===orderRow?.clientId)
    ??orderRow?.clientSnapshot ??{
      id:"",name:"",contact:"",identifiers:"",active:true,tier:"wholesale",
      shippingFeeExcluded:false,payment:"PREPAID",overrides:{}
    };
  const prepared=raw.trim()&&orderRow&&raw!==orderRow.raw &&
    !orderRow.deletedAt ? withIdCapture(generated,()=>
      parseOrder(raw,party,state)) : {result:[],used:0};
  const payload={
    state,orderId:"o1",raw,actor:"검증직원",
    now:actionNow,strictIdentity,
    parsedRecipients:prepared.result,
    eventIds:generated.slice(prepared.used)
  };
  add("raw edit: "+name,"apply_order_raw_edit",payload,
    ()=>({state:deterministicIds(generated,()=>applyOrderRawEdit(
      state,"o1",raw,"검증직원",strictIdentity))}));
  cases[cases.length-1].expectedOk= ![
    "empty raw rejected","blank raw rejected",
    "previously deleted order blocked","Excel exported recipient blocked",
    "already delivered recipient blocked","payer identity cannot silently change",
    "already handed off store Excel blocked",
    "two paid recipients must preserve original recipient links"
  ].includes(name);
}
rawCase("unchanged source is a no-op",order.raw);
rawCase("empty raw rejected","");
rawCase("blank raw rejected","  ");
rawCase("previously deleted order blocked","새로운 발주",s=>{
  s.orders[0].deletedAt=now;
});
rawCase("Excel exported recipient blocked","변경된 발주",s=>{
  s.workflow.queue.push({id:"export-1",shipmentId:"shipment:o1:r1",
    origin:"FACTORY",status:"EXPORTED",snapshot:{}});
});
rawCase("already delivered recipient blocked","변경된 발주",s=>{
  s.workflow.shipments[0].delivery={at:now};
});
rawCase("raw text edit with existing recipient",
  "받는분: 가상 수취인\n주소: 서울시 가상로 1\n연락처: 010-1234-5678\n상품: 가상 상품 2개");
rawCase("strict identity does not reuse old recipient by index",
  "새 수취인\n서울시 가상로 22\n010-2222-3333\n가상 상품 2개",
  ()=>{},true);
rawCase("queued Excel is cancelled on raw revision",
  "가상 수취인\n서울시 가상로 1\n010-1234-5678\n가상 상품 2개",s=>{
    s.workflow.queue.push({id:"queued-1",shipmentId:"shipment:o1:r1",
      origin:"FACTORY",at:now,status:"QUEUED",snapshot:{}});
  });
rawCase("payer identity cannot silently change",
  "새 수취인\n서울시 가상로 22\n010-2222-3333\n가상 상품 2개",s=>{
    s.workflow.payments.push({id:"paid-1",dealerId:"dealer-1",amount:1000,
      allocations:[{shipmentId:"shipment:o1:r1",amount:1000}]});
  });
rawCase("previously confirmed step requires rechecks",
  "가상 수취인\n서울시 가상로 1\n010-1234-5678\n가상 상품 1개",s=>{
    s.workflow.shipments[0].step=3;
  });


rawCase("cancelled Excel does not block original raw correction",
  "가상 수취인\n서울시 가상로 1\n010-1234-5678\n가상 상품 3개",s=>{
    s.workflow.queue.push({id:"cancelled-1",shipmentId:"shipment:o1:r1",
      origin:"FACTORY",status:"CANCELLED",snapshot:{}});
  });
rawCase("already handed off store Excel blocked",
  "가상 수취인\n서울시 가상로 1\n010-1234-5678\n가상 상품 3개",s=>{
    s.workflow.queue.push({id:"store-sent-1",shipmentId:"shipment:o1:r1",
      origin:"STORE",status:"STORE_SENT",snapshot:{}});
  });
rawCase("same name protects already paid recipient after contact correction",
  "김가상\n서울시 가상로 1\n010-2222-3333\n가상 상품 3개",s=>{
    s.orders[0].recipients[0].name="김가상";
    s.workflow.payments.push({id:"payment-1",dealerId:"dealer-1",
      amount:1000,allocations:[{shipmentId:"shipment:o1:r1",amount:1000}]});
  });
rawCase("same mobile preserves identity when recipient name is corrected",
  "이름: 수정된 수취인\n주소: 서울시 가상로 1\n휴대폰: 010-1234-5678\n가상 상품 2개",s=>{
    s.orders[0].recipients[0].mobile="010-1234-5678";
    s.orders[0].recipients[0].phone="";
    s.workflow.payments.push({id:"payment-2",dealerId:"dealer-1",
      amount:1000,allocations:[{shipmentId:"shipment:o1:r1",amount:1000}]});
  });
rawCase("manual item confirmation carries matching historical fields",
  "가상 수취인\n서울시 가상로 1\n010-1234-5678\n가상 상품 2개",s=>{
    s.orders[0].recipients[0].items[0].manuallyConfirmed=true;
    s.orders[0].recipients[0].items[0].quantityApproval={
      at:now,actor:"가상 담당자",quantity:2
    };
    s.orders[0].recipients[0].vatOverride=false;
    s.orders[0].messageEdits={payment:"기존 문구"};
    s.workflow.groups[0].messageEdits={payment:"이전 안내"};
  });
rawCase("edit previously confirmed order keeps master-snapshot policy",
  "가상 수취인\n서울시 가상로 1\n010-1234-5678\n가상 상품 2개",s=>{
    s.orders[0].confirmedAt=now;
    s.orders[0].pricesLocked=true;
    s.orders[0].clientSnapshot=copy(s.clients[0]);
  });
rawCase("strict identity retains matching phone",
  "받는분: 가상 수취인\n주소: 서울시 가상로 1\n연락처: 010-1234-5678\n가상 상품 2개",
  s=>{
    s.orders[0].recipients[0].mobile="010-1234-5678";
    s.orders[0].recipients[0].phone="";
  },true);
rawCase("two paid recipients must preserve original recipient links",
  "가상 수취인\n서울시 가상로 1\n010-1234-5678\n가상 상품 2개",s=>{
    const r=copy(s.orders[0].recipients[0]);
    r.id="r2";r.name="다른 수취인";r.phone="010-8888-7777";
    r.items[0].id="item2";
    s.orders[0].recipients.push(r);
    const ship=copy(s.workflow.shipments[0]);
    ship.id="shipment:o1:r2";ship.recipientId="r2";
    s.workflow.shipments.push(ship);
    s.workflow.payments.push({id:"payment-r2",dealerId:"dealer-1",
      amount:1000,allocations:[{shipmentId:"shipment:o1:r2",amount:1000}]});
  });



// Historical workflow conversion. The TypeScript baseline executes the REAL
// migrateWorkflow, including reconciliation, and must produce a successful
// State. Rust consumes the same initial State and the same UUID/time stream.
function migrationCase(name:string,mutate:(state:any)=>void=()=>{},expectedOk=true){
  const legacy:any=copy(baseState);
  legacy.aliases=[];
  mutate(legacy);
  const ids=Array.from({length:160},(_,i)=>"legacy-uuid-"+(i+1));
  add("legacy migration: "+name,"migrate_workflow",{
    state:legacy,now:actionNow,eventIds:ids
  },()=>{
    const migrated:any=deterministicIds(ids,()=>migrateWorkflow(legacy));
    // In addition to parity, require the source implementation to retain
    // every pre-existing immutable payment, source and audit record.
    for(const key of ["payments","sources","events","deliveries",
      "changeRequests","confirmations","queue"]){
      for(const previous of legacy.workflow?.[key]??[]){
        const current=migrated.workflow?.[key]?.find((entry:any)=>entry.id===previous.id);
        if(!current||normalized(current)!==normalized(previous))
          throw Error("Migration modified historic "+key+" record: "+previous.id);
      }
    }
    for(const previous of legacy.workflow?.groups??[]){
      const current=migrated.workflow?.groups?.find((entry:any)=>entry.id===previous.id);
      if(!current||normalized(current.notices)!==normalized(previous.notices))
        throw Error("Migration modified historical group notice: "+previous.id);
    }
    return {state:migrated};
  });
  cases[cases.length-1].expectedOk=expectedOk;
}
migrationCase("REVIEW with no prior workflow",s=>{
  delete s.workflow;
  s.queue=[];
  s.orders[0].status="REVIEW";
});
migrationCase("notified historical order",s=>{
  delete s.workflow;
  s.orders[0].notified=true;
  s.orders[0].status="STATEMENT";
});
migrationCase("paid legacy order preserves historical approval",s=>{
  delete s.workflow;
  s.orders[0].paid=true;
  s.orders[0].status="PAID";
});
migrationCase("postpaid already approved",s=>{
  delete s.workflow;
  s.orders[0].postpaidApproved=true;
  s.orders[0].status="STATEMENT";
});
migrationCase("old queued order creates frozen Excel queue",s=>{
  delete s.workflow;
  s.orders[0].status="QUEUED";
  s.queue=["o1"];
});
migrationCase("old exported order becomes historical archive",s=>{
  delete s.workflow;
  s.orders[0].status="EXPORTED";
});
migrationCase("notified despite queued legacy flag",s=>{
  delete s.workflow;
  s.orders[0].notified=true;
  s.orders[0].status="STATEMENT";
  s.queue=["o1"];
});
migrationCase("two historical recipients with independent quantities",s=>{
  delete s.workflow;
  s.orders[0].status="QUEUED";
  s.orders[0].paid=true;
  s.queue=["o1"];
  const second=copy(s.orders[0].recipients[0]);
  second.id="r2";second.name="두번째 수취인";
  second.items[0].id="item2";second.items[0].quantity=1;
  s.orders[0].recipients.push(second);
});
migrationCase("preserve existing payment allocations and event IDs",s=>{
  s.orders[0].paid=true;
  s.orders[0].status="PAID";
  s.workflow.payments.push({
    id:"old-payment",dealerId:"dealer-1",
    account:copy(s.settings.accounts[0]),amount:15000,
    allocations:[{shipmentId:"shipment:o1:r1",amount:15000}]
  });
  s.workflow.events.push({
    id:"old-event",at:now,actor:"이전 직원",
    action:"실제 입금",shipmentIds:["shipment:o1:r1"],
    groupId:"group:o1"
  });
});
migrationCase("preserve existing confirmed account and delivery history",s=>{
  s.orders[0].status="EXPORTED";
  s.workflow.confirmations.push({
    id:"old-confirm",groupId:"group:o1",dealerId:"dealer-1",
    shipmentIds:["shipment:o1:r1"],amount:70000,
    confirmedAt:now,actor:"이전 직원",
    announcedAccount:copy(s.settings.accounts[0]),
    amounts:{"shipment:o1:r1":70000},
    allocations:[{shipmentId:"shipment:o1:r1",amount:70000}]
  });
  s.workflow.events.push({
    id:"old-event-2",at:now,actor:"이전 직원",
    action:"입금 확인",shipmentIds:["shipment:o1:r1"],groupId:"group:o1"
  });
});
migrationCase("old shipment queue and historical audit not overwritten",s=>{
  s.orders[0].status="QUEUED";
  s.queue=["o1"];
  s.workflow.payments.push({
    id:"old-payment-2",dealerId:"dealer-1",
    account:copy(s.settings.accounts[0]),amount:1000,
    allocations:[{shipmentId:"shipment:o1:r1",amount:1000}]
  });
  s.workflow.queue.push({
    id:"old-queue",shipmentId:"shipment:o1:r1",origin:"FACTORY",
    at:now,status:"CANCELLED",legacy:true,
    snapshot:{sender:copy(s.clients[0]),subtotal:40000,
      vat:4000,shipping:3000,total:47000}
  });
});
migrationCase("multi-origin invoice snapshot remains item-filtered",s=>{
  delete s.workflow;
  s.orders[0].status="QUEUED";
  s.queue=["o1"];
  const next=copy(s.orders[0].recipients[0].items[0]);
  next.id="store-item";next.origin="STORE";
  s.orders[0].recipients[0].items.push(next);
});


migrationCase("legacy explicit sender is stored in sender snapshot",s=>{
  delete s.workflow;
  s.orders[0].status="PAID";
  s.orders[0].paid=true;
  s.orders[0].raw=[
    "송하인: 별도 대리점",
    "연락처: 010-4444-8888",
    "송하인주소: 서울특별시 가상로 16"
  ].join("\n");
});
migrationCase("existing independent sender snapshot is preserved",s=>{
  delete s.workflow;
  s.orders[0].status="STATEMENT";
  s.orders[0].notified=true;
  s.orders[0].senderSnapshot={
    ...copy(s.clients[0]),name:"기존 발송 주체",
    displayName:"기존 발송 주체",
    phone:"02-8888-1111"
  };
});
migrationCase("legacy collect shipment has zero prepaid freight",s=>{
  delete s.workflow;
  s.orders[0].status="QUEUED";
  s.orders[0].freightCode="020";
  s.queue=["o1"];
});
migrationCase("legacy no shipping fee retains automatic tariff",s=>{
  delete s.workflow;
  s.orders[0].shippingFee=null;
  s.orders[0].status="STATEMENT";
  s.orders[0].notified=true;
});
migrationCase("legacy STORE-only shipment receives manual historic fee",s=>{
  delete s.workflow;
  s.orders[0].status="QUEUED";
  s.queue=["o1"];
  s.orders[0].shippingFee=2500;
  s.orders[0].recipients[0].items[0].origin="STORE";
});
migrationCase("legacy with existing receipt and frozen invoice audit",s=>{
  s.orders[0].status="EXPORTED";
  s.orders[0].receipt={
    original:"옛 원문",at:now,actor:"이전 직원",
    clientId:"dealer-1",legacy:true
  };
  s.orders[0].rawHistory=[{at:now,raw:"최초 원문",actor:"이전 직원"}];
  s.workflow.groups[0].notices.push({
    id:"old-notice",at:now,actor:"이전 직원",
    shipmentIds:["shipment:o1:r1"],amounts:{"shipment:o1:r1":70000},
    total:70000,account:copy(s.settings.accounts[0]),message:"기존 청구 내역"
  });
});
migrationCase("existing delivery and payment remain immutable",s=>{
  s.orders[0].status="EXPORTED";
  s.workflow.payments.push({
    id:"payment-existing",dealerId:"dealer-1",
    account:copy(s.settings.accounts[0]),
    amount:55000,allocations:[{shipmentId:"shipment:o1:r1",amount:55000}]
  });
  s.workflow.deliveries.push({
    id:"delivery-existing",shipmentId:"shipment:o1:r1",
    origin:"FACTORY",completedAt:now,tracking:"TEST-001"
  });
  s.workflow.changeRequests.push({
    id:"request-existing",shipmentId:"shipment:o1:r1",
    at:now,actor:"이전 직원",reason:"주소 확인"
  });
});


migrationCase("two historical orders retain separate paid and queued records",s=>{
  s.orders[0].paid=true;
  s.orders[0].status="PAID";
  s.workflow.payments.push({
    id:"historical-partial",dealerId:"dealer-1",
    account:copy(s.settings.accounts[0]),amount:5000,
    allocations:[{shipmentId:"shipment:o1:r1",amount:5000}]
  });
  const second=copy(s.orders[0]);
  second.id="o2";second.paid=false;second.status="QUEUED";
  second.notified=true;
  second.raw="두번째 주문 원문";
  second.recipients[0].id="r2";
  second.recipients[0].name="별도 수취인";
  second.recipients[0].items[0].id="item2";
  s.orders.push(second);
  s.queue=["o2"];
});
migrationCase("legacy status does not erase multiple payment allocations",s=>{
  s.orders[0].status="QUEUED";
  s.queue=["o1"];
  s.workflow.payments.push({
    id:"historical-multi-allocation",dealerId:"dealer-1",
    account:copy(s.settings.accounts[0]),amount:42000,
    allocations:[
      {shipmentId:"shipment:o1:r1",amount:20000},
      {shipmentId:"shipment:o1:r1",amount:22000}
    ]
  });
});
migrationCase("company sender for legacy dealer order",s=>{
  delete s.workflow;
  s.orders[0].orderType="DEALER";
  s.orders[0].status="EXPORTED";
  s.settings.senderName="가상 반도 본사";
  s.settings.senderPostcode="11111";
});
migrationCase("clientSnapshot outranks edited master sender during migration",s=>{
  delete s.workflow;
  s.orders[0].status="STATEMENT";
  s.orders[0].notified=true;
  s.orders[0].clientSnapshot={
    ...copy(s.clients[0]),name:"당시 업체",
    displayName:"당시 업체",phone:"02-1111-2222",
    address:"서울시 과거로 11"
  };
  s.clients[0].name="지금 업체";
  s.clients[0].address="서울시 현재로 22";
});
migrationCase("explicit sender with fullwidth label and spaced number",s=>{
  delete s.workflow;
  s.orders[0].status="PAID";
  s.orders[0].raw=[
    "연락처: 02-9999-1234",
    "송하인명：별도 발송사",
    "연락처：010 2222 3333",
    "주소：서울시 가상로 25 2층"
  ].join("\n");
});
migrationCase("exclusively archived legacy invoice cannot be re-billed",s=>{
  s.orders[0].status="EXPORTED";
  s.workflow.shipments[0].legacyArchived=true;
  s.workflow.events.push({
    id:"audit-archive",at:now,actor:"이전 직원",
    action:"배송 이력 보존",shipmentIds:["shipment:o1:r1"],
    groupId:"group:o1",after:{"reason":"예전 명세서"}
  });
},false);
migrationCase("archived REVIEW shipment preserves original audit",s=>{
  s.orders[0].status="REVIEW";
  s.workflow.shipments[0].legacyArchived=true;
  s.workflow.events.push({
    id:"audit-archive-review",at:now,actor:"이전 직원",
    action:"배송 이력 보존",shipmentIds:["shipment:o1:r1"],
    groupId:"group:o1",after:{"reason":"예전 명세서"}
  });
});


// validateWorkflow is a distinct TS function from validateReceptionBoundary:
// test both its current-state guards and exact before->after preservation,
// including error priority when multiple checks would fail.
function validationCase(name:string,setup:(s:any)=>void,change:(s:any)=>void,
  expectedOk:boolean,withBefore=true){
  const before:any=copy(baseState);
  setup(before);
  const state:any=copy(before);
  change(state);
  add("validate workflow: "+name,"validate_workflow",
    withBefore?{state,before}:{state},
    ()=>{validateWorkflow(state as any,withBefore?before as any:undefined);return {valid:true};});
  cases[cases.length-1].expectedOk=expectedOk;
}
const unchanged=()=>{};
validationCase("unchanged state before supplied",unchanged,unchanged,true);
validationCase("no workflow is valid",unchanged,s=>{delete s.workflow;},true);
for(const name of ["sources","groups","shipments","payments","queue",
  "events","deliveries","changeRequests"]){
  validationCase("duplicate "+name+" ID",s=>{
    const sample:any={
      sources:s.workflow.sources[0],groups:s.workflow.groups[0],
      shipments:s.workflow.shipments[0],
      payments:{id:"payment1",dealerId:"dealer-1",amount:0,allocations:[]},
      queue:{id:"queue1",shipmentId:"shipment:o1:r1",origin:"FACTORY",status:"QUEUED"},
      events:{id:"event1",action:"TEST",shipmentIds:[]},
      deliveries:{id:"delivery1",shipmentId:"shipment:o1:r1",origin:"FACTORY"},
      changeRequests:{id:"change1",shipmentId:"shipment:o1:r1"}
    }[name];
    s.workflow[name].push(copy(sample));
  },s=>{s.workflow[name].push(copy(s.workflow[name][0]));},false,false);
}
validationCase("invalid shipment missing recipient",unchanged,s=>{
  s.workflow.shipments[0].recipientId="missing-r";
},false);
validationCase("archived missing recipient is skipped with no prior immutable link",unchanged,s=>{
  s.workflow.shipments[0].legacyArchived=true;
  s.workflow.shipments[0].recipientId="missing-r";
},true,false);
validationCase("retail missing transfer",unchanged,s=>{
  s.orders[0].orderType="RETAIL";s.workflow.groups[0].dealerId="dealer-1";
  s.workflow.shipments[0].transferred=false;
},false);
validationCase("retail linked to payment",unchanged,s=>{
  s.orders[0].orderType="RETAIL";
  s.workflow.shipments[0].transferred=true;s.workflow.shipments[0].step=4;
  s.workflow.payments=[{id:"p-1",dealerId:"dealer-1",amount:2,
    allocations:[{shipmentId:"shipment:o1:r1",amount:2}]}];
},false);
validationCase("retail linked to confirmed notice",unchanged,s=>{
  s.orders[0].orderType="RETAIL";
  s.workflow.shipments[0].transferred=true;s.workflow.shipments[0].step=4;
  s.workflow.groups[0].notices=[{id:"notice-1",at:now}];
},false);
validationCase("retail valid stage four",unchanged,s=>{
  s.orders[0].orderType="RETAIL";
  s.workflow.shipments[0].transferred=true;s.workflow.shipments[0].step=4;
},true);
for(const key of ["sourceId","orderId","recipientId"]){
  validationCase("modified shipment link "+key,unchanged,s=>{
    s.workflow.shipments[0][key]="broken-id";
  },false);
}
validationCase("invalid group source relation",unchanged,s=>{
  s.workflow.groups[0].sourceId="broken-source";
},false);
validationCase("invalid client assignment",unchanged,s=>{
  s.workflow.groups[0].dealerId="other-dealer";
},false);
for(const step of [-1,5,1.5,null]){
  validationCase("invalid step "+step,unchanged,s=>{
    s.workflow.shipments[0].step=step;
  },false);
}
for(const [which,val] of [["charges",-1],["charges",1.5],["actualFreight",-1],
  ["actualFreight",1.25]] as const){
  validationCase("invalid "+which+" "+val,unchanged,s=>{
    s.workflow.shipments[0][which]={FACTORY:val};
  },false);
}
validationCase("charges null permitted",unchanged,s=>{
  s.workflow.shipments[0].charges.FACTORY=null;
},true);
validationCase("actual freight zero valid",unchanged,s=>{
  s.workflow.shipments[0].actualFreight={FACTORY:0};
},false);
validationCase("payment allocation exceeds amount",unchanged,s=>{
  s.workflow.payments.push({id:"p-invalid",dealerId:"dealer-1",amount:1,
    allocations:[{shipmentId:"shipment:o1:r1",amount:2}]});
},false);
validationCase("payment allocation wrong dealer",unchanged,s=>{
  s.workflow.payments.push({id:"p-invalid",dealerId:"other-dealer",amount:10,
    allocations:[{shipmentId:"shipment:o1:r1",amount:3}]});
},false);
validationCase("payment allocation unknown shipment",unchanged,s=>{
  s.workflow.payments.push({id:"p-invalid",dealerId:"dealer-1",amount:10,
    allocations:[{shipmentId:"shipment:unknown",amount:3}]});
},false);
validationCase("missing Excel shipment",unchanged,s=>{
  s.workflow.queue.push({id:"q-invalid",shipmentId:"unknown-shipment",
    origin:"FACTORY",status:"QUEUED"});
},false);
validationCase("duplicate delivery per origin",unchanged,s=>{
  s.workflow.deliveries.push({id:"d-1",shipmentId:"shipment:o1:r1",origin:"FACTORY"});
  s.workflow.deliveries.push({id:"d-2",shipmentId:"shipment:o1:r1",origin:"FACTORY"});
},false);
validationCase("confirmation duplicate id",unchanged,s=>{
  const c={id:"confirm-1",groupId:"group:o1",dealerId:"dealer-1",
    amount:1,shipmentIds:["shipment:o1:r1"],
    allocations:[{shipmentId:"shipment:o1:r1",amount:1}]};
  s.workflow.confirmations.push(copy(c),copy(c));
},false);
validationCase("confirmation unknown group",unchanged,s=>{
  s.workflow.confirmations.push({id:"confirm-1",groupId:"missing-group",
    amount:1,shipmentIds:["shipment:o1:r1"],allocations:[]});
},false);
validationCase("confirmation missing allocation shipment",unchanged,s=>{
  s.workflow.confirmations.push({id:"confirm-1",groupId:"group:o1",
    amount:1,shipmentIds:["shipment:o1:r1"],
    allocations:[{shipmentId:"missing",amount:1}]});
},false);
validationCase("old payment cannot be deleted",s=>{
  s.workflow.payments.push({id:"p-1",dealerId:"dealer-1",amount:10,
    allocations:[{shipmentId:"shipment:o1:r1",amount:10}]});
},s=>{s.workflow.payments=[];},false);
validationCase("old payment cannot be modified",s=>{
  s.workflow.payments.push({id:"p-1",dealerId:"dealer-1",amount:10,
    allocations:[{shipmentId:"shipment:o1:r1",amount:10}]});
},s=>{s.workflow.payments[0].amount=12;},false);
validationCase("old events cannot be removed",s=>{
  s.workflow.events.push({id:"e-1",at:now,actor:"old",action:"OLD",shipmentIds:[]});
},s=>{s.workflow.events=[];},false);
validationCase("old delivery cannot be removed",s=>{
  s.workflow.deliveries.push({id:"delivery-old",shipmentId:"shipment:o1:r1",
    origin:"FACTORY",charge:4000,actual:3400});
},s=>{s.workflow.deliveries=[];},false);
validationCase("old source raw cannot be modified",unchanged,s=>{
  s.workflow.sources[0].raw="changed source";
},false);
validationCase("old request cannot be modified",s=>{
  s.workflow.changeRequests=[{id:"cr-1",shipmentId:"shipment:o1:r1",
    text:"original",at:now,actor:"old"}];
},s=>{s.workflow.changeRequests[0].text="changed";},false);
validationCase("shipment ID cannot be deleted",unchanged,s=>{
  s.workflow.shipments=[];
},false);
validationCase("old shipment recipient link cannot change",unchanged,s=>{
  s.workflow.shipments[0].recipientId="another-r";
},false);
validationCase("old delivery snapshot cannot be edited",s=>{
  s.workflow.shipments[0].delivery={at:now,actor:"old",actual:{FACTORY:3000}};
},s=>{s.workflow.shipments[0].delivery.actual.FACTORY=4500;},false);
validationCase("old account notice cannot change",s=>{
  s.workflow.groups[0].notices=[{id:"notice-1",at:now,
    account:copy(s.settings.accounts[0]),amount:44000}];
},s=>{s.workflow.groups[0].notices[0].amount=123;},false);
validationCase("old group message may change without notice loss",s=>{
  s.workflow.groups[0].notices=[{id:"notice-1",at:now}];
},s=>{s.workflow.groups[0].messageEdits={payment:"updated"};},true);
validationCase("queued snapshot cannot change",s=>{
  s.workflow.queue=[{id:"q1",shipmentId:"shipment:o1:r1",origin:"FACTORY",
    status:"QUEUED",snapshot:{total:3000}}];
},s=>{s.workflow.queue[0].snapshot.total=9000;},false);
validationCase("cancelled snapshot may change",s=>{
  s.workflow.queue=[{id:"q1",shipmentId:"shipment:o1:r1",origin:"FACTORY",
    status:"CANCELLED",snapshot:{total:3000}}];
},s=>{s.workflow.queue[0].snapshot.total=9000;},true);
validationCase("queue immutable shipment ownership",s=>{
  s.workflow.queue=[{id:"q1",shipmentId:"shipment:o1:r1",origin:"FACTORY",
    status:"QUEUED",snapshot:{total:3000}}];
},s=>{s.workflow.queue[0].shipmentId="changed";},false);
validationCase("mismatch reception policy should not affect validateWorkflow",unchanged,s=>{
  s.orders[0].orderType="INVALID";
  s.orders[0].confirmedAt=now;
},true);
validationCase("old confirmed receipt raw is outside validateWorkflow",unchanged,s=>{
  s.orders[0].confirmedAt=now;
  s.orders[0].raw="new confirmed raw";
},true);


// Invariant-focused before/after cases; require original TS success/failure
// as a separate assertion so two erroneous implementations cannot both PASS.
function historyConfirmation(){
  return {id:"confirm-old",groupId:"group:o1",dealerId:"dealer-1",
    shipmentIds:["shipment:o1:r1"],amount:100,
    confirmedAt:now,actor:"기존 직원",
    announcedAccount:copy(settings.accounts[0]),
    amounts:{"shipment:o1:r1":100},
    allocations:[{shipmentId:"shipment:o1:r1",amount:100}]};
}
validationCase("confirmation immutable baseline",s=>{
  s.workflow.confirmations=[historyConfirmation()];
},unchanged,true);
validationCase("confirmation deletion before final approval",s=>{
  s.workflow.confirmations=[historyConfirmation()];
},s=>{s.workflow.confirmations=[];},true);
validationCase("confirmation deletion after transferred shipment",s=>{
  s.workflow.confirmations=[historyConfirmation()];
  s.workflow.shipments[0].transferred=true;
},s=>{s.workflow.confirmations=[];},false);
validationCase("confirmation deletion after step four",s=>{
  s.workflow.confirmations=[historyConfirmation()];
  s.workflow.shipments[0].step=4;
},s=>{s.workflow.confirmations=[];},false);
validationCase("confirmation amount cannot change directly",s=>{
  s.workflow.confirmations=[historyConfirmation()];
},s=>{s.workflow.confirmations[0].amount=500;},false);
validationCase("confirmation actor cannot change directly",s=>{
  s.workflow.confirmations=[historyConfirmation()];
},s=>{s.workflow.confirmations[0].actor="무단 변경";},false);
validationCase("confirmation balance shape cannot change",s=>{
  s.workflow.confirmations=[historyConfirmation()];
},s=>{s.workflow.confirmations[0].amounts={"shipment:o1:r1":101};},false);
validationCase("valid partial confirmation cancellation",s=>{
  const row=copy(s.orders[0].recipients[0]);
  row.id="r2";row.name="두번째 수취인";row.items[0].id="item2";
  s.orders[0].recipients.push(row);
  const shipment=copy(s.workflow.shipments[0]);
  shipment.id="shipment:o1:r2";shipment.recipientId="r2";
  s.workflow.shipments.push(shipment);
  const confirmation=historyConfirmation();
  confirmation.shipmentIds=["shipment:o1:r1","shipment:o1:r2"];
  confirmation.amounts={"shipment:o1:r1":100,"shipment:o1:r2":200};
  confirmation.allocations=[
    {shipmentId:"shipment:o1:r1",amount:100},
    {shipmentId:"shipment:o1:r2",amount:200}
  ];
  confirmation.amount=300;
  s.workflow.confirmations=[confirmation];
},s=>{
  const c=s.workflow.confirmations[0];
  c.shipmentIds=["shipment:o1:r1"];
  c.allocations=[{shipmentId:"shipment:o1:r1",amount:100}];
  c.amounts={"shipment:o1:r1":100};c.amount=100;
},true);
validationCase("partial confirmation cancellation forbidden for transferred removed ship",s=>{
  const row=copy(s.orders[0].recipients[0]);
  row.id="r2";row.name="두번째 수취인";row.items[0].id="item2";
  s.orders[0].recipients.push(row);
  const shipment=copy(s.workflow.shipments[0]);
  shipment.id="shipment:o1:r2";shipment.recipientId="r2";
  shipment.transferred=true;
  s.workflow.shipments.push(shipment);
  const confirmation=historyConfirmation();
  confirmation.shipmentIds=["shipment:o1:r1","shipment:o1:r2"];
  confirmation.amounts={"shipment:o1:r1":100,"shipment:o1:r2":200};
  confirmation.allocations=[
    {shipmentId:"shipment:o1:r1",amount:100},
    {shipmentId:"shipment:o1:r2",amount:200}
  ];
  confirmation.amount=300;
  s.workflow.confirmations=[confirmation];
},s=>{
  const c=s.workflow.confirmations[0];
  c.shipmentIds=["shipment:o1:r1"];
  c.allocations=[{shipmentId:"shipment:o1:r1",amount:100}];
  c.amounts={"shipment:o1:r1":100};c.amount=100;
},false);
validationCase("all existing confirmation IDs may coexist with new",s=>{
  s.workflow.confirmations=[historyConfirmation()];
},s=>{
  const c=historyConfirmation();c.id="confirm-added";
  s.workflow.confirmations.push(c);
},true);
validationCase("double actual freight invalid values prefer actualFreight",unchanged,s=>{
  s.workflow.shipments[0].actualFreight={FACTORY:-1};
  s.workflow.shipments[0].charges={FACTORY:-1};
},false);
validationCase("double invalid retail record prefer retail guard",unchanged,s=>{
  s.orders[0].orderType="RETAIL";
  s.workflow.groups[0].sourceId="bad-link";
  s.workflow.shipments[0].transferred=false;
},false);
validationCase("old confirmation change preferred before history deletion",s=>{
  s.workflow.confirmations=[historyConfirmation()];
  s.workflow.events=[{id:"prior-event",action:"OTHER",shipmentIds:[]}];
},s=>{
  s.workflow.confirmations[0].amount=999;
  s.workflow.events=[];
},false);
validationCase("actual freight audit valid with old field absent",unchanged,s=>{
  s.workflow.shipments[0].actualFreight={FACTORY:3210};
  s.workflow.events.push({
    id:"freight-evidence-1",at:now,actor:"직원",
    action:"실제 출고 운임 입력",shipmentIds:["shipment:o1:r1"],
    before:null,after:{origin:"FACTORY",amount:3210}
  });
},true);
validationCase("actual freight change without evidence is blocked",unchanged,s=>{
  s.workflow.shipments[0].actualFreight={FACTORY:3210};
},false);
validationCase("actual freight audit wrong old amount blocked",unchanged,s=>{
  s.workflow.shipments[0].actualFreight={FACTORY:3210};
  s.workflow.events.push({
    id:"freight-evidence-2",at:now,actor:"직원",
    action:"실제 출고 운임 입력",shipmentIds:["shipment:o1:r1"],
    before:5000,after:{origin:"FACTORY",amount:3210}
  });
},false);
validationCase("actual freight audit wrong origin blocked",unchanged,s=>{
  s.workflow.shipments[0].actualFreight={FACTORY:3210};
  s.workflow.events.push({
    id:"freight-evidence-3",at:now,actor:"직원",
    action:"실제 출고 운임 입력",shipmentIds:["shipment:o1:r1"],
    before:null,after:{origin:"STORE",amount:3210}
  });
},false);
validationCase("old actualFreight edited with proof",s=>{
  s.workflow.shipments[0].actualFreight={FACTORY:5000};
},s=>{
  s.workflow.shipments[0].actualFreight.FACTORY=4000;
  s.workflow.events.push({
    id:"freight-evidence-4",at:now,actor:"직원",
    action:"실제 출고 운임 입력",shipmentIds:["shipment:o1:r1"],
    before:5000,after:{origin:"FACTORY",amount:4000}
  });
},true);
validationCase("proof event cannot be reused from old history",s=>{
  s.workflow.events.push({
    id:"freight-evidence-5",at:now,actor:"직원",
    action:"실제 출고 운임 입력",shipmentIds:["shipment:o1:r1"],
    before:null,after:{origin:"FACTORY",amount:3210}
  });
},s=>{s.workflow.shipments[0].actualFreight={FACTORY:3210};},false);
function oldExport(status:string="EXPORTED"){
  return {id:"export-1",shipmentId:"shipment:o1:r1",origin:"FACTORY",
    at:now,actor:"기존 직원",status,fileOnly:true,
    snapshot:{recipient:copy(recipient),sender:copy(client),
      total:70000,vat:6000,subtotal:60000,shipping:4000}};
}
validationCase("historical exported file metadata no-op",s=>{
  s.workflow.queue=[oldExport()];
},unchanged,true);
validationCase("exported file cannot be edited without staff confirmation",s=>{
  s.workflow.queue=[oldExport()];
},s=>{
  s.workflow.queue[0].fileOnly=false;
  s.workflow.queue[0].factoryDeliveredAt=now;
},false);
validationCase("exported file staff handoff metadata allowed",s=>{
  s.workflow.queue=[oldExport()];
},s=>{
  s.workflow.queue[0].fileOnly=false;
  s.workflow.queue[0].factoryDeliveredAt=now;
  s.workflow.events.push({id:"handoff-staff",at:now,actor:"확인 직원",
    action:"공장 전달 직원 확인",shipmentIds:["shipment:o1:r1"]});
},true);
validationCase("exported file changed snapshot still blocked",s=>{
  s.workflow.queue=[oldExport()];
},s=>{
  s.workflow.queue[0].fileOnly=false;
  s.workflow.queue[0].factoryDeliveredAt=now;
  s.workflow.queue[0].snapshot.total=8999;
  s.workflow.events.push({id:"handoff-staff",at:now,actor:"확인 직원",
    action:"공장 전달 직원 확인",shipmentIds:["shipment:o1:r1"]});
},false);
validationCase("printed file pre-delivery disposal with source snapshot",s=>{
  s.workflow.queue=[oldExport()];
  s.exports=[{id:"export-session",snapshots:[
    {id:"export-1",snapshot:copy(s.workflow.queue[0].snapshot)}
  ]}];
},s=>{
  s.workflow.queue[0].status="CANCELLED";
  s.workflow.events.push({id:"dispose-old",at:now,actor:"직원",
    action:"전달 전 출력본 폐기 / 재작성",shipmentIds:["shipment:o1:r1"]});
},true);
validationCase("printed file disposal without source snapshot refused",s=>{
  s.workflow.queue=[oldExport()];
  s.exports=[];
},s=>{
  s.workflow.queue[0].status="CANCELLED";
  s.workflow.events.push({id:"dispose-old",at:now,actor:"직원",
    action:"전달 전 출력본 폐기 / 재작성",shipmentIds:["shipment:o1:r1"]});
},false);
validationCase("printed file disposal refused if actually handed to carrier",s=>{
  s.workflow.queue=[oldExport()];
  s.workflow.queue[0].factoryDeliveredAt=now;
  s.exports=[{id:"export-session",snapshots:[
    {id:"export-1",snapshot:copy(s.workflow.queue[0].snapshot)}
  ]}];
},s=>{
  s.workflow.queue[0].status="CANCELLED";
  s.workflow.events.push({id:"dispose-old",at:now,actor:"직원",
    action:"전달 전 출력본 폐기 / 재작성",shipmentIds:["shipment:o1:r1"]});
},false);
validationCase("STORE_SENT completed record cannot be un-sent",s=>{
  s.workflow.queue=[oldExport("STORE_SENT")];
},s=>{s.workflow.queue[0].status="CANCELLED";},false);
validationCase("old confirmed notice cannot be removed with group",s=>{
  s.workflow.groups[0].notices=[{id:"notice-old",at:now,amount:100}];
},s=>{s.workflow.groups=[];},false);
validationCase("multiple valid allocation entries sum exactly",unchanged,s=>{
  s.workflow.payments.push({id:"money-1",dealerId:"dealer-1",
    amount:100,allocations:[
      {shipmentId:"shipment:o1:r1",amount:30},
      {shipmentId:"shipment:o1:r1",amount:70}
    ]});
},true);
validationCase("unsafe payment total is rejected",unchanged,s=>{
  s.workflow.payments.push({id:"money-1",dealerId:"dealer-1",
    amount:9007199254740992,
    allocations:[{shipmentId:"shipment:o1:r1",amount:1}]});
},false);
validationCase("decimal payment allocation rejected",unchanged,s=>{
  s.workflow.payments.push({id:"money-1",dealerId:"dealer-1",
    amount:100,allocations:[{shipmentId:"shipment:o1:r1",amount:2.5}]});
},false);


validationCase("negative allocation with positive safe aggregate reaches link guard",unchanged,s=>{
  s.workflow.payments.push({id:"negative-pay",dealerId:"dealer-1",
    amount:100,allocations:[
      {shipmentId:"shipment:o1:r1",amount:-1},
      {shipmentId:"shipment:o1:r1",amount:2}
    ]});
},false);
validationCase("negative aggregate triggers sum error",unchanged,s=>{
  s.workflow.payments.push({id:"negative-pay",dealerId:"dealer-1",
    amount:100,allocations:[
      {shipmentId:"shipment:o1:r1",amount:-2},
      {shipmentId:"shipment:o1:r1",amount:1}
    ]});
},false);
validationCase("payment without allocation is permitted",unchanged,s=>{
  s.workflow.payments.push({id:"unallocated-pay",dealerId:"dealer-1",
    amount:100,allocations:[]});
},true);
validationCase("invalid negative payment amount wins before aggregate error",unchanged,s=>{
  s.workflow.payments.push({id:"negative-pay",dealerId:"dealer-1",
    amount:-1,allocations:[
      {shipmentId:"shipment:o1:r1",amount:2.5}
    ]});
},false);


validationCase("actualFreight explicit null requires insertion evidence",unchanged,s=>{
  s.workflow.shipments[0].actualFreight={FACTORY:null};
},false);
validationCase("actualFreight removing explicit null is forbidden",s=>{
  s.workflow.shipments[0].actualFreight={FACTORY:null};
},s=>{
  s.workflow.shipments[0].actualFreight={};
},false);
validationCase("actualFreight explicit null insertion with evidence permitted",unchanged,s=>{
  s.workflow.shipments[0].actualFreight={FACTORY:null};
  s.workflow.events.push({id:"null-freight-evidence",at:now,actor:"담당자",
    action:"실제 출고 운임 입력",shipmentIds:["shipment:o1:r1"],
    before:null,after:{origin:"FACTORY",amount:null}});
},true);
validationCase("actualFreight proof of legacy recipient fallback",s=>{
  s.orders[0].recipients[0].actualFreight=3100;
},s=>{
  s.workflow.shipments[0].actualFreight={FACTORY:3500};
  s.workflow.events.push({id:"legacy-freight-proof",at:now,actor:"담당자",
    action:"실제 출고 운임 입력",shipmentIds:["shipment:o1:r1"],
    before:3100,after:{origin:"FACTORY",amount:3500}});
},true);
validationCase("actualFreight incorrect old legacy fallback rejected",s=>{
  s.orders[0].recipients[0].actualFreight=3100;
},s=>{
  s.workflow.shipments[0].actualFreight={FACTORY:3500};
  s.workflow.events.push({id:"bad-legacy-freight-proof",at:now,actor:"담당자",
    action:"실제 출고 운임 입력",shipmentIds:["shipment:o1:r1"],
    before:null,after:{origin:"FACTORY",amount:3500}});
},false);


validationCase("shipment linked to nonexistent dealer without snapshot",unchanged,s=>{
  s.clients=[];
  delete s.orders[0].clientSnapshot;
},false);
validationCase("retail company without linked dealer is valid",unchanged,s=>{
  s.orders[0].orderType="RETAIL";
  s.orders[0].clientId="";
  s.clients=[];
  s.workflow.groups[0].dealerId="";
  s.workflow.shipments[0].transferred=true;
  s.workflow.shipments[0].step=4;
},true);
validationCase("missing dealer but frozen client snapshot remains valid",unchanged,s=>{
  s.orders[0].confirmedAt=now;
  s.orders[0].clientSnapshot=copy(s.clients[0]);
  s.clients=[];
},true);


// Actual src/orders/reception.ts::validateReceptionBoundary baseline. Tests
// must compare a newly saved reception in after-State to a genuine prior
// State, not two clones that already contain the newly confirmed order.
function newConfirmedReception(type:"AGENCY"|"DEALER"|"RETAIL"="AGENCY"){
  const state:any=copy(baseState);
  const existing:any=copy(order);
  existing.id="order-new";
  existing.receptionVersion=1;
  existing.confirmedAt=now;
  existing.clientSnapshot=copy(client);
  existing.senderSnapshot=copy(client);
  existing.receipt={original:existing.raw,at:now,
    actor:"접수 담당자",clientId:existing.clientId,legacy:false};
  existing.recipients[0].id="recipient-new";
  existing.recipients[0].items[0].id="item-new";
  existing.recipients[0].items[0].quantityConfirmed=true;
  existing.confirmationSnapshot={
    at:now,raw:existing.raw,client:copy(client),
    recipients:copy(existing.recipients),
    data:{id:existing.id,raw:existing.raw,recipients:copy(existing.recipients)}
  };
  existing.orderType=type;
  if(type==="DEALER"){
    existing.senderSnapshot=companyClient(state.settings as any);
  }else if(type==="RETAIL"){
    existing.clientId="";
    existing.raw="";
    existing.paid=true;
    existing.applyVat=false;
    existing.recipients[0].dispatchOrigin="FACTORY";
    existing.recipients[0].vatDefault=false;
    existing.recipients[0].items[0].unitPrice=null;
    existing.recipients[0].items[0].quantityConfirmed=true;
    existing.clientSnapshot=companyParty(state.settings as any);
    existing.senderSnapshot=companyClient(state.settings as any);
    existing.receipt.original="";existing.receipt.clientId="";
    existing.confirmationSnapshot.raw="";
    existing.confirmationSnapshot.client=copy(existing.clientSnapshot);
    existing.confirmationSnapshot.data.raw="";
    existing.confirmationSnapshot.recipients=copy(existing.recipients);
    existing.confirmationSnapshot.data.recipients=copy(existing.recipients);
  }
  state.orders.push(existing);
  const clonedSource:any=copy(workflow.sources[0]);
  clonedSource.id="source:order-new";
  clonedSource.orderId="order-new";
  clonedSource.raw=existing.raw;
  state.workflow.sources.push(clonedSource);
  const clonedGroup:any=copy(workflow.groups[0]);
  clonedGroup.id="group:order-new";
  clonedGroup.rootGroupId="group:order-new";
  clonedGroup.sourceId=clonedSource.id;
  clonedGroup.dealerId=existing.clientId;
  state.workflow.groups.push(clonedGroup);
  const clonedShipment:any=copy(workflow.shipments[0]);
  clonedShipment.id="shipment:order-new:recipient-new";
  clonedShipment.sourceId=clonedSource.id;
  clonedShipment.orderId="order-new";
  clonedShipment.recipientId="recipient-new";
  clonedShipment.groupId=clonedGroup.id;
  clonedShipment.step=type==="RETAIL"?4:1;
  clonedShipment.transferred=type==="RETAIL";
  state.workflow.shipments.push(clonedShipment);
  state.workflow.events.push({id:"confirm-order-new",at:now,
    actor:"접수 담당자",action:"주문 확인 완료",
    shipmentIds:[clonedShipment.id],groupId:clonedGroup.id,
    after:{orderType:type}});
  return state;
}
function receptionCase(name:string,change:(after:any,before:any)=>void,
  expectedOk:boolean,mode:"AGENCY"|"DEALER"|"RETAIL"="AGENCY",
  isNew=true){
  const before:any=copy(baseState);
  const after:any=isNew?newConfirmedReception(mode):copy(before);
  change(after,before);
  add("reception boundary: "+name,"validate_reception_boundary",{before,state:after},
    ()=>{validateReceptionBoundary(before,after);return {valid:true};});
  cases[cases.length-1].expectedOk=expectedOk;
}
function newOrder(s:any){return s.orders.find((o:any)=>o.id==="order-new");}
function newShip(s:any){return s.workflow.shipments.find((x:any)=>x.orderId==="order-new");}
function newGroup(s:any){return s.workflow.groups.find((x:any)=>x.id==="group:order-new");}
receptionCase("valid new agency confirmation",()=>{},true);
receptionCase("valid new dealer confirmation",()=>{},true,"DEALER");
receptionCase("valid new retail confirmation",()=>{},true,"RETAIL");
receptionCase("new retail without reception version",s=>{
  delete newOrder(s).receptionVersion;
},false,"RETAIL");
receptionCase("new retail wrong reception version",s=>{
  newOrder(s).receptionVersion=2;
},false,"RETAIL");
receptionCase("new v1 without confirmedAt",s=>{
  delete newOrder(s).confirmedAt;
},false);
receptionCase("new v1 without confirmationSnapshot",s=>{
  delete newOrder(s).confirmationSnapshot;
},false);
receptionCase("new order wrong type",s=>{
  newOrder(s).orderType="OTHER";
},false);
receptionCase("legacy agency new order accepted",s=>{
  newOrder(s).receptionVersion=0;
  delete newOrder(s).confirmationSnapshot;
},true);
receptionCase("agency senderSnapshot missing",s=>{
  delete newOrder(s).senderSnapshot;
},false);
receptionCase("agency senderSnapshot modified",s=>{
  newOrder(s).senderSnapshot.phone="010-3333-7777";
},false);
receptionCase("DEALER senderSnapshot set to client",s=>{
  newOrder(s).senderSnapshot=copy(client);
},false,"DEALER");
receptionCase("RETAIL senderSnapshot set to client",s=>{
  newOrder(s).senderSnapshot=copy(client);
},false,"RETAIL");
receptionCase("RETAIL clientSnapshot wrong",s=>{
  newOrder(s).clientSnapshot=copy(client);
},false,"RETAIL");
receptionCase("RETAIL has forbidden clientId",s=>{
  newOrder(s).clientId="dealer-1";
  newGroup(s).dealerId="dealer-1";
},false,"RETAIL");
receptionCase("RETAIL has nonempty raw original",s=>{
  newOrder(s).raw="별도 주문";
},false,"RETAIL");
receptionCase("RETAIL with analyzed snapshot",s=>{
  newOrder(s).analysisSnapshot={raw:"분석된 원문"};
},false,"RETAIL");
receptionCase("RETAIL with paid=false",s=>{
  newOrder(s).paid=false;
},false,"RETAIL");
receptionCase("RETAIL with explicit item price",s=>{
  const o=newOrder(s);
  o.recipients[0].items[0].unitPrice=30000;
  o.confirmationSnapshot.recipients=copy(o.recipients);
  o.confirmationSnapshot.data.recipients=copy(o.recipients);
},false,"RETAIL");
receptionCase("RETAIL dispatchOrigin missing",s=>{
  const o=newOrder(s);delete o.recipients[0].dispatchOrigin;
},false,"RETAIL");
receptionCase("RETAIL dispatchOrigin unknown",s=>{
  newOrder(s).recipients[0].dispatchOrigin="UNKNOWN";
},false,"RETAIL");
receptionCase("RETAIL actualFreight negative",s=>{
  newOrder(s).recipients[0].actualFreight=-1;
},false,"RETAIL");
receptionCase("RETAIL quantity confirmation missing",s=>{
  newOrder(s).recipients[0].items[0].quantityConfirmed=false;
},false,"RETAIL");
receptionCase("RETAIL missing company sender address",s=>{
  s.settings.senderAddress="";
  newOrder(s).senderSnapshot=companyClient(s.settings as any);
  newOrder(s).clientSnapshot=companyParty(s.settings as any);
},false,"RETAIL");
receptionCase("RETAIL sold-out item warning",s=>{
  s.products[0].saleStatus="품절";
},false,"RETAIL");
receptionCase("product removed from registration",s=>{
  newOrder(s).recipients[0].items[0].productId="missing-product";
},false);
receptionCase("product is inactive",s=>{
  s.products[0].active=false;
},false);
receptionCase("product is deleted",s=>{
  s.products[0].deletedAt=now;
},false);
receptionCase("product variant unknown",s=>{
  newOrder(s).recipients[0].items[0].variantId="missing-variant";
},false);
receptionCase("confirmationSnapshot raw mismatched",s=>{
  newOrder(s).confirmationSnapshot.raw="different raw";
},false);
receptionCase("confirmationSnapshot order ID mismatched",s=>{
  newOrder(s).confirmationSnapshot.data.id="other-order";
},false);
receptionCase("confirmationSnapshot data raw mismatched",s=>{
  newOrder(s).confirmationSnapshot.data.raw="different raw";
},false);
receptionCase("confirmationSnapshot recipients mismatched",s=>{
  newOrder(s).confirmationSnapshot.recipients[0].name="다른 수취인";
},false);
receptionCase("confirmationSnapshot data recipients mismatched",s=>{
  newOrder(s).confirmationSnapshot.data.recipients[0].name="다른 수취인";
},false);
receptionCase("confirmationSnapshot time mismatched",s=>{
  newOrder(s).confirmationSnapshot.at="2020-01-01T00:00:00Z";
},false);
receptionCase("receipt original mismatched",s=>{
  newOrder(s).receipt.original="다른 원문";
},false);
receptionCase("receipt time mismatched",s=>{
  newOrder(s).receipt.at="2020-01-01T00:00:00Z";
},false);
receptionCase("snapshot client ID mismatched",s=>{
  newOrder(s).confirmationSnapshot.client.id="not-same-client";
},false);
receptionCase("missing all active shipments",s=>{
  s.workflow.shipments=s.workflow.shipments.filter((v:any)=>v.orderId!=="order-new");
},false);
receptionCase("all shipments are legacyArchived",s=>{
  newShip(s).legacyArchived=true;
},false);
receptionCase("active shipment step zero",s=>{
  newShip(s).step=0;
},false);
receptionCase("no confirmation event",s=>{
  s.workflow.events=s.workflow.events.filter((e:any)=>e.id!=="confirm-order-new");
},false);
receptionCase("confirmation event unrelated shipment",s=>{
  s.workflow.events.find((e:any)=>e.id==="confirm-order-new").shipmentIds=["shipment:other"];
},false);
receptionCase("recipient has no matching shipment",s=>{
  const o=newOrder(s);
  const second=copy(o.recipients[0]);
  second.id="recipient-extra";second.name="추가 수취인";
  second.items[0].id="item-extra";
  o.recipients.push(second);
  o.confirmationSnapshot.recipients=copy(o.recipients);
  o.confirmationSnapshot.data.recipients=copy(o.recipients);
},false);
receptionCase("agency stage 1 is blocked by missing address",s=>{
  const o=newOrder(s);o.recipients[0].address="";
  o.confirmationSnapshot.recipients=copy(o.recipients);
  o.confirmationSnapshot.data.recipients=copy(o.recipients);
},false);
receptionCase("agency stage 1 blocked by unassigned evidence",s=>{
  const o=newOrder(s);o.recipients[0].unassignedEvidence=[{
    kind:"product",text:"이해할 수 없는 품명"
  }];
  o.confirmationSnapshot.recipients=copy(o.recipients);
  o.confirmationSnapshot.data.recipients=copy(o.recipients);
},false);
receptionCase("existing confirmed raw edited",(s,before)=>{
  before.orders[0].confirmedAt=now;
  s.orders[0].confirmedAt=now;s.orders[0].raw="변경됨";
},false,"AGENCY",false);
receptionCase("existing confirmed timestamp edited",(s,before)=>{
  before.orders[0].confirmedAt=now;
  s.orders[0].confirmedAt="2020-01-01T00:00:00Z";
},false,"AGENCY",false);
receptionCase("existing confirmed snapshot edited",(s,before)=>{
  before.orders[0].confirmedAt=now;
  before.orders[0].confirmationSnapshot={at:now};
  s.orders[0].confirmedAt=now;
  s.orders[0].confirmationSnapshot={at:"2020-01-01T00:00:00Z"};
},false,"AGENCY",false);
receptionCase("existing order type changed",s=>{
  s.orders[0].orderType="DEALER";
},false,"AGENCY",false);
receptionCase("existing senderSnapshot changed",s=>{
  s.orders[0].senderSnapshot=copy(client);
},false,"AGENCY",false);
receptionCase("existing mutable address can change",s=>{
  s.orders[0].recipients[0].address="서울특별시 가상로 99";
},true,"AGENCY",false);
receptionCase("existing order raw changed before confirmation",s=>{
  s.orders[0].raw="편집된 접수 초안";
},true,"AGENCY",false);


// Reception boundary hard corners: key presence, explicit sender parser,
// historical product selection and stage-one order confirmation blockers.
receptionCase("RETAIL omitted item unitPrice differs from null",s=>{
  const o=newOrder(s);delete o.recipients[0].items[0].unitPrice;
},false,"RETAIL");
receptionCase("existing missing senderSnapshot cannot become explicit null",s=>{
  s.orders[0].senderSnapshot=null;
},false,"AGENCY",false);
receptionCase("existing absent senderSnapshot unchanged stays valid",()=>{},true,"AGENCY",false);
receptionCase("existing senderSnapshot null may be removed only if original null",s=>{
  s.orders[0].senderSnapshot=null;
},false,"AGENCY",false);
receptionCase("new AGENCY explicit sender marker from analysisRaw",s=>{
  const o=newOrder(s);
  o.analysisRaw=[
    "원문 임의 제목",
    "송하인: 서울 총판",
    "연락처: 010-7777-8888",
    "송하인주소: 서울특별시 종로구 대학로 7"
  ].join("\n");
  o.senderSnapshot=explicitSender(o.analysisRaw,copy(client));
},true);
receptionCase("new AGENCY sender with fullwidth colon and spaces",s=>{
  const o=newOrder(s);
  o.analysisRaw=[
    "견적서",
    "  보내는 사람：별도 거래처",
    "  전화번호 010 7777 8888",
    "  보내는곳：서울특별시 종로구 대학로 7 3층"
  ].join("\n");
  o.senderSnapshot=explicitSender(o.analysisRaw,copy(client));
},true);
receptionCase("new AGENCY sender with phone parentheses and dot",s=>{
  const o=newOrder(s);
  o.analysisRaw=[
    "송하인명: 가상상사",
    "02 (312) 3456",
    "주소: 서울시 중구 가상로 15"
  ].join("\n");
  o.senderSnapshot=explicitSender(o.analysisRaw,copy(client));
},true);
receptionCase("new AGENCY senderSnapshot must follow actual client, not clientSnapshot",s=>{
  const o=newOrder(s);
  o.clientSnapshot={...copy(client),name:"확정 당시 회사명",phone:"010-9999-9999"};
},true);
receptionCase("new AGENCY senderSnapshot cannot silently use frozen client",s=>{
  const o=newOrder(s);
  o.clientSnapshot={...copy(client),name:"확정 당시 회사명"};
  o.senderSnapshot=copy(o.clientSnapshot);
},false);
receptionCase("new DEALER uses house sender fallback name",s=>{
  s.settings.senderName="";
  newOrder(s).senderSnapshot=companyClient(s.settings as any);
},true,"DEALER");
receptionCase("RETAIL company snapshot may use mobile contact",s=>{
  s.settings.senderPhone="";
  s.settings.senderMobile="010-7777-8888";
  const o=newOrder(s);
  o.clientSnapshot=companyParty(s.settings as any);
  o.senderSnapshot=companyClient(s.settings as any);
},true,"RETAIL");
receptionCase("RETAIL with blank sender phone and mobile",s=>{
  s.settings.senderPhone="";
  s.settings.senderMobile="";
  const o=newOrder(s);
  o.senderSnapshot=companyClient(s.settings as any);
  o.clientSnapshot=companyParty(s.settings as any);
},false,"RETAIL");
receptionCase("RETAIL item already superseded",s=>{
  s.products[0].supersededBy="replacement-1";
},false,"RETAIL");
receptionCase("RETAIL invalid recipient address",s=>{
  const o=newOrder(s);o.recipients[0].address="주소 미정";
},false,"RETAIL");
receptionCase("RETAIL missing recipient name",s=>{
  newOrder(s).recipients[0].name="";
},false,"RETAIL");
receptionCase("RETAIL missing recipient contact",s=>{
  const o=newOrder(s);
  o.recipients[0].phone="";o.recipients[0].mobile="";
},false,"RETAIL");
receptionCase("RETAIL no ordered items",s=>{
  newOrder(s).recipients[0].items=[];
},false,"RETAIL");
receptionCase("RETAIL buyer has product without confirmed quantity",s=>{
  newOrder(s).recipients[0].items[0].quantityConfirmed=undefined;
},false,"RETAIL");
receptionCase("RETAIL recipient actual freight zero accepted",s=>{
  newOrder(s).recipients[0].actualFreight=0;
},false,"RETAIL");
receptionCase("RETAIL item has no matching variant",s=>{
  newOrder(s).recipients[0].items[0].variantId="not-a-variant";
},false,"RETAIL");
receptionCase("AGENCY item superseded but still registered",s=>{
  s.products[0].supersededBy="replacement-1";
},false);
receptionCase("AGENCY no receivable items but no action blockers",s=>{
  const o=newOrder(s);
  o.recipients[0].items=[];
  o.confirmationSnapshot.recipients=copy(o.recipients);
  o.confirmationSnapshot.data.recipients=copy(o.recipients);
},false);
receptionCase("new V1 confirmed timestamp empty string",s=>{
  newOrder(s).confirmedAt="";
},false);
receptionCase("new V1 confirmed timestamp numeric zero",s=>{
  newOrder(s).confirmedAt=0;
},false);
receptionCase("new V1 confirmationSnapshot empty object",s=>{
  newOrder(s).confirmationSnapshot={};
},false);
receptionCase("existing confirmed receipt snapshot remains frozen with identical content",s=>{
  s.orders[0].confirmedAt=now;
  s.orders[0].confirmationSnapshot={at:now};
},true,"AGENCY",false);
receptionCase("existing senderSnapshot object mutated without type change",(s,b)=>{
  b.orders[0].senderSnapshot=copy(client);
  s.orders[0].senderSnapshot={...copy(client),phone:"010-5555-3333"};
},false,"AGENCY",false);


receptionCase("RETAIL simultaneous field failures preserve issue order",s=>{
  const o=newOrder(s);
  o.recipients[0].name="";
  o.recipients[0].address="";
  o.recipients[0].phone="";
  o.recipients[0].mobile="";
  o.recipients[0].dispatchOrigin="UNKNOWN";
  o.recipients[0].items[0].quantityConfirmed=false;
  o.recipients[0].items[0].variantId="unknown-variant";
  s.settings.senderAddress="";
  s.settings.senderPhone="";
  s.products[0].saleStatus="품절";
  o.senderSnapshot=companyClient(s.settings as any);
  o.clientSnapshot=companyParty(s.settings as any);
},false,"RETAIL");
receptionCase("new AGENCY explicit sender with empty phone fails stage one",s=>{
  const o=newOrder(s);
  o.analysisRaw=[
    "송하인: 별도 대리점",
    "송하인주소: 서울특별시 종로구 대학로 7"
  ].join("\n");
  o.senderSnapshot=explicitSender(o.analysisRaw,copy(client));
},false);
receptionCase("new AGENCY explicit sender with no address fails stage one",s=>{
  const o=newOrder(s);
  o.analysisRaw=[
    "송하인: 별도 대리점",
    "연락처: 010-7777-8888"
  ].join("\n");
  o.senderSnapshot=explicitSender(o.analysisRaw,copy(client));
},false);
receptionCase("new AGENCY product candidate conflict blocks confirmation",s=>{
  const o=newOrder(s);
  o.recipients[0].candidates=[
    {field:"name",value:"첫 수취인"},{field:"name",value:"둘째 수취인"}
  ];
  o.recipients[0].confirmedFields=[];
  o.confirmationSnapshot.recipients=copy(o.recipients);
  o.confirmationSnapshot.data.recipients=copy(o.recipients);
},false);
receptionCase("existing sender snapshot present can remain unchanged",(s,b)=>{
  b.orders[0].senderSnapshot=copy(client);
  s.orders[0].senderSnapshot=copy(client);
},true,"AGENCY",false);
receptionCase("existing order confirmed raw can retain identical content",(s,b)=>{
  b.orders[0].confirmedAt=now;
  b.orders[0].confirmationSnapshot={raw:"original",at:now};
  s.orders[0].confirmedAt=now;
  s.orders[0].confirmationSnapshot={raw:"original",at:now};
},true,"AGENCY",false);
receptionCase("new confirmation with two recipients each has active shipment",s=>{
  const o=newOrder(s);
  const row=copy(o.recipients[0]);
  row.id="recipient-two";row.name="두번째 수취인";
  row.items[0].id="item-two";
  o.recipients.push(row);
  o.confirmationSnapshot.recipients=copy(o.recipients);
  o.confirmationSnapshot.data.recipients=copy(o.recipients);
  const sh=copy(newShip(s));
  sh.id="shipment:order-new:recipient-two";
  sh.recipientId=row.id;
  s.workflow.shipments.push(sh);
  const e=s.workflow.events.find((v:any)=>v.id==="confirm-order-new");
  e.shipmentIds.push(sh.id);
},true);
receptionCase("new confirmation second recipient belongs to another group",s=>{
  const o=newOrder(s);
  const row=copy(o.recipients[0]);
  row.id="recipient-two";row.name="두번째 수취인";
  row.items[0].id="item-two";
  o.recipients.push(row);
  o.confirmationSnapshot.recipients=copy(o.recipients);
  o.confirmationSnapshot.data.recipients=copy(o.recipients);
  const gp=copy(newGroup(s));
  gp.id="group:order-new:second";
  s.workflow.groups.push(gp);
  const sh=copy(newShip(s));
  sh.id="shipment:order-new:recipient-two";
  sh.recipientId=row.id;
  sh.groupId=gp.id;
  s.workflow.shipments.push(sh);
  const e=s.workflow.events.find((v:any)=>v.id==="confirm-order-new");
  e.shipmentIds.push(sh.id);
},true);
receptionCase("new confirmation second group stage-1 failure blocks all",s=>{
  const o=newOrder(s);
  const row=copy(o.recipients[0]);
  row.id="recipient-two";row.name="두번째 수취인";
  row.items[0].id="item-two";
  row.items[0].origin="UNKNOWN";
  o.recipients.push(row);
  o.confirmationSnapshot.recipients=copy(o.recipients);
  o.confirmationSnapshot.data.recipients=copy(o.recipients);
  const gp=copy(newGroup(s));
  gp.id="group:order-new:second";
  s.workflow.groups.push(gp);
  const sh=copy(newShip(s));
  sh.id="shipment:order-new:recipient-two";
  sh.recipientId=row.id;
  sh.groupId=gp.id;
  s.workflow.shipments.push(sh);
  const e=s.workflow.events.find((v:any)=>v.id==="confirm-order-new");
  e.shipmentIds.push(sh.id);
},false);
receptionCase("new AGENCY v1 unconfirmed second recipient prevents full save",s=>{
  const o=newOrder(s);
  const row=copy(o.recipients[0]);
  row.id="recipient-two";row.name="두번째 수취인";
  o.recipients.push(row);
  o.confirmationSnapshot.recipients=copy(o.recipients);
  o.confirmationSnapshot.data.recipients=copy(o.recipients);
},false);
receptionCase("new AGENCY receipt confirmation actor omitted is still accepted",s=>{
  const o=newOrder(s);
  delete o.receipt.actor;
},true);
receptionCase("new AGENCY missing receipt object is rejected",s=>{
  delete newOrder(s).receipt;
},false);
receptionCase("existing unconfirmed v1 draft may retain raw edits",s=>{
  s.orders[0].receptionVersion=1;
  s.orders[0].raw="접수 원문 변경";
},true,"AGENCY",false);
receptionCase("existing unconfirmed v1 with no snapshot stays draft",s=>{
  s.orders[0].receptionVersion=1;
  delete s.orders[0].confirmationSnapshot;
},true,"AGENCY",false);
receptionCase("new AGENCY v1 missing order records shipment event",s=>{
  const e=s.workflow.events.find((v:any)=>v.id==="confirm-order-new");
  e.action="접수";
},false);

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
  if(c.expectedOk!==undefined && ts.ok!==c.expectedOk){
    console.error("BASELINE RESULT UNEXPECTED",c.name,
      "expected success",c.expectedOk,"actual",ts);
    process.exitCode=1;
  }
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
