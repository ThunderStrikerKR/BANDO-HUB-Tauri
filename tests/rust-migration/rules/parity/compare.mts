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
import { resolvePrice, totals, parseOrder, repriceOrder, itemFromProduct } from "../../../../src/domain.ts";
import {
  recommendShipping,
  editableShippingRule,
  combinationVersions,
  combinationCurrent,
  upgradeShipping,
  deleteShippingGroup,
  changeShippingBasis,
} from "../../../../src/shipping.ts";
import { shipmentTotals, validateWorkflow, reconcileWorkflow, clientChangeIssue, deleteOrder, workflowIssues, stageIssues, applyOrderRawEdit, migrateWorkflow, advanceGroup, undoGroup, setShipmentFreight, processGroup, confirmGroupPayment, recordPayment, restoreShipment, markStoreSent, recordChangeRequest, setGroupAccount, detachShipment, regroupShipment, completeDelivery, groupContext, groupStep } from "../../../../src/workflow.ts";
import { recordActualFreight } from "../../../../src/actual-freight.ts";
import { dispatchState } from "../../../../src/factory-replies.ts";
import { shouldRefreshUncommittedOrderPricing } from "../../../../src/orders/passive-pricing.ts";
import { deleteGroup, restoreGroup } from "../../../../src/group-trash.ts";
import { correctionStatus, correctionMessage, requestCorrection, copiedCorrection, confirmCorrection, markFactoryDelivered, markCollected, reopenUnsentExport } from "../../../../src/corrections.ts";
import { recordCopy } from "../../../../src/message-model.ts";
import { paymentSignature } from "../../../../src/automatic-message.ts";
import { orderIssues, approveMissingQuantity, pendingIssue } from "../../../../src/validation.ts";
import { validateReceptionBoundary, newReception, replaceReception, persistedReceptionState } from "../../../../src/orders/reception.ts";
import { confirmRetail, newRetailOrder } from "../../../../src/orders/retail.ts";
import { rawCorrectableIssue, rawCorrectionAllowed, correctWorkingRaw } from "../../../../src/working-raw.ts";
import { receiptOf, correctReceipt } from "../../../../src/receipt.ts";
import { billingSnapshot, applyReply } from "../../../../src/replies.ts";
import { replyNeedsReview } from "../../../../src/factory-replies.ts";
import { validateAutomaticMessageTemplates } from "../../../../src/automatic-message-templates.ts";
import { validateProvisionalProductNotices } from "../../../../src/provisional-product-notices.ts";
import { addressInfo, addressParts } from "../../../../src/parser.ts";
import { companyClient, companyParty } from "../../../../src/order-types.ts";
import { explicitSender } from "../../../../src/explicit-sender.ts";
import { applyManual, type ManualModel } from "../../../../src/orders/manual-classification.ts";
import { rememberTitle, rememberedTitleClient } from "../../../../src/title-clients.ts";

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
/** Dealer-change protection is a live, save-affecting decision in the UI.
 * Compare the original TS guard with the production Rust read-only contract.
 */
function dealerChangeCase(name:string,mutate:(state:any)=>void=()=>{},dealerId="dealer-2"){
  const state:any=copy(baseState);
  mutate(state);
  add("dealer change: "+name,"client_change_issue",{
    state,order:state.orders[0],dealerId
  },()=>({issue:clientChangeIssue(state,state.orders[0],dealerId)??null}));
  cases[cases.length-1].expectedOk=true;
}
dealerChangeCase("unchanged dealer",()=>{},"dealer-1");
dealerChangeCase("new dealer without frozen commitments");
dealerChangeCase("legacy order without workflow",s=>{delete s.workflow;});
dealerChangeCase("cancelled queue is not a transfer",s=>{
  s.workflow.queue.push({shipmentId:"shipment:o1:r1",status:"CANCELLED"});
});
dealerChangeCase("queued shipment prevents dealer change",s=>{
  s.workflow.queue.push({shipmentId:"shipment:o1:r1",status:"QUEUED"});
});
dealerChangeCase("exported queue prevents dealer change",s=>{
  s.workflow.queue.push({shipmentId:"shipment:o1:r1",status:"EXPORTED"});
});
dealerChangeCase("actual transfer prevents dealer change",s=>{
  s.workflow.shipments[0].transferred=true;
});
dealerChangeCase("fourth workflow stage prevents dealer change",s=>{
  s.workflow.shipments[0].step=4;
});
dealerChangeCase("historical delivery prevents dealer change",s=>{
  s.workflow.shipments[0].delivery={at:"2026-11-13"};
});
dealerChangeCase("payment allocation prevents dealer change",s=>{
  s.workflow.payments.push({allocations:[{shipmentId:"shipment:o1:r1",amount:3000}]});
});
dealerChangeCase("unrelated payment must not block",s=>{
  s.workflow.payments.push({allocations:[{shipmentId:"not-this-shipment",amount:3000}]});
});
dealerChangeCase("prior owner group not connected to shipment",s=>{
  s.workflow.groups[0].id="another-group";
  s.workflow.queue.push({shipmentId:"shipment:o1:r1",status:"QUEUED"});
});
dealerChangeCase("same dealer can retain paid shipment",s=>{
  s.workflow.shipments[0].step=4;
},"dealer-1");

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
// The button must remove the blocking issue without pretending that the
// customer's actual quantity was confirmed. Cancellation restores ACTION.
const provisionalOrder:any=frozenDate(()=>
  approveMissingQuantity(approvalOrder,"r1","item1","검증직원"));
const provisionalIssue=orderIssues(provisionalOrder).find(i=>i.kind==="QUANTITY_MISSING");
if(provisionalIssue?.severity!=="INFO" ||
   provisionalIssue.resolution!=="PROVISIONALLY_APPROVED" ||
   provisionalOrder.recipients[0].items[0].quantityConfirmed!==false)
  throw Error("1개 잠정 처리 후 주문 수량 확인 상태가 정확하지 않습니다.");
add("order issues after one-item provisional approval","order_issues",
  {order:provisionalOrder},()=>({issues:orderIssues(provisionalOrder)}));
const cancelledProvisional:any=copy(provisionalOrder);
delete cancelledProvisional.recipients[0].items[0].quantityApproval;
const cancelledIssue=orderIssues(cancelledProvisional).find(i=>i.kind==="QUANTITY_MISSING");
if(cancelledIssue?.severity!=="ACTION" || cancelledIssue.resolution!=="UNRESOLVED")
  throw Error("잠정 승인 취소 후 다시 수량 확인이 필요해야 합니다.");
add("order issues after provisional approval cancellation","order_issues",
  {order:cancelledProvisional},()=>({issues:orderIssues(cancelledProvisional)}));
const staleProvisional:any=copy(provisionalOrder);
staleProvisional.recipients[0].items[0].quantity=2;
add("stale 1-item approval cannot clear changed quantity issue","order_issues",
  {order:staleProvisional},()=>({issues:orderIssues(staleProvisional)}));
const unregisteredProvisional:any=copy(provisionalOrder);
unregisteredProvisional.recipients[0].items[0].productId="";
add("unregistered product cannot inherit a provisional approval","order_issues",
  {order:unregisteredProvisional},()=>({issues:orderIssues(unregisteredProvisional)}));
const fullyConfirmed:any=copy(provisionalOrder);
fullyConfirmed.recipients[0].items[0].quantityConfirmed=true;
delete fullyConfirmed.recipients[0].items[0].quantityApproval;
if(orderIssues(fullyConfirmed).some(i=>i.kind==="QUANTITY_MISSING"))
  throw Error("직원 수량 확정 후 수량 미확정 오류가 남으면 안 됩니다.");
add("quantity confirmed by employee removes provisional issue","order_issues",
  {order:fullyConfirmed},()=>({issues:orderIssues(fullyConfirmed)}));

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


// Session 2 direct workflow-action parity. The original TS reconciles
// before each mutation. Both sides receive the SAME already-reconciled
// starting State, and the injected UUIDs/time preserve audit order.
// Rust's adapter also takes IDs as explicit host parameters; the source TS
// functions retain their original implicit IDs. Do not replace original
// action functions with a second Rust-shaped expected-value implementation.
type WfState=any;
const WFG="group:o1", WFS="shipment:o1:r1", WFA="가상 담당자";
const workflowBase:WfState=deterministicIds(
  Array.from({length:100},(_,i)=>"seeded-workflow-"+i),
  ()=>reconcileWorkflow(copy(baseState) as any)
);
function twoShipped(s:WfState,separate=false){
  const row=copy(s.orders[0].recipients[0]);
  row.id="r2";row.name="두번째 수취인";row.items[0].id="item-2";
  s.orders[0].recipients.push(row);
  const sh=copy(s.workflow.shipments[0]);
  sh.id="shipment:o1:r2";sh.recipientId="r2";
  if(separate){
    const group=copy(s.workflow.groups[0]);
    group.id="group:o1:other";group.notices=[];group.needsNotice=false;
    s.workflow.groups.push(group);sh.groupId=group.id;
  }
  s.workflow.shipments.push(sh);
  // Source action functions call reconcileWorkflow on entry. Normalize
  // second-recipient signatures and frozen recipient snapshots up front:
  // otherwise this test accidentally compares reconciliation work against
  // Rust's pure action route instead of comparing the same action.
  Object.assign(s,deterministicIds(
    Array.from({length:100},(_,i)=>"fixture-group-"+i),
    ()=>reconcileWorkflow(s)
  ));
}
function wfActionCase(
  name:string,action:string,
  mutate:(s:WfState)=>void,
  params:(ids:string[],state:WfState)=>Record<string,unknown>,
  source:(s:WfState)=>unknown,
  expectOk:boolean
){
  const state=copy(workflowBase);
  mutate(state);
  const ids=Array.from({length:80},(_,i)=>"action-"+name.replace(/[^a-zA-Z0-9]/g,"-")+"-"+i);
  // The operation's public return envelope is {state, ...adapter metadata}.
  // Full State is always compared, adapter-only metadata is intentionally
  // stripped for parity. Error messages remain exact byte comparisons.
  add("workflow action: "+name,"apply_workflow_action",{
    state,action,now:actionNow,actor:WFA,eventId:ids[0],...params(ids,state)
  },()=>({state:deterministicIds(ids,()=>source(state))}));
  cases[cases.length-1].expectedOk=expectOk;
}
const actionProps=(ids:string[])=>({groupId:WFG,shipmentId:WFS,
  combinationIds:[ids[0]],deliveryIds:[ids[1]],
  paymentId:ids[0],allocationIds:[ids[1]],confirmationId:ids[0],
  newGroupId:ids[0],changeRequestId:ids[0],noticeId:ids[0]});
wfActionCase("advance stage from zero","advance_group",
  s=>{s.workflow.shipments[0].step=0;},
  ids=>({...actionProps(ids),eventId:ids[0]}),
  s=>advanceGroup(s,WFG,WFA),true);
wfActionCase("advance transferred blocked","advance_group",
  s=>{s.workflow.shipments[0].transferred=true;},
  actionProps,s=>advanceGroup(s,WFG,WFA),false);
wfActionCase("undo stage two","undo_group",s=>{s.workflow.shipments[0].step=2;},actionProps,
  s=>undoGroup(s,WFG,WFA),true);
wfActionCase("undo transferred blocked","undo_group",
  s=>{s.workflow.shipments[0].transferred=true;},
  actionProps,s=>undoGroup(s,WFG,WFA),false);
wfActionCase("change shipment freight","set_shipment_freight",()=>{},
  ids=>({...actionProps(ids),origin:"FACTORY",value:4500}),
  s=>setShipmentFreight(s,WFS,"FACTORY",4500,WFA),true);
wfActionCase("change shipment freight after transfer blocked","set_shipment_freight",
  s=>{s.workflow.shipments[0].transferred=true;},
  ids=>({...actionProps(ids),origin:"FACTORY",value:5000}),
  s=>setShipmentFreight(s,WFS,"FACTORY",5000,WFA),false);
wfActionCase("record actual freight","record_actual_freight",()=>{},
  ids=>({...actionProps(ids),origin:"FACTORY",value:3500}),
  s=>recordActualFreight(s,WFS,"FACTORY",3500),true);
wfActionCase("actual freight invalid negative","record_actual_freight",()=>{},
  ids=>({...actionProps(ids),origin:"FACTORY",value:-1}),
  s=>recordActualFreight(s,WFS,"FACTORY",-1),false);
wfActionCase("process approved group","process_group",
  s=>{s.workflow.shipments[0].step=4;
    s.workflow.shipments[0].legacyApproval=true;},
  actionProps,s=>processGroup(s,WFG,WFA),true);
wfActionCase("process incomplete group blocked","process_group",()=>{},
  actionProps,s=>processGroup(s,WFG,WFA),false);
function preparedPrepaidStageThree(s:WfState){
  s.clients[0].payment="PREPAID";
  s.workflow.shipments[0].step=0;
  const ready=deterministicIds(
    Array.from({length:100},(_,i)=>"prepaid-preparation-"+i),
    ()=>{
      let state=reconcileWorkflow(s);
      state=advanceGroup(state,WFG,WFA);
      state=advanceGroup(state,WFG,WFA);
      state=advanceGroup(state,WFG,WFA);
      return state;
    }
  );
  Object.assign(s,ready);
}
wfActionCase("prepaid confirm after account notice","confirm_group_payment",
  s=>preparedPrepaidStageThree(s),
  ids=>({...actionProps(ids),eventId:ids[1]}),
  s=>confirmGroupPayment(s,WFG,WFA),true);
wfActionCase("prepaid confirm without prior notice blocked","confirm_group_payment",
  s=>{preparedPrepaidStageThree(s);s.workflow.groups[0].notices=[];},
  actionProps,s=>confirmGroupPayment(s,WFG,WFA),false);
wfActionCase("record customer payment","record_payment",()=>{},
  ids=>({...actionProps(ids),eventId:ids[2],
    paidAmount:5000,paidAt:actionNow,memo:"가상 입금",
    allocations:[{shipmentId:WFS,amount:5000}]}),
  s=>recordPayment(s,WFG,5000,[{shipmentId:WFS,amount:5000}],actionNow,"가상 입금",WFA),true);
wfActionCase("record zero payment rejected","record_payment",()=>{},
  ids=>({...actionProps(ids),paidAmount:0,paidAt:actionNow,memo:"",
    allocations:[]}),
  s=>recordPayment(s,WFG,0,[],actionNow,"",WFA),false);
wfActionCase("restore queued shipment","restore_shipment",
  s=>{s.workflow.shipments[0].transferred=true;
    s.workflow.queue=[{id:"excel:restore:1",shipmentId:WFS,origin:"FACTORY",
      status:"QUEUED",snapshot:{}}];},
  actionProps,s=>restoreShipment(s,WFS,WFA),true);
wfActionCase("restore nontransferred blocked","restore_shipment",()=>{},
  actionProps,s=>restoreShipment(s,WFS,WFA),false);
wfActionCase("mark store sent","mark_store_sent",
  s=>{s.workflow.queue=[{id:"excel:store",shipmentId:WFS,
    origin:"STORE",status:"QUEUED",at:now,actor:WFA,snapshot:{}}];},
  ids=>({...actionProps(ids),queueId:"excel:store"}),
  s=>markStoreSent(s,"excel:store",WFA),true);
wfActionCase("mark store sent factory refused","mark_store_sent",
  s=>{s.workflow.queue=[{id:"excel:factory",shipmentId:WFS,
    origin:"FACTORY",status:"QUEUED",at:now,actor:WFA,snapshot:{}}];},
  ids=>({...actionProps(ids),queueId:"excel:factory"}),
  s=>markStoreSent(s,"excel:factory",WFA),false);
wfActionCase("append change request","record_change_request",()=>{},
  ids=>({...actionProps(ids),eventId:ids[1],text:"주소 정정 요청"}),
  s=>recordChangeRequest(s,WFS,"주소 정정 요청",WFA),true);
wfActionCase("blank change request refused","record_change_request",()=>{},
  ids=>({...actionProps(ids),text:"  "}),
  s=>recordChangeRequest(s,WFS,"  ",WFA),false);
wfActionCase("change group payment account","set_group_account",()=>{},
  ids=>({...actionProps(ids),accountId:"account-1"}),
  s=>setGroupAccount(s,WFG,"account-1",WFA),true);
wfActionCase("unknown group account blocked","set_group_account",()=>{},
  ids=>({...actionProps(ids),accountId:"account-missing"}),
  s=>setGroupAccount(s,WFG,"account-missing",WFA),false);
wfActionCase("split two-shipment group","detach_shipment",
  s=>twoShipped(s,false),
  ids=>({...actionProps(ids),eventId:ids[1]}),
  s=>detachShipment(s,WFS,WFA),true);
wfActionCase("split already independent refused","detach_shipment",()=>{},
  actionProps,s=>detachShipment(s,WFS,WFA),false);
wfActionCase("recombine matching split groups","regroup_shipment",
  s=>twoShipped(s,true),
  ids=>({...actionProps(ids),targetGroupId:"group:o1:other",ack:true}),
  s=>regroupShipment(s,WFS,"group:o1:other",true,WFA),true);
wfActionCase("recombine same group rejected","regroup_shipment",
  s=>twoShipped(s,false),
  ids=>({...actionProps(ids),targetGroupId:WFG,ack:true}),
  s=>regroupShipment(s,WFS,WFG,true,WFA),false);
wfActionCase("complete delivered shipment","complete_delivery",
  s=>{s.workflow.shipments[0].transferred=true;
    s.workflow.shipments[0].step=4;},
  ids=>({...actionProps(ids),eventId:ids[2],actual:{FACTORY:3500}}),
  s=>completeDelivery(s,WFS,{FACTORY:3500},WFA),true);
wfActionCase("complete undelivered shipment refused","complete_delivery",()=>{},
  ids=>({...actionProps(ids),actual:{FACTORY:3500}}),
  s=>completeDelivery(s,WFS,{FACTORY:3500},WFA),false);


// Additional source-driven state-transition cases. These are not simulated
// by placing an arbitrary "step:3" marker: the source advanceGroup
// transition produces valid notices/signatures/evidence for the next step.
function preparedWorkflowStage(s:WfState,stage:number,payment:"PREPAID"|"POSTPAID"="POSTPAID"){
  s.clients[0].payment=payment;
  s.workflow.shipments[0].step=0;
  const prepared=deterministicIds(
    Array.from({length:100},(_,i)=>"advance-preparation-"+payment+"-"+i),
    ()=>{
      let next=reconcileWorkflow(s);
      for(let i=0;i<stage;i++)next=advanceGroup(next,WFG,WFA);
      return next;
    }
  );
  Object.assign(s,prepared);
}
wfActionCase("advance valid stage one to two","advance_group",
  s=>preparedWorkflowStage(s,1),
  actionProps,
  s=>advanceGroup(s,WFG,WFA),true);
wfActionCase("advance valid stage two to account notice","advance_group",
  s=>preparedWorkflowStage(s,2),
  (ids,s)=>{
    const expected=deterministicIds(ids,()=>advanceGroup(s,WFG,WFA));
    return {...actionProps(ids),noticeId:ids[0],eventId:ids[1],
      reconcileEventIds:[],
      paymentMessage:expected.workflow.groups[0].notices.at(-1)?.message,
      billingSignature:expected.workflow.shipments[0].billingSignature};
  },
  s=>advanceGroup(s,WFG,WFA),true);
wfActionCase("advance valid postpaid approval","advance_group",
  s=>preparedWorkflowStage(s,3),
  actionProps,
  s=>advanceGroup(s,WFG,WFA),true);
wfActionCase("block direct prepaid approval without receipt","advance_group",
  s=>preparedWorkflowStage(s,3,"PREPAID"),
  actionProps,
  s=>advanceGroup(s,WFG,WFA),false);
wfActionCase("undo valid postpaid fourth step","undo_group",
  s=>preparedWorkflowStage(s,4),
  actionProps,
  s=>undoGroup(s,WFG,WFA),true);
wfActionCase("undo prepaid confirmed approval revokes confirmation","undo_group",
  s=>{
    preparedWorkflowStage(s,3,"PREPAID");
    const confirmed=deterministicIds(
      Array.from({length:80},(_,i)=>"prepaid-accepted-"+i),
      ()=>confirmGroupPayment(s,WFG,WFA)
    );
    Object.assign(s,confirmed);
  },
  actionProps,
  s=>undoGroup(s,WFG,WFA),true);
wfActionCase("freight edit from previously notified stage","set_shipment_freight",
  s=>preparedWorkflowStage(s,3),
  ids=>({...actionProps(ids),origin:"FACTORY",value:4500,
    eventId:ids[1],auditEventIds:[ids[0]]}),
  s=>setShipmentFreight(s,WFS,"FACTORY",4500,WFA),true);
wfActionCase("change account after completed notice","set_group_account",
  s=>preparedWorkflowStage(s,3),
  ids=>({...actionProps(ids),accountId:"account-1",
    eventId:ids[1],auditEventIds:[ids[0]]}),
  s=>setGroupAccount(s,WFG,"account-1",WFA),true);
wfActionCase("zero-change actual freight is no-op","record_actual_freight",
  s=>{s.workflow.shipments[0].actualFreight={FACTORY:3500};},
  ids=>({...actionProps(ids),origin:"FACTORY",value:3500}),
  s=>recordActualFreight(s,WFS,"FACTORY",3500),true);
wfActionCase("reject duplicate payment allocation targets","record_payment",()=>{},
  ids=>({...actionProps(ids),paidAmount:2000,paidAt:actionNow,
    allocations:[{shipmentId:WFS,amount:1000},{shipmentId:WFS,amount:1000}],
    allocationIds:[ids[1],ids[2]]}),
  s=>recordPayment(s,WFG,2000,[{shipmentId:WFS,amount:1000},{shipmentId:WFS,amount:1000}],actionNow,"",WFA),false);
wfActionCase("reject overallocated payment","record_payment",()=>{},
  ids=>({...actionProps(ids),paidAmount:1000,paidAt:actionNow,
    allocations:[{shipmentId:WFS,amount:2000}]}),
  s=>recordPayment(s,WFG,1000,[{shipmentId:WFS,amount:2000}],actionNow,"",WFA),false);
wfActionCase("reject missing payment timestamp","record_payment",()=>{},
  ids=>({...actionProps(ids),paidAmount:3000,paidAt:"",allocations:[]}),
  s=>recordPayment(s,WFG,3000,[],"","",WFA),false);
wfActionCase("restore after factory export forbidden","restore_shipment",
  s=>{s.workflow.shipments[0].transferred=true;
    s.workflow.queue=[{id:"excel:restore:export",shipmentId:WFS,origin:"FACTORY",
      status:"EXPORTED",snapshot:{}}];},
  actionProps,s=>restoreShipment(s,WFS,WFA),false);
wfActionCase("store sent after legitimate Excel export","mark_store_sent",
  s=>{s.workflow.queue=[{id:"excel:store:export",shipmentId:WFS,
    origin:"STORE",status:"EXPORTED",exportId:"store-session",snapshot:{}}];
    s.exports=[{id:"store-session",queueEntryIds:["excel:store:export"]}];},
  ids=>({...actionProps(ids),queueId:"excel:store:export"}),
  s=>markStoreSent(s,"excel:store:export",WFA),true);
wfActionCase("store sent requires export ownership","mark_store_sent",
  s=>{s.workflow.queue=[{id:"excel:store:orphan",shipmentId:WFS,
    origin:"STORE",status:"EXPORTED",exportId:"missing-session",snapshot:{}}];},
  ids=>({...actionProps(ids),queueId:"excel:store:orphan"}),
  s=>markStoreSent(s,"excel:store:orphan",WFA),false);
wfActionCase("missing change request shipment blocked","record_change_request",()=>{},
  ids=>({...actionProps(ids),shipmentId:"missing-shipment",text:"주소 정정 요청"}),
  s=>recordChangeRequest(s,"missing-shipment","주소 정정 요청",WFA),false);
wfActionCase("split-group with notice retains notice accounting","detach_shipment",
  s=>{twoShipped(s,false);
    s.workflow.groups[0].notices=[{
      id:"past-notice",at:now,actor:WFA,
      shipmentIds:[WFS],amounts:{[WFS]:70400},total:70400,
      account:copy(settings.accounts[0]),message:"기존 안내"
    }];},
  ids=>({...actionProps(ids),eventId:ids[1]}),
  s=>detachShipment(s,WFS,WFA),true);
wfActionCase("regroup requires explicit notice acknowledgment","regroup_shipment",
  s=>{twoShipped(s,true);
    s.workflow.groups[0].notices=[{id:"past-notice",at:now}];},
  ids=>({...actionProps(ids),targetGroupId:"group:o1:other",ack:false}),
  s=>regroupShipment(s,WFS,"group:o1:other",false,WFA),false);
wfActionCase("approved group with active Excel is already processed","process_group",
  s=>{s.workflow.shipments[0].step=4;
    s.workflow.shipments[0].transferred=true;
    s.workflow.queue=[{id:"excel:shipment:o1:r1:FACTORY",shipmentId:WFS,
      origin:"FACTORY",status:"QUEUED",snapshot:{}}];},
  actionProps,s=>processGroup(s,WFG,WFA),true);
wfActionCase("completed shipment cannot be delivered twice","complete_delivery",
  s=>{s.workflow.shipments[0].transferred=true;
    s.workflow.shipments[0].delivery={at:now,actor:WFA,actual:{FACTORY:3500}};},
  ids=>({...actionProps(ids),actual:{FACTORY:3500}}),
  s=>completeDelivery(s,WFS,{FACTORY:3500},WFA),true);
wfActionCase("reject delivery while factory file only","complete_delivery",
  s=>{s.workflow.shipments[0].transferred=true;
    s.workflow.queue=[{id:"excel:file-only",shipmentId:WFS,
      origin:"FACTORY",status:"EXPORTED",fileOnly:true,snapshot:{}}];},
  ids=>({...actionProps(ids),actual:{FACTORY:3500}}),
  s=>completeDelivery(s,WFS,{FACTORY:3500},WFA),false);
wfActionCase("reject delivery before factory handoff","complete_delivery",
  s=>{s.workflow.shipments[0].transferred=true;
    s.workflow.queue=[{id:"excel:queued",shipmentId:WFS,
      origin:"FACTORY",status:"QUEUED",snapshot:{}}];},
  ids=>({...actionProps(ids),actual:{FACTORY:3500}}),
  s=>completeDelivery(s,WFS,{FACTORY:3500},WFA),false);


// Entire original group-trash State, including deletedAt and append-only events.
function groupTrashCase(name:string,action:"delete_group"|"restore_group",
  edit:(state:any)=>void,expectOk:boolean,groupId="group:o1") {
  const state:any=copy(baseState);
  edit(state);
  const id="group-trash-"+name.replace(/[^a-zA-Z0-9]/g,"-");
  add("group trash: "+name,"apply_group_action",{
    action,state,groupId,now:actionNow,eventId:id
  },()=>({state:deterministicIds([id],()=>
    action==="delete_group"?deleteGroup(state,groupId):restoreGroup(state,groupId))}));
  cases[cases.length-1].expectedOk=expectOk;
}
groupTrashCase("soft-delete untransferred group","delete_group",()=>{},true);
groupTrashCase("delete missing group fails","delete_group",()=>{},false,"no-such-group");
groupTrashCase("delete already soft-deleted is unchanged","delete_group",
  s=>{s.workflow.groups[0].deletedAt=actionNow;},true);
groupTrashCase("delete after step four fails","delete_group",
  s=>{s.workflow.shipments[0].step=4;},false);
groupTrashCase("delete transferred fails","delete_group",
  s=>{s.workflow.shipments[0].transferred=true;},false);
groupTrashCase("delete delivered fails","delete_group",
  s=>{s.workflow.shipments[0].delivery={at:actionNow};},false);
groupTrashCase("delete group with linked payment fails","delete_group",
  s=>{s.workflow.payments.push({id:"paid",dealerId:"dealer-1",
    amount:500,allocations:[{shipmentId:"shipment:o1:r1",amount:500}]});},false);
groupTrashCase("delete empty group leaves zero shipment IDs","delete_group",
  s=>{s.workflow.shipments=[];},true);
groupTrashCase("restore missing group fails","restore_group",()=>{},false,"no-such-group");
groupTrashCase("restore active group no-op","restore_group",()=>{},true);
groupTrashCase("restore soft deleted group preserves notices","restore_group",
  s=>{s.workflow.groups[0].deletedAt=actionNow;
    s.workflow.groups[0].notices=[{id:"notice-old",amount:7000}];},true);
groupTrashCase("restore group with all existing shipment IDs","restore_group",
  s=>{s.workflow.groups[0].deletedAt="2026-01-01T00:00:00.000Z";
    s.workflow.shipments.push({...copy(s.workflow.shipments[0]),
      id:"shipment:o1:r2",recipientId:"r2"});},true);


// Correction action direct parity with original src/corrections.ts.
// Inject the same timestamp/UUID stream; compare immutable financial
// ledgers and every recipient, shipment, queue and audit record.
function correctionCase(name:string,action:string,setup:(s:any)=>void,
  extra:(state:any)=>Record<string,unknown>,
  source:(state:any)=>any,success:boolean) {
  const state:any=copy(baseState);
  state.orders[0].recipients[0].items[0].quantityConfirmed=true;
  setup(state);
  const ids=Array.from({length:6},(_,i)=>
    "correction-"+name.replace(/[^a-zA-Z0-9]/g,"-")+"-"+i);
  const payload={state,action,now:actionNow,ids,
    shipmentId:"shipment:o1:r1",requestId:"correction-r1",...extra(state)};
  add("correction: "+name,"apply_correction_action",payload,()=>{
    const output=deterministicIds(ids,()=>source(state));
    return action==="correction_status"?{status:output}:{state:output};
  });
  cases[cases.length-1].expectedOk=success;
}
const correctedRecipient=(s:any)=>{
  const recipient=copy(s.orders[0].recipients[0]);
  recipient.note="공장 출고 전 추가 메모";
  return recipient;
};
const confirmedCorrection=(s:any,atStatus:"REGISTERED"|"PENDING_FACTORY"|"CONFIRMED"="REGISTERED")=>{
  const old=copy(s.orders[0].recipients[0]), after=correctedRecipient(s);
  s.workflow.shipments[0].transferred=true;
  s.workflow.changeRequests.push({id:"correction-r1",
    shipmentId:"shipment:o1:r1",orderId:"o1",at:now,
    actor:"가상 담당자",text:"배송 정보 정정 요청",
    beforeRecipient:old,afterRecipient:after});
  if(atStatus!=="REGISTERED")
    s.workflow.events.push({id:"corr-status-1",at:now,actor:"가상 담당자",
      action:"정정 요청 상태",shipmentIds:["shipment:o1:r1"],
      before:"correction-r1",after:atStatus});
};
correctionCase("initial status","correction_status",()=>{},
  ()=>({requestId:"absent"}),s=>correctionStatus(s,"absent"),true);
correctionCase("status after factory pending","correction_status",
  s=>confirmedCorrection(s,"PENDING_FACTORY"),
  ()=>({}),s=>correctionStatus(s,"correction-r1"),true);
correctionCase("request valid changed note","request_correction",
  s=>{s.workflow.shipments[0].transferred=true;},
  s=>({afterRecipient:correctedRecipient(s)}),
  s=>requestCorrection(s,"shipment:o1:r1",correctedRecipient(s)),true);
correctionCase("request identical recipient","request_correction",
  s=>{s.workflow.shipments[0].transferred=true;},
  s=>({afterRecipient:copy(s.orders[0].recipients[0])}),
  s=>requestCorrection(s,"shipment:o1:r1",copy(s.orders[0].recipients[0])),false);
correctionCase("request before transfer","request_correction",
  ()=>{},s=>({afterRecipient:correctedRecipient(s)}),
  s=>requestCorrection(s,"shipment:o1:r1",correctedRecipient(s)),false);
correctionCase("request after delivery","request_correction",
  s=>{s.workflow.shipments[0].transferred=true;
    s.workflow.shipments[0].delivery={at:now};},
  s=>({afterRecipient:correctedRecipient(s)}),
  s=>requestCorrection(s,"shipment:o1:r1",correctedRecipient(s)),false);
correctionCase("request after collection","request_correction",
  s=>{s.workflow.shipments[0].transferred=true;
    s.workflow.shipments[0].collectedAt=now;},
  s=>({afterRecipient:correctedRecipient(s)}),
  s=>requestCorrection(s,"shipment:o1:r1",correctedRecipient(s)),false);
correctionCase("request recipient ID changed","request_correction",
  s=>{s.workflow.shipments[0].transferred=true;},
  s=>{const row=correctedRecipient(s);row.id="another-id";return {afterRecipient:row};},
  s=>{const row=correctedRecipient(s);row.id="another-id";
    return requestCorrection(s,"shipment:o1:r1",row);},false);
correctionCase("request shipping origin changed","request_correction",
  s=>{s.workflow.shipments[0].transferred=true;},
  s=>{const row=correctedRecipient(s);row.items[0].origin="STORE";
    return {afterRecipient:row};},
  s=>{const row=correctedRecipient(s);row.items[0].origin="STORE";
    return requestCorrection(s,"shipment:o1:r1",row);},false);
correctionCase("request shipping charge invalid","request_correction",
  s=>{s.workflow.shipments[0].transferred=true;},
  s=>{const row=correctedRecipient(s);row.shippingCharges={FACTORY:-2};
    return {afterRecipient:row};},
  s=>{const row=correctedRecipient(s);row.shippingCharges={FACTORY:-2};
    return requestCorrection(s,"shipment:o1:r1",row);},false);
correctionCase("request missing recipient name","request_correction",
  s=>{s.workflow.shipments[0].transferred=true;},
  s=>{const row=correctedRecipient(s);row.name="";
    return {afterRecipient:row};},
  s=>{const row=correctedRecipient(s);row.name="";
    return requestCorrection(s,"shipment:o1:r1",row);},false);
correctionCase("identical pending request no-op","request_correction",
  s=>confirmedCorrection(s,"PENDING_FACTORY"),
  s=>({afterRecipient:correctedRecipient(s)}),
  s=>requestCorrection(s,"shipment:o1:r1",correctedRecipient(s)),true);
correctionCase("copy registered correction","copied_correction",
  s=>confirmedCorrection(s),
  ()=>({}),s=>copiedCorrection(s,"correction-r1"),true);
correctionCase("copy already pending correction no-op","copied_correction",
  s=>confirmedCorrection(s,"PENDING_FACTORY"),
  ()=>({}),s=>copiedCorrection(s,"correction-r1"),true);
correctionCase("copy absent correction rejected","copied_correction",
  ()=>{},()=>({}),s=>copiedCorrection(s,"correction-r1"),false);
correctionCase("confirm copied factory correction","confirm_correction",
  s=>confirmedCorrection(s,"PENDING_FACTORY"),
  ()=>({}),s=>confirmCorrection(s,"correction-r1"),true);
correctionCase("confirm before message copied blocked","confirm_correction",
  s=>confirmedCorrection(s),()=>({}),
  s=>confirmCorrection(s,"correction-r1"),false);
correctionCase("confirm already confirmed no-op","confirm_correction",
  s=>confirmedCorrection(s,"CONFIRMED"),()=>({}),
  s=>confirmCorrection(s,"correction-r1"),true);
correctionCase("confirm after collection blocked","confirm_correction",
  s=>{confirmedCorrection(s,"PENDING_FACTORY");
    s.workflow.shipments[0].collectedAt=now;},
  ()=>({}),s=>confirmCorrection(s,"correction-r1"),false);
correctionCase("confirm when recipient changed meanwhile blocked","confirm_correction",
  s=>{confirmedCorrection(s,"PENDING_FACTORY");
    s.orders[0].recipients[0].address="서울시 다른 주소길 22";},
  ()=>({}),s=>confirmCorrection(s,"correction-r1"),false);
const factoryExport=(s:any)=>{
  s.workflow.shipments[0].transferred=true;
  s.workflow.queue.push({id:"factory-export",shipmentId:"shipment:o1:r1",
    origin:"FACTORY",status:"EXPORTED",fileOnly:true,at:now,
    snapshot:{recipient:copy(s.orders[0].recipients[0]),total:50000}});
};
correctionCase("mark factory delivered","mark_factory_delivered",
  s=>factoryExport(s),()=>({}),
  s=>markFactoryDelivered(s,"shipment:o1:r1"),true);
correctionCase("mark factory delivered idempotent","mark_factory_delivered",
  s=>{factoryExport(s);
    s.workflow.queue[0].fileOnly=false;
    s.workflow.queue[0].factoryDeliveredAt=now;
    s.workflow.events.push({id:"old-factory-confirm",at:now,actor:"직원",
      action:"공장 전달 직원 확인",shipmentIds:["shipment:o1:r1"]});},
  ()=>({}),s=>markFactoryDelivered(s,"shipment:o1:r1"),true);
correctionCase("mark factory delivered without export","mark_factory_delivered",
  ()=>{},()=>({}),s=>markFactoryDelivered(s,"shipment:o1:r1"),false);
correctionCase("mark collection","mark_collected",
  s=>{s.workflow.shipments[0].transferred=true;},()=>({}),
  s=>markCollected(s,"shipment:o1:r1"),true);
correctionCase("mark already collected no-op","mark_collected",
  s=>{s.workflow.shipments[0].transferred=true;
    s.workflow.shipments[0].collectedAt="2026-01-02T00:00:00.000Z";},
  ()=>({}),s=>markCollected(s,"shipment:o1:r1"),true);
correctionCase("mark collection without transfer blocked","mark_collected",
  ()=>{},()=>({}),s=>markCollected(s,"shipment:o1:r1"),false);
correctionCase("reopen unsent factory export","reopen_unsent_export",
  s=>{factoryExport(s);s.exports=[{id:"export-snapshot",snapshots:[
    {id:"factory-export",snapshot:copy(s.workflow.queue[0].snapshot)}]}];},
  ()=>({}),s=>reopenUnsentExport(s,"shipment:o1:r1"),true);
correctionCase("reopen requires intact file snapshot","reopen_unsent_export",
  s=>factoryExport(s),()=>({}),
  s=>reopenUnsentExport(s,"shipment:o1:r1"),false);
correctionCase("reopen after employee handoff blocked","reopen_unsent_export",
  s=>{factoryExport(s);s.workflow.queue[0].factoryDeliveredAt=now;},
  ()=>({}),s=>reopenUnsentExport(s,"shipment:o1:r1"),false);
correctionCase("reopen when store excel already exported blocked","reopen_unsent_export",
  s=>{factoryExport(s);s.workflow.queue.push({id:"store-export",
    shipmentId:"shipment:o1:r1",origin:"STORE",status:"EXPORTED",snapshot:{}});},
  ()=>({}),s=>reopenUnsentExport(s,"shipment:o1:r1"),false);
correctionCase("reopen after delivery blocked","reopen_unsent_export",
  s=>{factoryExport(s);s.workflow.shipments[0].delivery={at:now};},
  ()=>({}),s=>reopenUnsentExport(s,"shipment:o1:r1"),false);


// Source reception preview handling must never silently persist a newly
// created unconfirmed order as a side effect of editing settings/catalog.
function receptionOperation(name:string,action:string,input:Record<string,unknown>,
  baseline:()=>unknown,success=true) {
  add("reception operation: "+name,"apply_reception_action",{action,...input},baseline);
  cases[cases.length-1].expectedOk=success;
}
receptionOperation("new AGENCY draft","new_reception",{
  id:"draft-r-1",now:actionNow,clientId:"dealer-1",orderType:"AGENCY"
},()=>({order:deterministicIds(["draft-r-1"],()=>
  newReception("dealer-1","AGENCY"))}));
receptionOperation("new RETAIL draft","new_reception",{
  id:"draft-r-2",now:actionNow,clientId:"",orderType:"RETAIL"
},()=>({order:deterministicIds(["draft-r-2"],()=>newReception("","RETAIL"))}));
receptionOperation("replace unconfirmed draft retains identity","replace_reception",{
  order:{...copy(order),receptionVersion:1},raw:"새 발주 원문",now:actionNow
},()=>({order:deterministicIds(["replacement-internal"],()=>replaceReception(
  {...copy(order),receptionVersion:1} as any,"새 발주 원문"))}));
receptionOperation("replace blank text drops dealer link","replace_reception",{
  order:{...copy(order),receptionVersion:1,clientSnapshot:copy(client)},raw:"   ",now:actionNow
},()=>({order:deterministicIds(["replacement-internal"],()=>replaceReception(
  {...copy(order),receptionVersion:1,clientSnapshot:copy(client)} as any,"   "))}));
receptionOperation("replace confirmed raw blocked","replace_reception",{
  order:{...copy(order),confirmedAt:now},raw:"교체할 수 없음",now:actionNow
},()=>({order:replaceReception({...copy(order),confirmedAt:now} as any,
  "교체할 수 없음")}),false);
receptionOperation("replace very long raw blocked","replace_reception",{
  order:copy(order),raw:"가".repeat(100001),now:actionNow
},()=>({order:replaceReception(copy(order) as any,"가".repeat(100001))}),false);
function draftFixture(mode:"normal"|"payment"|"excel"|"confirmation"|"old"|"confirmed"|"two"){
  const before:any=copy(baseState);
  const proposed:any=copy(before);
  if(mode==="old"){
    before.orders.push({...copy(order),id:"draft-1",receptionVersion:1});
  }
  const draft:any={...copy(order),id:"draft-1",receptionVersion:1,
    clientId:"dealer-1",status:"RECEIVED"};
  if(mode==="confirmed")draft.confirmedAt=actionNow;
  proposed.orders.push(draft);
  proposed.queue.push("draft-1");
  const src:any=copy(workflow.sources[0]);
  src.id="source:draft-1";src.orderId="draft-1";
  proposed.workflow.sources.push(src);
  const group:any=copy(workflow.groups[0]);
  group.id="group:draft-1";group.sourceId=src.id;
  proposed.workflow.groups.push(group);
  const ship:any=copy(workflow.shipments[0]);
  ship.id="shipment:draft-1:r1";ship.orderId="draft-1";
  ship.sourceId=src.id;ship.groupId=group.id;
  proposed.workflow.shipments.push(ship);
  proposed.workflow.events.push({id:"draft-event",action:"주문 확인 완료",
    groupId:group.id,shipmentIds:[ship.id]});
  if(mode==="two"){
    const another={...copy(draft),id:"draft-2"};
    proposed.orders.push(another);proposed.queue.push("draft-2");
  }
  if(mode==="excel")
    proposed.workflow.queue.push({id:"queued-draft",shipmentId:ship.id,
      origin:"FACTORY",status:"QUEUED",snapshot:{}});
  if(mode==="payment")
    proposed.workflow.payments.push({id:"paid-draft",amount:1000,
      allocations:[{shipmentId:ship.id,amount:1000}]});
  if(mode==="confirmation")
    proposed.workflow.confirmations.push({id:"confirm-draft",
      shipmentIds:[ship.id],allocations:[]});
  return {before,state:proposed};
}
for(const mode of ["normal","payment","excel","confirmation","old","confirmed","two"] as const){
  const input=draftFixture(mode);
  receptionOperation("filter preview "+mode,"persisted_reception_state",input,
    ()=>({state:persistedReceptionState(input.before as any,input.state as any)}),
    !["payment","excel","confirmation"].includes(mode));
}
const noDraft=copy(baseState);
receptionOperation("no draft is unchanged","persisted_reception_state",{
  before:noDraft,state:copy(noDraft)
},()=>({state:persistedReceptionState(noDraft as any,copy(noDraft) as any)}));


// Source retail order confirmation is an atomic composed workflow operation.
// For successful fixtures capture UUID *order* from the actual TS source:
// reconcile events -> confirmation event -> processGroup reconciliation/event.
const retailNewIds=["retail-new-order","retail-new-recipient"];
add("retail: initial two-UUID draft","apply_retail_action",{
  action:"new_retail_order",orderId:retailNewIds[0],
  recipientId:retailNewIds[1],now:actionNow
},()=>({order:deterministicIds(retailNewIds,()=>newRetailOrder())}));
cases[cases.length-1].expectedOk=true;
function retailDraft(){
  const draft:any=copy(order);
  draft.id="retail-order";
  draft.orderType="RETAIL";
  draft.clientId="";
  draft.raw="";
  draft.status="RECEIVED";
  draft.receptionVersion=1;
  draft.recipients[0].id="retail-recipient";
  draft.recipients[0].dispatchOrigin="FACTORY";
  draft.recipients[0].items[0].id="retail-item";
  draft.recipients[0].items[0].quantityConfirmed=true;
  delete draft.confirmedAt;
  delete draft.clientSnapshot;
  delete draft.senderSnapshot;
  return draft;
}
function retailCase(name:string,mutate:(state:any,draft:any)=>void,success:boolean){
  const state:any=copy(baseState);
  const draft:any=retailDraft();
  mutate(state,draft);
  const ids=Array.from({length:160},(_,i)=>
    "retail-confirm-"+name.replace(/[^a-zA-Z0-9]/g,"-")+"-"+i);
  let receiptEventId=ids[0],processEventId=ids[1];
  let reconcileEventIds:string[]=[],processReconcileEventIds:string[]=[];
  if(success){
    const observed:any=deterministicIds(ids,()=>confirmRetail(state,draft));
    const receipt=observed.workflow.events.find((e:any)=>e.action==="주문 확인 완료"&&
      e.shipmentIds?.some((sid:string)=>sid.includes(draft.id)));
    const transferred=observed.workflow.events.find((e:any)=>
      e.action==="처리완료 / 엑셀 관리 목록 이관"&&
      e.shipmentIds?.some((sid:string)=>sid.includes(draft.id)));
    if(!receipt||!transferred)throw Error("Test fixture expected successful retail receipt and transfer");
    const one=ids.indexOf(receipt.id),two=ids.indexOf(transferred.id);
    if(one<0||two<=one)throw Error("Unexpected original TS UUID chronology");
    receiptEventId=receipt.id;processEventId=transferred.id;
    reconcileEventIds=ids.slice(0,one);
    processReconcileEventIds=ids.slice(one+1,two);
  }
  add("retail: "+name,"apply_retail_action",{
    action:"confirm_retail",state,draft,now:actionNow,
    receiptEventId,processEventId,reconcileEventIds,processReconcileEventIds
  },()=>({state:deterministicIds(ids,()=>confirmRetail(state,draft))}));
  cases[cases.length-1].expectedOk=success;
}
retailCase("valid factory paid externally",()=>{},true);
retailCase("valid store paid externally",(s,d)=>{
  d.recipients[0].dispatchOrigin="STORE";
  d.recipients[0].items[0].origin="STORE";
},true);
retailCase("already confirmed draft blocked",(_s,d)=>{
  d.confirmedAt=now;
},false);
retailCase("unregistered order type blocked",(_s,d)=>{
  d.orderType="AGENCY";
},false);
retailCase("same order ID already persisted blocked",(s,d)=>{
  d.id="o1";
},false);
retailCase("blank recipient name blocked",(_s,d)=>{
  d.recipients[0].name="";
},false);
retailCase("invalid quantity confirmation blocked",(_s,d)=>{
  d.recipients[0].items[0].quantityConfirmed=false;
},false);
retailCase("missing sending address blocked",(s,d)=>{
  s.settings.senderAddress="";
},false);
retailCase("deleted product blocked",(s,d)=>{
  s.products[0].deletedAt=now;
},false);


// State-changing clipboard audit is native, while its text signature still
// comes from the exact original payment generator until message parity is full.
const copiedState:any=copy(baseState);
copiedState.aliases=[];
for(const copyType of ["REQUEST","PAYMENT"] as const) {
  const token="synthetic-copy-"+copyType;
  const payload:any={
    state:copiedState,groupId:"group:o1",copyType,token,
    now:actionNow,eventId:"synthetic-event-"+copyType
  };
  if(copyType==="PAYMENT")payload.signature=paymentSignature(copiedState,"group:o1");
  add("message copy audit: "+copyType,"record_message_copy",payload,
    ()=>({state:deterministicIds([payload.eventId],
      ()=>recordCopy(copiedState,"group:o1",copyType,token))}));
}
const duplicateCopyState:any=copy(copiedState);
duplicateCopyState.workflow.events.push({
  id:"existing-copy",at:now,actor:"직원",groupId:"group:o1",
  shipmentIds:[],action:"메시지 복사",
  after:{type:"REQUEST",token:"already-recorded"}
});
add("message copy audit: duplicate token no-op","record_message_copy",{
  state:duplicateCopyState,groupId:"group:o1",copyType:"REQUEST",
  token:"already-recorded",now:actionNow,eventId:"unused"
},()=>({state:recordCopy(duplicateCopyState,"group:o1","REQUEST","already-recorded")}));
const unavailableCopy:any=copy(copiedState);
unavailableCopy.workflow.groups[0].deletedAt=actionNow;
add("message copy audit: deleted group has no shipment IDs","record_message_copy",{
  state:unavailableCopy,groupId:"group:o1",copyType:"REQUEST",token:"copy-deleted",
  now:actionNow,eventId:"synthetic-deleted"
},()=>({state:deterministicIds(["synthetic-deleted"],
  ()=>recordCopy(unavailableCopy,"group:o1","REQUEST","copy-deleted"))}));

// Original correction eligibility and receipt fallback tests are fully
// independent of recognition. Mutations use genuine TS parseOrder output
// from the identical input state, never a synthesized Rust product mapping.
for(const kind of ["NAME","ADDRESS","CONTACT","CONTACT_INVALID","MODEL",
 "QUANTITY_MISSING","QUANTITY_INVALID","ITEM","UNASSIGNED_EVIDENCE",
 "SALE_STATUS","PRICE","FREIGHT","UNKNOWN"]){
  add("raw eligibility: "+kind,"apply_raw_correction",{
    action:"raw_correctable_issue",kind
  },()=>({correctable:rawCorrectableIssue(kind)}));
}
const existingReceipt:any=copy(order);
existingReceipt.receipt={original:"원문 증거",at:now,actor:"접수자",clientId:"dealer-1",legacy:false};
add("receipt: existing original","apply_raw_correction",{
  action:"receipt_of",order:existingReceipt
},()=>({receipt:receiptOf(existingReceipt)}));
const historicReceipt:any=copy(order);
historicReceipt.rawHistory=[{at:now,raw:"최초 입력 원문",actor:"이전 담당"}];
add("receipt: fallback to first rawHistory","apply_raw_correction",{
  action:"receipt_of",order:historicReceipt
},()=>({receipt:receiptOf(historicReceipt)}));
add("receipt: fallback when no history","apply_raw_correction",{
  action:"receipt_of",order
},()=>({receipt:receiptOf(order as any)}));
function eligibleRawState(){
  const state:any=copy(baseState);
  state.aliases=[];
  state.products[0].defaultColor="Black";
  state.products[0].createdAt=now;
  state.orders[0].recipients[0].name="";
  state.workflow.shipments[0].step=0;
  state.workflow.shipments[0].completedAt={};
  state.workflow.shipments[0].transferred=false;
  return state;
}
function rawAllowedCase(name:string,change:(s:any)=>void,expected:boolean){
  const state=eligibleRawState();change(state);
  add("raw allowed: "+name,"apply_raw_correction",{
    action:"raw_correction_allowed",state,order:state.orders[0]
  },()=>({allowed:rawCorrectionAllowed(state,state.orders[0])}));
  cases[cases.length-1].expectedOk=true;
}
rawAllowedCase("name issue at stage zero",()=>{},true);
rawAllowedCase("stage two locked",s=>{s.workflow.shipments[0].step=2;},false);
rawAllowedCase("already transferred",s=>{s.workflow.shipments[0].transferred=true;},false);
rawAllowedCase("paid order",s=>{s.orders[0].paid=true;},false);
rawAllowedCase("notified order",s=>{s.orders[0].notified=true;},false);
rawAllowedCase("postpaid approved",s=>{s.orders[0].postpaidApproved=true;},false);
rawAllowedCase("retail order",s=>{s.orders[0].orderType="RETAIL";},false);
rawAllowedCase("no recognized correction issue",s=>{s.orders[0].recipients[0].name="가상 수취인";},false);
rawAllowedCase("already linked payment",s=>{s.workflow.payments.push({
  id:"payment-linked",amount:1000,
  allocations:[{shipmentId:"shipment:o1:r1",amount:1000}]
});},false);
rawAllowedCase("existing payment confirmation",s=>{s.workflow.confirmations.push({
  id:"confirmation-linked",shipmentIds:["shipment:o1:r1"],allocations:[]
});},false);
rawAllowedCase("existing delivery",s=>{s.workflow.shipments[0].delivery={at:now};},false);
rawAllowedCase("unknown order not eligible",s=>{s.orders[0].id="other-id";},true);
function correctionWrapperCase(name:string,action:"correct_working_raw"|"correct_receipt",
 change:(s:any)=>void,text:string,reason:string,expectOk:boolean){
  const state=eligibleRawState();
  change(state);
  const o:any=state.orders[0];
  const ids=Array.from({length:120},(_,i)=>
    "audit-"+name.replace(/[^a-zA-Z0-9]/g,"-")+"-"+i);
  let eventIds:string[]=[],reconcileEventIds:string[]=[],
    parsedRecipients:any[]=[],correctionId=ids[0];
  if(expectOk){
    const beforeReconcile=action==="correct_receipt"?
      withIdCapture(ids,()=>reconcileWorkflow(state,o)):
      {result:copy(state),used:0};
    const base:any=beforeReconcile.result;
    const effectiveOrder=base.orders.find((x:any)=>x.id===o.id)??o;
    const party=base.clients.find((c:any)=>c.id===o.clientId)
      ??effectiveOrder.clientSnapshot ??client;
    const parsed=withIdCapture(ids.slice(beforeReconcile.used),()=>
      parseOrder(text,party,base));
    parsedRecipients=parsed.result as any[];
    const result=withIdCapture(ids,()=>action==="correct_receipt"?
      correctReceipt(state,o,text,reason,"가상 담당자"):
      correctWorkingRaw(state,o,text,reason));
    const target:any=(result.result as any).orders.find((x:any)=>x.id===o.id);
    correctionId=target.rawCorrections.at(-1).id;
    const consumed=ids.indexOf(correctionId);
    if(consumed<0)throw Error("Failed to identify source correction ID");
    reconcileEventIds=ids.slice(0,beforeReconcile.used);
    eventIds=ids.slice(beforeReconcile.used+parsed.used,consumed);
  }
  add("raw correction: "+name,"apply_raw_correction",{
    action,state,order:o,text,reason,actor:"가상 담당자",
    now:actionNow,parsedRecipients,eventIds,reconcileEventIds,correctionId
  },()=>({state:deterministicIds(ids,()=>action==="correct_receipt"?
    correctReceipt(state,o,text,reason,"가상 담당자"):
    correctWorkingRaw(state,o,text,reason))}));
  cases[cases.length-1].expectedOk=expectOk;
}
correctionWrapperCase("working correction missing source issue","correct_working_raw",
 s=>{s.orders[0].recipients[0].name="가상 수취인";},
 "가상 수취인\n서울시 가상로 1\n010-1234-5678\n가상 상품 2개","입력오류",false);
correctionWrapperCase("working correction without reason","correct_working_raw",
 ()=>{},"가상 수취인\n서울시 가상로 1\n010-1234-5678\n가상 상품 2개","",false);
correctionWrapperCase("working correction unchanged","correct_working_raw",
 ()=>{},"가상 발주서","입력 오류",false);
correctionWrapperCase("receipt correction missing reason","correct_receipt",
 ()=>{},"수취인 가상 수취인 1개","",false);
correctionWrapperCase("working correction valid preserved receipt","correct_working_raw",
 s=>{s.orders[0].receipt={original:s.orders[0].raw,at:now,
    actor:"최초 접수자",clientId:"dealer-1",legacy:false};},
 "가상 수취인\n서울시 가상로 1\n010-1234-5678\n가상 상품 2개",
 "문자 인식 오류",true);
correctionWrapperCase("receipt correction valid audit","correct_receipt",
 ()=>{},"가상 수취인\n서울시 가상로 1\n010-1234-5678\n가상 상품 2개",
 "붙여넣기 오류",true);


// Reply proposal extraction is owned by recognition; applyReply's state
// transition is entirely business-rule driven and compared here using
// identical structured proposals and original address parser outputs.
function replyPreview(itemChange=false,recipientChange=false){
  const before=copy(recipient);
  const after=copy(before);
  after.note="사전 확인한 배송 메모";
  return {
    raw:"가상 고객 회신",warnings:[],requiresReapproval:false,
    changes:itemChange?[{
      recipientId:"r1",itemId:"item1",before:copy(item),
      after:{...copy(item),quantity:3,quantityConfirmed:true}
    }]:[],
    recipientChanges:recipientChange?[{
      recipientId:"r1",
      before:{name:before.name,address:before.address,phone:before.phone,
        mobile:before.mobile,note:before.note},
      after:{name:after.name,address:after.address,phone:after.phone,
        mobile:after.mobile,note:after.note}
    }]:[]
  };
}
function replyCase(name:string,change:(state:any,o:any,preview:any)=>void,success:boolean,
  itemChanged=true,recipientChanged=false,acknowledged=false){
  const state:any=copy(baseState);
  const o:any=copy(order);
  const preview:any=replyPreview(itemChanged,recipientChanged);
  change(state,o,preview);
  const id="reply-"+name.replace(/[^a-zA-Z0-9]/g,"-");
  const addresses:any={};
  for(const change of preview.recipientChanges??[]){
    if(change.before.address!==change.after.address){
      const info=addressInfo(change.after.address);
      addresses[change.recipientId]={kind:info.kind,
        complete:info.complete,parts:addressParts(change.after.address)};
    }
  }
  add("reply: "+name,"apply_reply_action",{
    action:"apply_reply",state,order:o,preview,acknowledged,
    now:actionNow,replyId:id,addresses
  },()=>({order:deterministicIds([id],()=>
    applyReply(o,preview,state,acknowledged))}));
  cases[cases.length-1].expectedOk=success;
}
const billingState:any=copy(baseState);
add("reply: standalone current billing snapshot","apply_reply_action",{
  action:"billing_snapshot",state:billingState,order:order,
  reason:"가상 회신 이전",now:actionNow
},()=>({snapshot:frozenDate(()=>billingSnapshot(order as any,billingState as any,
  "가상 회신 이전"))}));
cases[cases.length-1].expectedOk=true;
add("reply: billing without linked client rejected","apply_reply_action",{
  action:"billing_snapshot",state:{...copy(baseState),clients:[]},
  order:order,reason:"가상 회신 이전",now:actionNow
},()=>({snapshot:billingSnapshot(order as any,
  {...copy(baseState),clients:[]} as any,"가상 회신 이전")}));
cases[cases.length-1].expectedOk=false;
replyCase("apply one item quantity adjustment",()=>{},true);
replyCase("apply recipient note adjustment",()=>{},true,false,true);
replyCase("apply item and recipient note together",()=>{},true,true,true);
replyCase("warning list prevents application",(_s,_o,p)=>{
  p.warnings=["수량은 다시 확인하세요."];
},false);
replyCase("empty preview cannot be applied",(_s,_o,p)=>{
  p.changes=[];p.recipientChanges=[];
},false);
replyCase("exported order is protected",(_s,o)=>{o.status="EXPORTED";},false);
replyCase("reapproval required but not acknowledged",(_s,_o,p)=>{
  p.requiresReapproval=true;
},false);
replyCase("acknowledged reapproval clears historical flags",(_s,o,p)=>{
  p.requiresReapproval=true;
  o.paid=true;o.notified=true;o.postpaidApproved=true;o.pricesLocked=true;
},true,true,true,true);
replyCase("stale item selection rejected",(_s,o)=>{
  o.recipients[0].items[0].quantity=10;
},false);
replyCase("stale recipient selection rejected",(_s,o)=>{
  o.recipients[0].note="이미 직원이 수정한 내역";
},false,false,true);
replyCase("confirmed recipient name changed",(_s,_o,p)=>{
  p.changes=[];p.recipientChanges=[{
    recipientId:"r1",
    before:{name:recipient.name,address:recipient.address,phone:recipient.phone,
      mobile:recipient.mobile,note:recipient.note},
    after:{name:"김가상",address:recipient.address,phone:recipient.phone,
      mobile:recipient.mobile,note:recipient.note}
  }];
},true,false,true);
replyCase("recipient address change uses original parser",(_s,_o,p)=>{
  p.changes=[];p.recipientChanges=[{
    recipientId:"r1",
    before:{name:recipient.name,address:recipient.address,phone:recipient.phone,
      mobile:recipient.mobile,note:recipient.note},
    after:{name:recipient.name,address:"서울특별시 가상로 23",phone:recipient.phone,
      mobile:recipient.mobile,note:recipient.note}
  }];
},true,false,true);


// Final remaining standalone Rust rule boundaries. These test the original
// exported TS functions rather than asserting a Rust-only expected state.
function priceRefreshCase(name:string,mutate:(o:any,s:any)=>void,
  explicitEdit=false,persisted=false){
  const o:any=copy(order),s:any=copy(baseState);
  mutate(o,s);
  const persistedOrders:any[]=persisted?[{id:o.id}]:[];
  add("passive price: "+name,"should_refresh_pricing",{
    order:o,persistedOrders
  },()=>({refresh:shouldRefreshUncommittedOrderPricing(o,persistedOrders)}));
  add("reprice order: "+name,"reprice_order",{
    order:o,client:s.clients[0],state:s,explicitEdit,persistedOrders
  },()=>{
    const allowed=!o.confirmedAt&&!o.pricesLocked&&
      (explicitEdit||shouldRefreshUncommittedOrderPricing(o,persistedOrders));
    return {order:allowed?repriceOrder(o,s.clients[0],s):o,refreshed:allowed};
  });
}
priceRefreshCase("uncommitted unsaved price refresh",(o)=>{
  o.recipients[0].items[0].unitPrice=1;
});
priceRefreshCase("persisted unconfirmed order must not passively refresh",(o)=>{
  o.recipients[0].items[0].unitPrice=1;
},false,true);
priceRefreshCase("explicit staff edit of persisted order",(o)=>{
  o.recipients[0].items[0].unitPrice=1;
},true,true);
priceRefreshCase("confirmed historical order never refreshes",(o)=>{
  o.recipients[0].items[0].unitPrice=1;
  o.confirmedAt=now;
},true,true);
priceRefreshCase("locked historical price never refreshes",(o)=>{
  o.pricesLocked=true;o.recipients[0].items[0].unitPrice=1;
},true,true);
priceRefreshCase("deleted order cannot passively refresh",(o)=>{
  o.deletedAt=now;
},false,false);
priceRefreshCase("unknown registered product retains previous value",(o)=>{
  o.recipients[0].items[0].productId="missing-product";
  o.recipients[0].items[0].unitPrice=12345;
});
priceRefreshCase("required model proposal refreshes variant URL",(o,s)=>{
  o.recipients[0].items[0].modelProposal={required:true};
  o.recipients[0].items[0].url="old-link";
  s.products[0].variants[0].url="https://example.test/fake-variant";
});
function evalCase(name:string,change:(s:any)=>void,success=true){
  const state:any=copy(baseState);change(state);
  add("workflow evaluation: "+name,"evaluate_workflow",{
    state,groupId:"group:o1"
  },()=>{
    const {shipments,group}=groupContext(state,"group:o1");
    const step=groupStep(state,"group:o1");
    const needsNotice=!!group.needsNotice;
    const nextStep=needsNotice&&step>=2?3:step+1;
    return {step,nextStep,issues:nextStep<=4?
      stageIssues(state,"group:o1",nextStep):[],
      shipmentsCount:shipments.length,needsNotice,
      transferred:shipments.some((v:any)=>v.transferred)};
  });
  cases[cases.length-1].expectedOk=success;
}
evalCase("ordinary group step two",()=>{});
evalCase("group notice pending",s=>{s.workflow.groups[0].needsNotice=true;});
evalCase("group transferred status",s=>{s.workflow.shipments[0].transferred=true;});
evalCase("group at fourth stage",s=>{s.workflow.shipments[0].step=4;});
evalCase("deleted group not available",s=>{s.workflow.groups[0].deletedAt=now;},false);
function dispatchCase(name:string,change:(s:any)=>void,orderId="o1"){
  const state:any=copy(baseState);change(state);
  add("dispatch state: "+name,"evaluate_dispatch_state",{
    state,orderId
  },()=>({status:dispatchState(state,orderId)}));
}
dispatchCase("not yet dispatched",()=>{});
dispatchCase("tracking and actual both completed",s=>{
  s.workflow.shipments[0].tracking={FACTORY:"888888888888"};
  s.workflow.shipments[0].actualFreight={FACTORY:3000};
});
dispatchCase("tracking without verified actual",s=>{
  s.workflow.shipments[0].tracking={FACTORY:"888888888888"};
});
dispatchCase("actual without tracking",s=>{
  s.workflow.shipments[0].actualFreight={FACTORY:3000};
});
dispatchCase("unknown order is in progress",()=>{},"missing-order");
dispatchCase("both origins must have tracking and actual",s=>{
  const second=copy(s.orders[0].recipients[0].items[0]);
  second.id="item-store";second.origin="STORE";
  s.orders[0].recipients[0].items.push(second);
  s.workflow.shipments[0].tracking={FACTORY:"888888888888",STORE:"777777777777"};
  s.workflow.shipments[0].actualFreight={FACTORY:3000,STORE:2500};
});


function shippingDeleteCase(name:string,change:(s:any)=>void,detach:boolean,expectedOk:boolean){
  const state:any=copy(baseState);
  change(state);
  add("shipping deletion: "+name,"apply_shipping_action",{
    action:"delete_group",state,groupId:"music",detach,now:actionNow
  },()=>({state:frozenDate(()=>deleteShippingGroup(state,"music",detach))}));
  cases[cases.length-1].expectedOk=expectedOk;
}
shippingDeleteCase("reject linked product without detach",s=>{
  s.products[0].shippingGroupId="music";
},false,false);
shippingDeleteCase("detach linked product and deactivate combination",s=>{
  s.products[0].shippingGroupId="music";
  s.shipping.combinations.push({
    id:"known-combo",active:true,versions:{"group:music":"v1"},
    key:"FACTORY|p1@v1:2",epoch:7,at:now,charge:3000,actual:2900
  });
},true,true);
shippingDeleteCase("delete group with no registered product",s=>{
  delete s.products[0].shippingGroupId;
},false,true);
shippingDeleteCase("delete already deleted group blocked",s=>{
  s.shipping.groups[0].deletedAt=now;
},true,false);
function basisCase(name:string,change:(s:any)=>void,groupId?:string){
  const basisShipping:any=copy(shipping);
  change(basisShipping);
  const ruleIds=Object.keys(basisShipping.productRules??{});
  const ids=Array.from({length:ruleIds.length+basisShipping.groups.length+2},
    (_,i)=>"shipping-basis-"+i);
  const productVersions=Object.fromEntries(ruleIds.map((id,i)=>[id,ids[i]]));
  const groupVersions=Object.fromEntries(basisShipping.groups.map((g:any,i)=>
    [g.id,ids[ruleIds.length+i]]));
  add("shipping basis: "+name,"apply_shipping_action",{
    action:"change_basis",shipping:basisShipping,groupId,now:actionNow,
    productVersions,groupVersions
  },()=>({shipping:deterministicIds(ids,()=>changeShippingBasis(basisShipping,groupId))}));
  cases[cases.length-1].expectedOk=true;
}
basisCase("reset current group only",()=>{},"music");
basisCase("global epoch reset with current groups",()=>{});
basisCase("product-specific tariff archived before reset",s=>{
  s.productRules={p1:copy(s.groups[0].current)};
  s.productRules.p1.version="product-rule-v1";
});
basisCase("nonexistent target leaves shipping unchanged",()=>{},"not-a-group");

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
// KakaoTalk title-client association uses the exact original TS oracle.
// Preserve NFKC title normalization, duplicate window guards and active clients.
const mappedWindows:any[]=[
  {kind:"CHAT",handle:"w1",title:"  ＡＢ  가상  "},
];
const mappedState:any=copy(baseState);
mappedState.clients=[{...copy(client),id:"dealer-1",active:true}];
mappedState.settings.kakaoTitleMappings={};
add("kakao title: remember normalized chat","remember_kakao_title_client",{
  state:mappedState,windows:mappedWindows,handle:"w1",clientId:"dealer-1",
  actor:"가상 직원",now:actionNow
},()=>({state:frozenDate(()=>rememberTitle(mappedState,mappedWindows as any,
  "w1","dealer-1","가상 직원"))}));
const twinWindows:any[]=[
  ...mappedWindows,{kind:"CHAT",handle:"w2",title:"ab 가상"}
];
add("kakao title: duplicate normalized titles mark ambiguous","remember_kakao_title_client",{
  state:mappedState,windows:twinWindows,handle:"w1",clientId:"dealer-1",
  actor:"가상 직원",now:actionNow
},()=>({state:frozenDate(()=>rememberTitle(mappedState,twinWindows as any,
  "w1","dealer-1","가상 직원"))}));
for(const [name,handle,clientId] of [
  ["unknown window","absent","dealer-1"],
  ["unknown dealer","w1","no-client"],
]){
  add("kakao title: "+name+" rejected","remember_kakao_title_client",{
    state:mappedState,windows:mappedWindows,handle,clientId,
    actor:"가상 직원",now:actionNow
  },()=>({state:rememberTitle(mappedState,mappedWindows as any,handle,clientId,"가상 직원")}));
  cases[cases.length-1].expectedOk=false;
}
const rememberedState:any=copy(mappedState);
rememberedState.settings.kakaoTitleMappings={
  "ab 가상":{clientId:"dealer-1",actor:"가상 직원",updatedAt:actionNow,ambiguous:false}
};
function rememberedCase(name:string,state:any,windows:any[]) {
  add("kakao title lookup: "+name,"remembered_kakao_title_client",{
    state,windows
  },()=>({clientId:rememberedTitleClient(state,windows as any)??null}));
}
rememberedCase("NFKC match",rememberedState,mappedWindows);
rememberedCase("two chat windows are not selected",rememberedState,twinWindows);
rememberedCase("inactive dealer blocked",{
  ...rememberedState,clients:[{...copy(client),active:false}]
},mappedWindows);
rememberedCase("ambiguous remembered mapping blocked",{
  ...rememberedState,settings:{...rememberedState.settings,
    kakaoTitleMappings:{"ab 가상":{...rememberedState.settings.kakaoTitleMappings["ab 가상"],
      ambiguous:true}}}
},mappedWindows);

// Manual grid application is tested against the unchanged TS oracle;
// these cases cover assignment spans and preservation of old issue decisions.
const manualOrder:any=copy(order);
manualOrder.confirmedAt=undefined;
manualOrder.pricesLocked=true;
manualOrder.issueResolutions={
  "issue:o1:r1:recipient:UNASSIGNED_EVIDENCE":{
    resolution:"UNRESOLVED",resolutionSource:"가상 직원",updatedAt:now,evidence:"old"
  }
};
const manualRows:any[]=copy(manualOrder.recipients);
manualRows[0].sources=[{start:0,end:2,field:"name",targetId:"r1"}];
manualRows[0].unassignedEvidence=[{start:0,end:2,kind:"product",text:"가상"}];
manualRows[0].items[0].sources=[{start:2,end:4,field:"product",targetId:"item1"}];
const manualModel:ManualModel={
  rows:manualRows as any,
  blocks:[
    {id:"0:2",start:0,end:2,field:"name",targetId:"r1",text:"가상"} as any,
    {id:"2:4",start:2,end:4,field:"product",targetId:"item1",text:"상품"} as any,
  ],
  assignments:{
    "0:2":{recipientId:"r1",field:"name",value:"가상 수취인"},
    "2:4":{recipientId:"r1",itemId:"item1",field:"product",value:"가상 상품"},
  },
};
function manualCase(name:string,o:any,m:ManualModel,valid=true){
  add("manual classification: "+name,"apply_manual_classification",{
    action:"apply_manual",order:o,model:m,
  },()=>({order:applyManual(o,m)}));
  cases[cases.length-1].expectedOk=valid;
}
manualCase("final application rebuilds evidence and preserves source order",
  manualOrder,manualModel);
manualCase("missing quantity blocks application",manualOrder,{
  ...manualModel,rows:manualModel.rows.map(r=>({...r,items:r.items.map(i=>({
    ...i,quantity:null,quantityConfirmed:false
  }))}))
},false);
manualCase("no shipment rows blocks application",manualOrder,{
  ...manualModel,rows:[],
},false);
manualCase("confirmed reception blocks manual application",{
  ...manualOrder,confirmedAt:now
},manualModel,false);
manualCase("no assignments keeps manual rows",manualOrder,{
  ...manualModel,assignments:{},blocks:[]
});

// Native factory-review badges must use the same resolved-row semantics as
// the original TS UI; unresolved errors must never display as completed.
const openReply:any={
  id:"reply-original",filename:"회신.xlsx",businessDate:"2026-11-13",
  at:actionNow,status:"REVIEW",rows:[
    {row:2,name:"가상",address:"서울",contacts:["01012345678"],
      tracking:"001234567890",actual:3000,applied:false},
    {row:3,name:"가상2",address:"서울",contacts:["01012345679"],
      tracking:"001234567891",actual:3000,applied:true}
  ]
};
function factoryReviewCase(name:string,replies:any[]){
  const state:any={...copy(baseState),factoryReplies:replies};
  add("factory review UI: "+name,"factory_reply_review_statuses",{state},
    ()=>({reviews:replies.map(record=>({
      id:record.id,needsReview:replyNeedsReview(state,record)
    }))}));
  add("factory review detail: "+name,"factory_reply_review_details",{state},
    ()=>({reviews:replies.map(record=>({
      id:record.id,needsReview:replyNeedsReview(state,record),
      rows:record.rows.map((row:any)=>({
        row:row.row,
        resolved:state.factoryReplies.some((later:any)=>
          later.resolves?.id===record.id && later.resolves.row===row.row &&
          later.rows.some((result:any)=>result.applied))
      }))
    }))}));
}
factoryReviewCase("unresolved row remains review", [openReply]);
factoryReviewCase("later successfully applied resolution closes review", [
  openReply,{...copy(openReply),id:"reply-resolution",rows:[
    {...copy(openReply.rows[0]),applied:true}
  ],resolves:{id:"reply-original",row:2}}
]);
factoryReviewCase("unsuccessful resolution does not close review", [
  openReply,{...copy(openReply),id:"reply-failed",rows:[
    {...copy(openReply.rows[0]),applied:false}
  ],resolves:{id:"reply-original",row:2}}
]);
factoryReviewCase("source file error remains review after applied row", [
  {...copy(openReply),error:"원본 파일 문제",rows:[
    {...copy(openReply.rows[0]),applied:true}]}
]);
factoryReviewCase("empty reply has no pending rows", [
  {...copy(openReply),rows:[]}
]);

// The actual factory clipboard payload and status use Rust results.
// Compare complete Korean text, including spacing, freight and field order.
const correctionViewState:any=copy(baseState);
const correctionShipId=correctionViewState.workflow.shipments[0].id;
const originalCorrectionRecipient:any=copy(correctionViewState.orders[0].recipients[0]);
const editedCorrectionRecipient:any=copy(originalCorrectionRecipient);
editedCorrectionRecipient.name="변경된 수취인";
editedCorrectionRecipient.mobile="010-0000-0000";
editedCorrectionRecipient.note="교문 앞 수령";
editedCorrectionRecipient.items[0].quantity=3;
editedCorrectionRecipient.shippingCharges={FACTORY:4500,STORE:2500};
editedCorrectionRecipient.freightCode="020";
const correctionViewRequest:any={
  id:"correction-message-1",shipmentId:correctionShipId,
  orderId:correctionViewState.orders[0].id,
  beforeRecipient:originalCorrectionRecipient,
  afterRecipient:editedCorrectionRecipient,
  at:actionNow,actor:"가상 직원",text:"배송 정보 정정 요청"
};
correctionViewState.workflow.changeRequests=[correctionViewRequest];
function correctionViewCase(name:string,state:any){
  add("factory correction copy: "+name,"apply_correction_action",{
    action:"correction_view",state,shipmentId:correctionShipId
  },()=>({requests:state.workflow.changeRequests
    .filter((r:any)=>r.shipmentId===correctionShipId)
    .map((r:any)=>({id:r.id,status:correctionStatus(state,r.id),
      message:r.afterRecipient&&r.beforeRecipient?correctionMessage(state,r.id):null}))}));
}
correctionViewCase("complete changed fields",correctionViewState);
const pendingCorrectionState:any=copy(correctionViewState);
pendingCorrectionState.workflow.events.push({
  id:"correction-status-test",at:actionNow,actor:"가상 직원",
  action:"정정 요청 상태",shipmentIds:[correctionShipId],
  before:correctionViewRequest.id,after:"PENDING_FACTORY"
});
correctionViewCase("pending factory status",pendingCorrectionState);
const legacyCorrectionState:any=copy(correctionViewState);
legacyCorrectionState.workflow.changeRequests=[{
  id:"legacy-correction-test",shipmentId:correctionShipId,text:"구 버전 정정 안내"
}];
correctionViewCase("legacy request without structured details",legacyCorrectionState);
const blankCorrectionState:any=copy(correctionViewState);
blankCorrectionState.workflow.changeRequests=[];
correctionViewCase("no correction requests",blankCorrectionState);

// Shipping manager read-only tariff projections must be bit-for-bit
// equivalent to the two still-live TS helpers before they are retired.
const shippingViewState:any=copy(baseState);
shippingViewState.shipping=copy(shipping);
shippingViewState.products[0].shippingGroupId="music";
shippingViewState.shipping.groups[0].current.perItem=5200;
shippingViewState.shipping.groups[0].current.maxBundle=4;
shippingViewState.shipping.groups[0].current.maxConfirmed=false;
shippingViewState.shipping.groups[0].current.fees={"1":null,"2":4000};
shippingViewState.shipping.combinations=[
  {id:"current",active:true,epoch:shippingViewState.shipping.epoch,
    versions:{"group:music":"v1","assignment:p1":"music"},
    at:actionNow,key:"FACTORY|p1@v1:2"},
  {id:"expired-epoch",active:true,epoch:0,
    versions:{"group:music":"v1"},at:actionNow,key:"FACTORY|p1@v1:2"},
  {id:"unknown-product",active:true,epoch:shippingViewState.shipping.epoch,
    versions:{"product:missing":"unregistered"},at:actionNow,key:"FACTORY|missing@v1:2"},
  {id:"wrong-assignment",active:true,epoch:shippingViewState.shipping.epoch,
    versions:{"assignment:p1":"other"},at:actionNow,key:"FACTORY|p1@v1:2"}
];
function shippingViewCase(name:string,state:any){
  const shipping=state.shipping;
  add("shipping manager: "+name,"shipping_manager_view",{
    state,shipping
  },()=>({editableRules:Object.fromEntries(shipping.groups.map((g:any)=>
    [g.id,editableShippingRule(g.current)])),
    currentCombinations:Object.fromEntries(shipping.combinations.map((c:any)=>
    [c.id,combinationCurrent(c,state)]))}));
}
shippingViewCase("active group and per-item edit",shippingViewState);
const shippingChanged:any=copy(shippingViewState);
shippingChanged.shipping.groups[0].current.version="different-version";
shippingViewCase("old combination after tariff revision",shippingChanged);
const shippingIndividual:any=copy(shippingViewState);
shippingIndividual.products[0].shippingGroupId=undefined;
shippingViewCase("assignment removed",shippingIndividual);

// Staff provisional notice save validation; the real TS original is the oracle.
function provisionalValidationCase(name:string,notices:Record<string,unknown>,valid=true){
  const state:any=copy(baseState);
  state.settings.provisionalProductNotices=notices;
  add("provisional notice validation: "+name,"validate_provisional_notices",{
    state
  },()=>{validateProvisionalProductNotices(state);return {valid:true};});
  cases[cases.length-1].expectedOk=valid;
}
provisionalValidationCase("valid Unicode notice",{"p1":"가상 상품 안내"});
provisionalValidationCase("missing product id rejected",{"nonexistent":"안내"},false);
provisionalValidationCase("blank notice rejected",{"p1":" \t "},false);
provisionalValidationCase("non-string notice rejected",{"p1":12},false);
provisionalValidationCase("2000 emoji allowed",{"p1":"😀".repeat(2000)});
provisionalValidationCase("2001 emoji rejected",{"p1":"😀".repeat(2001)},false);
provisionalValidationCase("empty mapping allowed",{});

// Template editing is a save-time native decision, not only a preview rule.
function templateValidationCase(name:string,edits:Record<string,unknown>,valid=true){
  add("message template validation: "+name,"validate_automatic_templates",{
    edits,orderedKeys:Object.keys(edits)
  },()=>{validateAutomaticMessageTemplates(edits as any);return {valid:true};});
  cases[cases.length-1].expectedOk=valid;
}
templateValidationCase("custom valid recipient",{
  recipientName:"정확한 받으실 분 성함을 알려주세요."});
templateValidationCase("mandatory and optional variables",{
  colorDefault:"{색상}으로 {상품명} 상품을 보내겠습니다.",
  requestRecipient:"{번호}. {수취인}: {확인항목}"
});
templateValidationCase("unknown type",{"unsupportedTemplate":"테스트"},false);
templateValidationCase("empty edited template",{recipientName:"   "},false);
templateValidationCase("over length",{recipientName:"가".repeat(2001)},false);
templateValidationCase("UTF16 emoji length",{recipientName:"😀".repeat(1001)},false);
templateValidationCase("unknown variable",{addressMissing:"{수취인}님 {별명}"},false);
templateValidationCase("missing mandatory variable",{addressMissing:"주소 확인"},false);
templateValidationCase("broken brace",{addressMissing:"{수취인}님 {미완성"},false);
templateValidationCase("nested braces",{addressMissing:"{{수취인}}님 주소 확인"},false);
templateValidationCase("multiple invalid errors preserve input order",{
  paymentItem:"{상품명} {수량}",addressMissing:"주소 확인"
},false);
templateValidationCase("valid numeric account placeholders",{
  paymentAccount:"{은행명} {계좌번호} {예금주} 안내드립니다."
});

// The current React chosen-item path no longer calls TS itemFromProduct.
// Compare the full constructed order item, including color, name, defaulted,
// issue list, origin and price, against the original TS constructor.
function catalogItemCase(name:string,p:any,c:any,quantity:any,vid?:string,color?:string){
  p={defaultColor:"Black",code:"TEST",...p};
  const id="new-catalog-item-"+name.replace(/\s+/g,"-");
  const payload:any={product:p,client:c,newItemId:id,quantity};
  if(vid!==undefined)payload.variantId=vid;
  if(color!==undefined)payload.color=color;
  add("catalog item: "+name,"create_catalog_item",payload,
    ()=>({item:deterministicIds([id],()=>itemFromProduct(p,c,color,quantity,vid))}));
}
catalogItemCase("single registered option",copy(product),copy(client),2,"v1");
catalogItemCase("no option id uses default",copy(product),copy(client),null);
catalogItemCase("explicit color preserves selected option",copy(product),copy(client),3,"v1","Black");
catalogItemCase("unknown explicit variant",copy(product),copy(client),4,"absent");
catalogItemCase("unresolved source configuration",{
  ...copy(product),requiresOption:true
},copy(client),null,"v1");
catalogItemCase("two variants are not independently selectable",{
  ...copy(product),variants:[...copy(product.variants),{...copy(product.variants[0]),id:"v2",color:"White"}]
},copy(client),1,"v1");
catalogItemCase("demo product label",{
  ...copy(product),variants:[{...copy(product.variants[0]),source:"DEMO"}]
},copy(client),1,"v1");
catalogItemCase("missing default color warning",{
  ...copy(product),colorStatus:"MISSING",defaultColor:"색상 미표기"
},copy(client),1,"v1");
catalogItemCase("special tier override",copy(product),{
  ...copy(client),tier:"special",overrides:{"v1":18900}
},5,"v1");
catalogItemCase("catalog label and price absence",{
  ...copy(product),catalog:"OFFICIAL",variants:[{...copy(product.variants[0]),wholesale:null}]
},copy(client),1,"v1");

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
  // Rust action adapters return auxiliary metadata (step, paymentId,
  // entries, etc.) not returned by the pure TypeScript mutation functions.
  // Compare the COMPLETE resulting State, never only selected state fields.
  if(c.operation==="apply_workflow_action" && (rust as any)?.ok===true){
    rust={ok:true,value:{state:(rust as any).value?.state}};
  }
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
