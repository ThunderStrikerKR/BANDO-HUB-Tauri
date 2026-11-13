/** Actual original TS orderHistory/original status vs compiled Rust rules. */
import test from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {tsImport} from "tsx/esm/api";
const {orderHistory,orderHistoryStatus}=await tsImport("../../../src/app/order-history.ts",import.meta.url);
const manifest=fileURLToPath(new URL("./Cargo.toml",import.meta.url));
const root=fileURLToPath(new URL("../../../",import.meta.url));
const clone=x=>structuredClone(x);
const cases=[];
const capture=fn=>{try{return {ok:true,value:JSON.parse(JSON.stringify(fn()))}}
  catch(error){return {ok:false,error:error.message||String(error)}}};
function base(){
  const client={id:"c1",name:"거래처 당시",tier:"wholesale",payment:"POSTPAID",
    shippingFeeExcluded:false,overrides:{},address:"서울",phone:"010-1234-5678"};
  const recipient={id:"r1",name:"김수하",address:"서울 강남구 1",
    phone:"010-1111-2222",mobile:"",actualFreight:null,
    items:[{id:"i1",productId:"p1",variantId:"v1",quantity:2,
      unitPrice:30000,name:"BD 709",origin:"FACTORY",issues:[]}]};
  const order={id:"o1",clientId:"c1",raw:"BD 709 x2",
    createdAt:"2026-11-12T22:00:00Z",confirmedAt:"2026-11-13T10:00:00+09:00",
    pricesLocked:true,clientSnapshot:clone(client),orderType:"AGENCY",
    recipients:[recipient],freightCode:"010",shippingFee:3000,
    applyVat:true,vatAmount:6300,status:"STATEMENT"};
  return {revision:3,orders:[order],clients:[{...clone(client),name:"변경 거래처"}],
    products:[],factoryReplies:[],settings:{accounts:[]},
    workflow:{shipments:[{id:"s1",orderId:"o1",recipientId:"r1",groupId:"g1",
      transferred:false,charges:{FACTORY:3000},tracking:{},actualFreight:{}}],
      queue:[],groups:[{id:"g1"}],payments:[],confirmations:[],events:[]}};
}
function exportRow(s,status="EXPORTED",origin="FACTORY"){
  s.workflow.shipments[0].transferred=true;
  s.workflow.queue=[{id:"q1",shipmentId:"s1",status,origin,
    snapshot:{subtotal:60000,shipping:3000,vat:6300,total:69300,
      recipient:clone(s.orders[0].recipients[0])}}];
}
function add(name,operation,state,query,date){
  const payload=operation==="order_history_status"?{state,orderId:"o1"}:{state,query,date};
  const fn=()=>operation==="order_history_status"
    ?{status:orderHistoryStatus(state,"o1")}:orderHistory(state,query,date);
  cases.push({name,operation,payload,expected:capture(fn)});
}
function scenario(name,change=()=>{},query="",date=""){
  const s=base();change(s);
  add(name+" rows","list_order_history",s,query,date);
  add(name+" status","order_history_status",s,query,date);
}
scenario("untransferred");
scenario("no queue",s=>s.workflow.shipments[0].transferred=true);
scenario("queued",s=>exportRow(s,"QUEUED"));
scenario("exported frozen",s=>exportRow(s));
scenario("applied factory reply",s=>{
  exportRow(s);s.workflow.shipments[0].tracking.FACTORY="001234567891";
  s.factoryReplies=[{rows:[{applied:true,shipmentId:"s1",tracking:"001234567891"}]}];
});
scenario("reply wrong waybill",s=>{
  exportRow(s);s.workflow.shipments[0].tracking.FACTORY="001234567891";
  s.factoryReplies=[{rows:[{applied:true,shipmentId:"s1",tracking:"001234567890"}]}];
});
scenario("reply not applied",s=>{
  exportRow(s);s.workflow.shipments[0].tracking.FACTORY="001234567891";
  s.factoryReplies=[{rows:[{applied:false,shipmentId:"s1",tracking:"001234567891"}]}];
});
scenario("store sent",s=>{
  s.orders[0].recipients[0].items[0].origin="STORE";
  s.workflow.shipments[0].charges={STORE:2500};
  exportRow(s,"STORE_SENT","STORE");
});
scenario("cancelled queue",s=>exportRow(s,"CANCELLED"));
scenario("unknown queue status",s=>exportRow(s,"UNKNOWN"));
scenario("legacy export no shipment",s=>{
  s.workflow.shipments=[];s.workflow.groups=[];s.orders[0].status="EXPORTED";
});
scenario("legacy no shipment",s=>{
  s.workflow.shipments=[];s.workflow.groups=[];delete s.orders[0].confirmedAt;
});
scenario("soft deleted",s=>s.orders[0].deletedAt="2026-11-14");
scenario("group deleted",s=>s.workflow.groups[0].deletedAt="2026-11-14");
scenario("archived shipment",s=>s.workflow.shipments[0].legacyArchived=true);
scenario("version1 unconfirmed draft",s=>{
  s.orders[0].receptionVersion=1;delete s.orders[0].confirmedAt;
});
scenario("historical client price locked",s=>{
  s.clients[0].payment="PREPAID";s.orders[0].clientSnapshot.name="당시 상호";
});
scenario("VAT off recipient",s=>s.orders[0].recipients[0].vatOverride=false);
scenario("freight collect",s=>s.orders[0].freightCode="020");
scenario("unknown price",s=>s.orders[0].recipients[0].items[0].unitPrice=null);
scenario("unknown shipment charges",s=>s.workflow.shipments[0].charges={});
scenario("frozen ignores edited order",s=>{
  exportRow(s);s.orders[0].recipients[0].items[0].unitPrice=99999;
});
scenario("latest recipient overrides frozen",s=>{
  exportRow(s);s.workflow.shipments[0].latestRecipient=clone(s.orders[0].recipients[0]);
});
scenario("two shipments",s=>{
  const r=clone(s.orders[0].recipients[0]);r.id="r2";r.items[0].id="i2";
  s.orders[0].recipients.push(r);
  s.workflow.shipments.push({...clone(s.workflow.shipments[0]),id:"s2",recipientId:"r2"});
});
scenario("one of two untransferred",s=>{
  exportRow(s);s.workflow.shipments.push({...clone(s.workflow.shipments[0]),
    id:"s2",transferred:false});
});
scenario("Seoul today",()=>{},"","2026-11-13");
scenario("Seoul other day",()=>{},"","2026-11-12");
scenario("search raw",()=>{},"709","");
scenario("search frozen dealer",()=>{},"거래처 당시","");
scenario("search mutated dealer",()=>{},"변경 거래처","");
scenario("search lowercase",s=>s.orders[0].raw="BD Desk TS","desk","");
scenario("missing dealer",s=>{
  s.clients=[];delete s.orders[0].clientSnapshot;s.orders[0].pricesLocked=false;
});
scenario("retail company party",s=>{
  s.orders[0].orderType="RETAIL";delete s.orders[0].clientSnapshot;
  s.settings.senderName="다른 송하인";s.settings.senderAddress="주소";
});
scenario("mixed active deleted group",s=>{
  s.workflow.shipments.push({...clone(s.workflow.shipments[0]),id:"s2",groupId:"g2"});
  s.workflow.groups.push({id:"g2",deletedAt:"2026-11-14"});
});
test("original TS order history and compiled Rust match every whole JSON result",()=>{
  const result=spawnSync("cargo",["run","--quiet","--manifest-path",manifest,
    "--bin","parity_runner"],{cwd:root,encoding:"utf8",
    input:JSON.stringify(cases.map(x=>({operation:x.operation,payload:x.payload}))),
    timeout:900000,maxBuffer:32*1024*1024});
  if(result.error)throw result.error;
  assert.equal(result.status,0,result.stderr);
  const answers=JSON.parse(result.stdout),diff=[];
  assert.equal(answers.length,cases.length);
  for(let i=0;i<cases.length;i++){
    try{assert.deepEqual(answers[i],cases[i].expected)}
    catch{diff.push({name:cases[i].name,ts:cases[i].expected,rust:answers[i]})}
  }
  if(diff.length)console.error(JSON.stringify({count:cases.length,diff:diff.slice(0,8)},null,2));
  assert.equal(diff.length,0,String(diff.length)+" of "+cases.length+" TS/Rust history cases differ");
});
