/** Compare real src/domain.ts and src/shipping.ts directly against staged Rust rules. */
import test from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {tsImport} from "tsx/esm/api";
const {resolvePrice,totals,repriceOrder}=await tsImport("../../../src/domain.ts",import.meta.url);
const {shouldRefreshUncommittedOrderPricing}=await tsImport("../../../src/orders/passive-pricing.ts",import.meta.url);
const {recommendShipping}=await tsImport("../../../src/shipping.ts",import.meta.url);
const {shipmentTotals,stageIssues,groupStep,groupShipments,orderGrandTotal,shipmentVat,groupTotals,workflowIssues,shipmentFreightCode,paymentBalance,shipmentContext,reconcileWorkflow}=
  await tsImport("../../../src/workflow.ts",import.meta.url);
const root=fileURLToPath(new URL("../../../",import.meta.url));
const manifest=fileURLToPath(new URL("./Cargo.toml",import.meta.url));
const cases=[];
function capture(fn){try{return {ok:true,value:fn()};}catch(e){return {ok:false,error:e.message||String(e)};}}
function add(name,operation,payload,oracle){cases.push({name,operation,payload,ts:capture(oracle)});}
function client(tier="wholesale"){return {id:"dealer-1",tier,shippingFeeExcluded:false,overrides:{},
  payment:"PREPAID",name:"가상 거래처",address:"서울시 가상로 1",phone:"02-111-2222"};}
function product(){return {id:"p1",name:"BD 709",origin:"FACTORY",active:true,
  shippingGroupId:"music",variants:[{id:"v1",color:"Black",
    wholesale:30000,semi:35000,retail:40000,legacyIds:["old-v1"],
    url:"https://www.bandostand.com/product/709"}]};}
function item(quantity=2,unitPrice=30000){return {id:"i1",productId:"p1",variantId:"v1",
  raw:"BD 709",name:"BD 709",origin:"FACTORY",quantity,unitPrice,
  color:"Black",defaulted:false,issues:[],url:""};}
function order(quantity=2,unitPrice=30000){return {id:"o1",clientId:"dealer-1",
  raw:"가상 발주",freightCode:"010",shippingFee:3000,applyVat:true,
  pricesLocked:false,vatAmount:null,
  recipients:[{id:"r1",name:"김민수",address:"서울 강남구 1",phone:"02-123-4567",mobile:"",
    note:"",items:[item(quantity,unitPrice)]}]};}
function shippingState(){return {products:[product()],shipping:{epoch:7,productRules:{},
  groups:[{id:"music",name:"일반 보면대",current:{version:"v1",
    fees:{"1":3000,"2":4000,"3":5000,"4":6000},maxBundle:4,maxConfirmed:true,perItem:null},
    history:[]}],combinations:[]}};}

// Price resolution, including special client precedence and historical variant IDs.
for(const tier of ["wholesale","semi","retail","special","unknown"]) {
  let p=product(),c=client(tier);
  add("price tier "+tier,"resolve_unit_price",{product:p,variantId:"v1",client:c},
    ()=>({unitPrice:resolvePrice(p,"v1",c)}));
}
function checkPrice(name,change=()=>{}){
  const p=product(),c=client("special"),id="v1";change(p,c);
  add("price "+name,"resolve_unit_price",{product:p,variantId:id,client:c},
    ()=>({unitPrice:resolvePrice(p,id,c)}));
}
checkPrice("direct special override",(p,c)=>{c.overrides.v1=27500;});
checkPrice("legacy special override",(p,c)=>{c.overrides["old-v1"]=28000;});
checkPrice("zero direct override",(p,c)=>{c.overrides.v1=0;});
checkPrice("null direct falls back",(p,c)=>{c.overrides.v1=null;});
checkPrice("missing original record",(p,c)=>{p.variants=[];});
checkPrice("no client",(p,c)=>{c.id="";});
checkPrice("variant nonzero wholesale",(p,c)=>{p.variants[0].wholesale=1;});

// Totals: exact JSON fields, frozen invoice behavior and boundary amounts.
function checkTotals(name,mutate=()=>{}){
  const o=order(),c=client();mutate(o,c);
  add("totals "+name,"calculate_price",{order:o,client:c},()=>totals(o,c));
}
checkTotals("normal");
checkTotals("no VAT",o=>{o.applyVat=false;});
checkTotals("customer freight excluded",(o,c)=>{c.shippingFeeExcluded=true;});
checkTotals("collect freight",o=>{o.freightCode="020";});
checkTotals("freight undefined",o=>{o.shippingFee=null;});
checkTotals("no recipients",o=>{o.recipients=[];});
checkTotals("zero price",o=>{o.recipients[0].items[0].unitPrice=0;});
checkTotals("quantity zero",o=>{o.recipients[0].items[0].quantity=0;});
checkTotals("quantity missing",o=>{o.recipients[0].items[0].quantity=null;});
checkTotals("quantity fractional",o=>{o.recipients[0].items[0].quantity=1.5;});
checkTotals("missing variant id",o=>{o.recipients[0].items[0].variantId=null;});
checkTotals("negative price",o=>{o.recipients[0].items[0].unitPrice=-1;});
checkTotals("noninteger price",o=>{o.recipients[0].items[0].unitPrice=10.5;});
checkTotals("decimal VAT rounding",o=>{o.shippingFee=5;o.recipients[0].items[0].unitPrice=12;});
checkTotals("frozen VAT and client",(o,c)=>{
  o.pricesLocked=true;o.vatAmount=999;o.clientSnapshot={...client(),shippingFeeExcluded:true};
  c.shippingFeeExcluded=false;
});
checkTotals("near max safe",o=>{
  o.recipients[0].items[0].unitPrice=Number.MAX_SAFE_INTEGER;o.recipients[0].items[0].quantity=1;
});
checkTotals("unsafe subtotal",o=>{
  o.recipients[0].items[0].unitPrice=Number.MAX_SAFE_INTEGER;o.recipients[0].items[0].quantity=2;
});
checkTotals("multiple recipients",o=>{
  o.recipients.push({id:"r2",items:[item(3,15000)]});
});

// Check the passive pricing guard, never reprice a saved confirmed order.
for(const situation of ["draft","persisted","confirmed","deleted","frozen"]) {
  const o=order(),persistedOrders=[];
  if(situation==="persisted")persistedOrders.push({id:o.id});
  if(situation==="confirmed")o.confirmedAt="2026-11-13T09:00:00+09:00";
  if(situation==="deleted")o.deletedAt="2026-11-13T10:00:00+09:00";
  if(situation==="frozen")o.pricesLocked=true;
  add("refresh "+situation,"should_refresh_pricing",{order:o,persistedOrders},
    ()=>({refresh:shouldRefreshUncommittedOrderPricing(o,persistedOrders)}));
}

// Newly received, unconfirmed orders can use the current price table.
for(const tier of ["wholesale","semi","retail","special"]) {
  const o=order(2,30000),c=client(tier),p=product();
  add("reprice draft "+tier,"reprice_order",{
    order:o,client:c,products:[p],persistedOrders:[],explicitEdit:true,
  },()=>({order:repriceOrder(o,c,{products:[p]}),refreshed:true}));
}

// Shipping recommendations: compare whole bundle list, version string, total.
function checkShipping(name,mutate=()=>{}){
  const o=order(),state=shippingState();mutate(o,state);
  add("shipping "+name,"calculate_shipping",{order:o,state},
    ()=>recommendShipping(o,state));
}
checkShipping("normal");
checkShipping("single",o=>{o.recipients[0].items[0].quantity=1;});
checkShipping("three",o=>{o.recipients[0].items[0].quantity=3;});
checkShipping("group over max",o=>{o.recipients[0].items[0].quantity=5;});
checkShipping("no shipping group",(o,s)=>{s.shipping.groups=[];});
checkShipping("product not found",(o,s)=>{s.products=[];});
checkShipping("quantity missing",o=>{o.recipients[0].items[0].quantity=null;});
checkShipping("variant missing",o=>{o.recipients[0].items[0].variantId=null;});
checkShipping("zero quantity",o=>{o.recipients[0].items[0].quantity=0;});
checkShipping("per item price",(o,s)=>{s.shipping.groups[0].current.perItem=1700;});
checkShipping("one parcel each",(o,s)=>{
  s.shipping.groups[0].current.maxConfirmed=true;
  s.shipping.groups[0].current.maxBundle=1;
});
checkShipping("missing freight tariff",(o,s)=>{s.shipping.groups[0].current.fees["2"]=null;});
checkShipping("expired group",(o,s)=>{s.shipping.groups[0].deletedAt="2026-11-12";});
checkShipping("different product origin",(o,s)=>{s.products[0].origin="STORE";});
checkShipping("charged combination",(o,s)=>{
  s.shipping.combinations.push({id:"comb1",key:"FACTORY|p1@v1:2",epoch:7,
    versions:{"group:music":"v1","assignment:p1":"music"},charge:4500,
    actual:4000,at:"2026-11-12T12:00:00+09:00",active:true});
});
checkShipping("combination old epoch",(o,s)=>{
  s.shipping.combinations.push({id:"comb1",key:"FACTORY|p1@v1:2",epoch:6,
    versions:{"group:music":"v1","assignment:p1":"music"},charge:4500,
    actual:4000,at:"2026-11-12T12:00:00+09:00",active:true});
});


function workflowState(){
  const c=client("wholesale");
  c.payment="POSTPAID";
  c.preferredAccountId="account-1";
  const o=order(1,30000);
  o.confirmedAt="2026-11-13T09:00:00+09:00";
  o.pricesLocked=true;
  o.clientSnapshot=structuredClone(c);
  o.senderSnapshot=structuredClone(c);
  o.status="STATEMENT";
  const state=shippingState();
  state.clients=[c];
  state.orders=[o];
  state.settings={
    accounts:[{id:"account-1",bank:"가상은행",number:"123-456",holder:"가상상호"}],
    defaultAccountId:"account-1",operatorName:"직원",
  };
  state.workflow={
    sources:[{id:"source:o1",orderId:"o1",dealerId:"dealer-1"}],
    groups:[{id:"group:o1",sourceId:"source:o1",dealerId:"dealer-1",
      notices:[],needsNotice:false}],
    shipments:[{id:"shipment:o1:r1",sourceId:"source:o1",
      orderId:"o1",recipientId:"r1",groupId:"group:o1",
      step:3,completedAt:{"1":"2026-11-13T09:00:00+09:00",
      "2":"2026-11-13T09:00:00+09:00","3":"2026-11-13T09:00:00+09:00"},
      charges:{FACTORY:3000},chargeMode:"MANUAL",freightVersion:"v1",
      infoSignature:"stable",transferred:false}],
    queue:[],payments:[],confirmations:[],events:[],deliveries:[],changeRequests:[],
  };
  return state;
}
function checkShipment(name,mutate=()=>{}){
  const state=workflowState();
  mutate(state);
  const shipmentId="shipment:o1:r1";
  add("shipmentTotals "+name,"calculate_shipment_totals",{state,shipmentId},
    ()=>shipmentTotals(state,state.workflow.shipments[0]));
}
checkShipment("normal");
checkShipment("recipient VAT override off",s=>{s.orders[0].recipients[0].vatOverride=false;});
checkShipment("recipient VAT override on",s=>{s.orders[0].recipients[0].vatOverride=true;});
checkShipment("recipient freight collect",s=>{s.orders[0].recipients[0].freightCode="020";});
checkShipment("freight missing",s=>{s.workflow.shipments[0].charges={};});
checkShipment("frozen snapshot used",s=>{
  s.workflow.shipments[0].transferred=true;
  s.workflow.queue=[{id:"q1",shipmentId:"shipment:o1:r1",origin:"FACTORY",
    status:"EXPORTED",snapshot:{subtotal:15000,shipping:5000,vat:2000,total:22000}}];
});
checkShipment("frozen overridden by latestRecipient",s=>{
  s.workflow.shipments[0].transferred=true;
  s.workflow.shipments[0].latestRecipient={id:"r1"};
  s.workflow.queue=[{id:"q1",shipmentId:"shipment:o1:r1",origin:"FACTORY",
    status:"EXPORTED",snapshot:{subtotal:15000,shipping:5000,vat:2000,total:22000}}];
});
function checkWorkflow(name,mutate=()=>{}){
  const state=workflowState();
  mutate(state);
  const groupId="group:o1";
  add("workflow evaluate "+name,"evaluate_workflow",{state,groupId},()=>{
    const step=groupStep(state,groupId);
    const members=groupShipments(state,groupId);
    const needsNotice=state.workflow.groups[0].needsNotice===true;
    const nextStep=needsNotice&&step>=2?3:step+1;
    const issues=nextStep<=4?stageIssues(state,groupId,nextStep):[];
    return {step,nextStep,issues,shipmentsCount:members.length,
      needsNotice,transferred:members.some(x=>x.transferred===true)};
  });
}
checkWorkflow("postpaid step 3");
checkWorkflow("prepaid step 3",s=>{
  s.clients[0].payment="PREPAID";
  s.orders[0].clientSnapshot.payment="PREPAID";
});
checkWorkflow("needs new notice",s=>{s.workflow.groups[0].needsNotice=true;});

// The source of truth for the order detail summary is still the original
// TS orderGrandTotal/shipmentVat oracle, not a hand-entered expected amount.
function checkOrderPreview(name, mutate = () => {}) {
  const state = workflowState();
  let draft = state.orders[0];
  mutate(state);
  draft = state.orders[0] ?? draft;
  const orderId = draft.id;
  const rows = state.workflow.shipments.filter((ship) =>
    ship.orderId === orderId && !ship.legacyArchived &&
    !state.workflow.groups.find((g) => g.id === ship.groupId)?.deletedAt,
  );
  const applies = draft.recipients.map((row) => shipmentVat(draft, row));
  const vatLabel = applies.some(Boolean) && applies.some((v) => !v)
    ? "부가세 포함/별도"
    : applies.some(Boolean) ? "부가세 포함" : "부가세 별도";
  add("order preview " + name, "preview_order",
    { state, draft, orderId },
    () => ({
      orderId,
      shipmentCount: rows.length,
      lineAmounts: draft.recipients.flatMap((row) => row.items.map((item) => ({
        recipientId: row.id,
        itemId: item.id,
        amount: item.unitPrice !== null && item.quantity !== null &&
          item.productId && item.variantId ? item.unitPrice * item.quantity : null,
      }))),
      total: orderGrandTotal(state, orderId),
      vatLabel,
    }));
}
checkOrderPreview("normal subtotal and VAT");
checkOrderPreview("recipient VAT disabled", (s) => {
  s.orders[0].recipients[0].vatOverride = false;
});
checkOrderPreview("collect freight has no billed freight", (s) => {
  s.orders[0].recipients[0].freightCode = "020";
});
checkOrderPreview("unknown freight yields null total", (s) => {
  s.workflow.shipments[0].charges = {};
});
checkOrderPreview("deleted group omitted", (s) => {
  s.workflow.groups[0].deletedAt = "2026-11-13T21:00:00+09:00";
});
checkOrderPreview("archived shipment omitted", (s) => {
  s.workflow.shipments[0].legacyArchived = true;
});
checkOrderPreview("transferred frozen invoice totals", (s) => {
  s.workflow.shipments[0].transferred = true;
  s.workflow.queue = [{
    id: "q1", shipmentId: "shipment:o1:r1", origin: "FACTORY",
    status: "EXPORTED", snapshot: { subtotal: 20000, shipping: 4000, vat: 2400, total: 26400 },
  }];
});
checkOrderPreview("two shipments with mixed VAT", (s) => {
  const second = structuredClone(s.orders[0].recipients[0]);
  second.id = "r2";
  second.vatOverride = false;
  s.orders[0].recipients.push(second);
  const ship = structuredClone(s.workflow.shipments[0]);
  ship.id = "shipment:o1:r2";
  ship.recipientId = "r2";
  s.workflow.shipments.push(ship);
});
checkOrderPreview("draft-only before dealer selection", (s) => {
  s.orders = [];
  s.workflow.shipments = [];
  s.workflow.groups = [];
});

// The entire live board projection must agree with the original TypeScript
// oracle, not just the order footer. The Rust engine owns stage blockers,
// item issues, per-origin shipping and payment allocations.
function checkBoardPreview(name, mutate = () => {}) {
  const state = workflowState();
  mutate(state);
  const expected = () => ({
    groups: state.workflow.groups.flatMap((group) => {
      const ships = groupShipments(state, group.id);
      if (!ships.length) return [];
      const step = groupStep(state, group.id);
      const needsNotice = group.needsNotice === true;
      const nextStep = needsNotice && step >= 2 ? 3 : step + 1;
      const vats = ships.map((ship) => {
        const {order,recipient} = shipmentContext(state,ship);
        return shipmentVat(order,recipient);
      });
      return [{
        groupId: group.id,
        step,
        nextStep,
        needsNotice,
        transferred: ships.some((ship) => ship.transferred === true),
        shipmentCount: ships.length,
        totals: groupTotals(state,group.id),
        vatLabel: vats.every(Boolean) ? "부가세 포함" :
          vats.some(Boolean) ? "부가세 포함/별도" : "부가세 별도",
        shipments: ships.map((ship) => {
          const {order,recipient} = shipmentContext(state,ship);
          return {
            shipmentId:ship.id,
            paid:paymentBalance(state,ship).paid,
            totals:shipmentTotals(state,ship),
            freightCode:shipmentFreightCode(order,recipient),
            displayCharges:Object.fromEntries([...new Set(recipient.items.map((item) => item.origin))]
              .filter((origin) => origin === "FACTORY" || origin === "STORE")
              .map((origin) => [origin, shipmentFreightCode(order,recipient) === "020" ||
                shipmentContext(state,ship).client.shippingFeeExcluded ? 0 :
                ship.charges[origin] ?? null])),
            freightEditingBlocked:shipmentFreightCode(order,recipient) === "020" ||
              shipmentContext(state,ship).client.shippingFeeExcluded === true,
            vatIncluded:shipmentVat(order,recipient),
          };
        }),
        issues: workflowIssues(state,group.id),
        nextStageBlockers: nextStep <= 4 ? stageIssues(state,group.id,nextStep) : [],
      }];
    }),
  });
  // A Rust IPC response is JSON: TypeScript's own undefined-valued
  // properties disappear at serialization. Compare the wire payloads,
  // not the JS object's unobservable property-presence distinction.
  add("board preview " + name, "preview_workflow", {state},
    () => JSON.parse(JSON.stringify(expected())));
}
checkBoardPreview("normal confirmed postpaid");
checkBoardPreview("prepaid stage 3", (s) => {
  s.clients[0].payment = "PREPAID";
  s.orders[0].clientSnapshot.payment = "PREPAID";
});
checkBoardPreview("notice again", (s) => { s.workflow.groups[0].needsNotice = true; });
checkBoardPreview("collect COD and excluded VAT", (s) => {
  s.orders[0].recipients[0].freightCode = "020";
  s.orders[0].recipients[0].vatOverride = false;
});
checkBoardPreview("freight uncertain", (s) => { s.workflow.shipments[0].charges = {}; });
checkBoardPreview("matched account payment", (s) => {
  s.workflow.payments.push({
    id:"pay-1",dealerId:"dealer-1",
    account:s.settings.accounts[0],allocations:[{
      shipmentId:"shipment:o1:r1",amount:10000,
    }],
  });
});
checkBoardPreview("dealer excludes customer freight", (s) => {
  s.clients[0].shippingFeeExcluded = true;
  s.orders[0].clientSnapshot.shippingFeeExcluded = true;
});
checkBoardPreview("unmatched account payment excluded", (s) => {
  s.workflow.payments.push({
    id:"pay-1",dealerId:"dealer-1",
    account:{id:"another",bank:"가상은행",number:"987",holder:"다른사람"},
    allocations:[{shipmentId:"shipment:o1:r1",amount:10000}],
  });
});
checkBoardPreview("transferred frozen invoice", (s) => {
  s.workflow.shipments[0].transferred = true;
  s.workflow.queue.push({
    id:"q1",shipmentId:"shipment:o1:r1",origin:"FACTORY",
    status:"EXPORTED",snapshot:{subtotal:20000,shipping:4000,vat:2400,total:26400},
  });
});
checkBoardPreview("archived shipment not shown", (s) => {
  s.workflow.shipments[0].legacyArchived = true;
});


// Compare the live, unsaved order-draft reconciliation itself, not just
// the Rust board display fed by an already-computed workflow state.
function freshReconcileState() {
  const state = shippingState();
  const c = client("wholesale");
  c.preferredAccountId = "account-1";
  state.clients = [c];
  state.orders = [order(1,30000)];
  state.orders[0].createdAt = "2026-11-13T08:00:00+09:00";
  state.orders[0].updatedAt = "2026-11-13T08:00:00+09:00";
  state.settings = {
    operatorName: "가상 담당자",
    accounts: [{
      id: "account-1", bank: "가상은행", number: "123-456",
      holder: "가상상호",
    }],
    defaultAccountId: "account-1",
  };
  return state;
}
function checkReconcile(name, change = () => {}) {
  const state = freshReconcileState();
  const draft = structuredClone(state.orders[0]);
  change(state, draft);
  const payload = {
    state, draft,
    now: "2026-11-13T16:00:00+09:00",
    eventIds: Array.from({length: 128}, (_,i) => "synthetic-audit-" + i),
  };
  add("live draft reconcile " + name, "reconcile_workflow", payload, () => {
    const next = reconcileWorkflow(state,draft);
    return {
      state:next,
      emittedEvents:(next.workflow?.events.length ?? 0) -
        (state.workflow?.events.length ?? 0),
    };
  });
}
checkReconcile("single recipient and new source");
checkReconcile("shipment with VAT override", (_s,draft) => {
  draft.recipients[0].vatOverride = false;
});
checkReconcile("customer pays collect freight", (_s,draft) => {
  draft.freightCode = "020";
  draft.recipients[0].freightCode = "020";
});
checkReconcile("explicit manual customer freight", (_s,draft) => {
  draft.recipients[0].shippingCharges = { FACTORY: 5500 };
});
checkReconcile("two recipients", (_s,draft) => {
  const another = structuredClone(draft.recipients[0]);
  another.id = "r2";
  another.name = "박가상";
  another.phone = "010-2222-3333";
  another.items[0].id = "item-r2";
  draft.recipients.push(another);
});
checkReconcile("deleted/empty recipient ignored", (_s,draft) => {
  draft.recipients.push({
    id:"empty-r2",name:"",address:"",phone:"",mobile:"",items:[],
  });
});
checkReconcile("different retail order skipped without recipient", (state,draft) => {
  state.orders = [];
  state.clients = [];
  draft.clientId = "";
  draft.orderType = "AGENCY";
});
checkReconcile("draft with multiple catalog items", (_s,draft) => {
  draft.recipients[0].items.push({
    ...structuredClone(draft.recipients[0].items[0]),
    id:"item-second",quantity:2,origin:"FACTORY",
  });
});
checkReconcile("unknown product freight requires staff review", (_s,draft) => {
  draft.recipients[0].items[0].productId = "";
  draft.recipients[0].items[0].variantId = "";
  draft.recipients[0].items[0].unitPrice = null;
});
checkReconcile("unsaved customer edit with prior order", (state,draft) => {
  const second=structuredClone(draft);
  second.id = "o2";
  second.recipients[0].id = "r2";
  state.orders.push(second);
  draft.recipients[0].name = "변경 수취인";
});

// Normalize the JSON IPC boundary: undefined is omitted in JS, not sent
// to Rust. Event IDs/timestamps are independently generated by both
// implementations. Their stable semantic fields must still match.
function wireReconcileResult(answer) {
  if (!answer.ok) return answer;
  const copy=JSON.parse(JSON.stringify(answer));
  const w=copy.value?.state?.workflow;
  if(w) {
    for(const event of w.events ?? []) {
      delete event.id;
      delete event.at;
    }
    for(const ship of w.shipments ?? [])
      for(const check of ship.rechecks ?? []) {
        delete check.at;
        delete check.resolvedAt;
      }
  }
  return copy;
}

test("actual TS price, freight and refresh decisions match staged Rust rules",()=>{
  const proc=spawnSync("cargo",["run","--quiet","--manifest-path",manifest,
    "--bin","parity_runner"],{cwd:root,encoding:"utf8",
    input:JSON.stringify(cases.map(({operation,payload})=>({operation,payload}))),
    maxBuffer:20*1024*1024,timeout:180000});
  if(proc.error)throw proc.error;
  assert.equal(proc.status,0,"Rust rules executable failed:\n"+proc.stderr);
  const results=JSON.parse(proc.stdout);
  assert.equal(results.length,cases.length);
  const failures=[];
  for(const [index,c] of cases.entries()){
    const actual = c.operation === "reconcile_workflow"
      ? wireReconcileResult(results[index]) : results[index];
    const expected = c.operation === "reconcile_workflow"
      ? wireReconcileResult(c.ts) : c.ts;
    try{assert.deepStrictEqual(actual,expected);}
    catch{failures.push({name:c.name,ts:expected,rust:actual});}
  }
  if(failures.length)console.error(JSON.stringify({
    cases:cases.length,mismatchCount:failures.length,mismatches:failures.slice(0,35),
  },null,2));
  assert.equal(failures.length,0,failures.length+" of "+cases.length+" rules parity cases differ");
});
