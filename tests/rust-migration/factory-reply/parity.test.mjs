/** Real original TS oracle compared against compiled Rust rules module.
 * This suite must never compare two reimplementations of the same logic.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {File} from "node:buffer";
import {tsImport} from "tsx/esm/api";
import ExcelJS from "exceljs";

const {previewFactoryReply,applyFactoryReplyPreview,parseFactoryReplyWorkbook}=
  await tsImport("../../../src/factory-reply-workbook.ts",import.meta.url);
const manifest=fileURLToPath(new URL("../rules/Cargo.toml",import.meta.url));
const root=fileURLToPath(new URL("../../../",import.meta.url));
const fixed="2026-11-13T11:00:00.000Z";
const clone=x=>structuredClone(x);
const cases=[];
function state(){
  const recipient={id:"r1",name:"박수하",address:"서울 서초구 123",
    phone:"02-1234-5678",mobile:"010-2222-4444",actualFreight:null,
    items:[{id:"i1",origin:"FACTORY",name:"709B",quantity:1}]};
  return {revision:5,products:[],clients:[],aliases:[],queue:[],exports:[],
    factoryReplies:[],settings:{operatorName:"직원",accounts:[]},
    orders:[{id:"o1",recipients:[clone(recipient)]}],
    workflow:{queue:[{id:"q1",shipmentId:"s1",origin:"FACTORY",
      status:"EXPORTED",snapshot:{recipient:clone(recipient)}}],
      shipments:[{id:"s1",recipientId:"r1",orderId:"o1",
        tracking:{},actualFreight:{},transferred:true}],
      events:[],payments:[],deliveries:[],groups:[],sources:[],changeRequests:[]}};
}
function reply(){
  return {id:"factory-reply-test",filename:"회신.xlsx",businessDate:"2026-11-13",
    at:fixed,actor:"직원",status:"REVIEW",
    rows:[{row:2,name:"박수하",address:"서울 서초구 123",
      contacts:["02-1234-5678","010-2222-4444"],
      tracking:"001234567890",actual:4000}]};
}
function capture(fn){
  try{return {ok:true,value:fn()}}
  catch(e){return {ok:false,error:e.message||String(e)}}
}
function normalized(result){
  const obj=clone(result);
  for(const event of obj.value?.next?.workflow?.events??[]){
    event.id="generated-id";
    if(event.action==="실제 출고 운임 입력")event.at="generated-time";
  }
  return obj;
}
function add(name,operation,payload,baseline){
  cases.push({name,operation,payload,expected:normalized(capture(baseline))});
}
function scenario(name,modify=()=>{}){
  const s=state(),r=reply();modify(s,r);
  add(name+" preview","preview_factory_reply",{state:s,reply:r},
    ()=>previewFactoryReply(s,r));
  const preview=capture(()=>previewFactoryReply(s,r));
  if(!preview.ok)return;
  const payload={state:s,preview:preview.value,freightAt:fixed,
    freightEventIds:r.rows.map((_,i)=>"freight-"+i),
    replyEventIds:r.rows.map((_,i)=>"reply-"+i)};
  add(name+" apply","apply_factory_reply",payload,
    ()=>applyFactoryReplyPreview(s,preview.value));
  if(name==="valid"){
    const altered=clone(preview.value);
    altered.rows[0].tracking="009999999999";
    add("tampered preview","apply_factory_reply",{...payload,preview:altered},
      ()=>applyFactoryReplyPreview(s,altered));
    const stale={...clone(s),revision:s.revision+1};
    add("stale revision","apply_factory_reply",{...payload,state:stale},
      ()=>applyFactoryReplyPreview(stale,preview.value));
  }
}
scenario("valid");
scenario("fullwidth and punctuation",(_,r)=>{
  r.rows[0].name="박 수하";r.rows[0].address="서울 서초구 １２３";
  r.rows[0].contacts=["02 (1234)-5678"];
});
scenario("wrong address",(_,r)=>{r.rows[0].address="서울 다른 구 9"});
scenario("wrong contact",(_,r)=>{r.rows[0].contacts=["010-0000-0000"]});
scenario("store queue",s=>{s.workflow.queue[0].origin="STORE"});
scenario("unexported queue",s=>{s.workflow.queue[0].status="QUEUED"});
scenario("two queue snapshots same shipment",s=>{
  s.workflow.queue.push({...clone(s.workflow.queue[0]),id:"q2"});
});
scenario("ambiguous multiple shipment ids",s=>{
  s.workflow.queue.push({...clone(s.workflow.queue[0]),id:"q2",shipmentId:"s2"});
});
scenario("previous exact result",s=>{
  s.workflow.shipments[0].tracking.FACTORY="001234567890";
  s.workflow.shipments[0].actualFreight.FACTORY=4000;
});
scenario("previous tracking conflicts",s=>{
  s.workflow.shipments[0].tracking.FACTORY="009988776655";
});
scenario("historical recipient actual conflicts",s=>{
  s.workflow.queue[0].snapshot.recipient.actualFreight=3500;
});
scenario("explicit null shipment actual overrides historical",s=>{
  s.workflow.queue[0].snapshot.recipient.actualFreight=3500;
  s.workflow.shipments[0].actualFreight.FACTORY=null;
});
scenario("current order amount matches while frozen snapshot unknown",s=>{
  s.orders[0].recipients[0].actualFreight=4000;
  s.workflow.queue[0].snapshot.recipient.actualFreight=null;
});
scenario("current order amount differs while frozen snapshot matches",s=>{
  s.orders[0].recipients[0].actualFreight=3500;
  s.workflow.queue[0].snapshot.recipient.actualFreight=4000;
});
scenario("explicit blank old tracking preserved in audit",s=>{
  s.workflow.shipments[0].tracking.FACTORY="";
});
scenario("other shipment has tracking",s=>{
  s.workflow.shipments.push({id:"s2",orderId:"o2",recipientId:"r2",
    tracking:{FACTORY:"001234567890"},actualFreight:{}});
});
scenario("second row same shipment",(_,r)=>{
  r.rows.push({...clone(r.rows[0]),row:3,tracking:"009999999999"});
});
scenario("preexisting issue",(_,r)=>{r.rows[0].issue="수하인 정보 확인 필요"});
scenario("no tracking",(_,r)=>{r.rows[0].tracking=""});
scenario("negative freight",(_,r)=>{r.rows[0].actual=-1});
scenario("duplicate file ID",s=>{s.factoryReplies.push(reply())});
scenario("missing factory item in original order",s=>{
  s.orders[0].recipients[0].items[0].origin="STORE";
});

const header=Array.from({length:17},(_,i)=>"로젠 열 "+(i+1));
function excelRow(){
  return ["박수하","","서울 서초구 123","02-1234-5678","010-2222-4444",
    "1","4,000","010","709B","","","송하인","","주소","전화","","001234567890"];
}
async function xlsx(name,rows){
  const book=new ExcelJS.Workbook();
  const sheet=book.addWorksheet("로젠");
  sheet.addRow(header);
  for(const row of rows)sheet.addRow(row);
  return new File([Buffer.from(await book.xlsx.writeBuffer())],name);
}
async function workbook(name,edit){
  const s=state(),data=[excelRow()];
  edit(s,data);
  const file=await xlsx(name+".xlsx",data);
  let reference;
  try{reference={ok:true,value:await parseFactoryReplyWorkbook(s,file)}}
  catch(e){reference={ok:false,error:e.message||String(e)}}
  const sourceRows=data.map((values,i)=>({
    row:i+2,name:String(values[0]??"").trim(),
    address:String(values[2]??"").trim(),
    phone:String(values[3]??"").trim(),mobile:String(values[4]??"").trim(),
    rawFreight:String(values[6]??"").trim(),tracking:String(values[16]??"").trim(),
    trackingNumeric:typeof values[16]==="number",
    reservedJ:values[9]!=null && String(values[9])!=="",
    extraAfterQ:values.slice(17).some(v=>v!=null&&String(v)!==""),
  }));
  cases.push({name:"actual XLSX "+name,operation:"analyze_factory_reply",
    payload:{state:s,sourceRows,sourceRowCount:data.length,
      id:reference.value?.reply.id??"factory-reply-pending",
      filename:file.name,businessDate:reference.value?.reply.businessDate??"2026-11-13",
      at:reference.value?.reply.at??fixed,actor:"직원"},
    expected:reference});
}
await workbook("normal",()=>{});
await workbook("duplicate waybill",(_,rows)=>rows.push(clone(rows[0])));
await workbook("missing Q",(_,rows)=>{rows[0][16]=""});
await workbook("missing recipient",(_,rows)=>{rows[0][0]=""});
await workbook("invalid freight",(_,rows)=>{rows[0][6]="4,00"});
await workbook("Q numeric",(_,rows)=>{rows[0][16]=123456789012});
await workbook("reserved J",(_,rows)=>{rows[0][9]="금지"});
await workbook("after Q",(_,rows)=>{rows[0][17]="추가"});
await workbook("unmatched",s=>{s.workflow.queue=[]});
await workbook("empty rows",(_,rows)=>rows.splice(0,1));

test("TS original Excel and matching decisions equal actual compiled Rust",()=>{
  const run=spawnSync("cargo",["run","--quiet","--manifest-path",manifest,
    "--bin","parity_runner"],{cwd:root,input:JSON.stringify(cases.map(c=>({
      operation:c.operation,payload:c.payload
    }))),encoding:"utf8",timeout:900000,maxBuffer:32*1024*1024});
  if(run.error)throw run.error;
  assert.equal(run.status,0,"Rust compilation or runner failed:\n"+run.stderr);
  const values=JSON.parse(run.stdout);
  assert.equal(values.length,cases.length);
  const mismatches=[];
  for(let i=0;i<cases.length;i++){
    try{assert.deepEqual(normalized(values[i]),normalized(cases[i].expected))}
    catch{mismatches.push({name:cases[i].name,
      expected:normalized(cases[i].expected),
      rust:normalized(values[i])});}
  }
  if(mismatches.length)console.error(JSON.stringify({
    count:cases.length,mismatches:mismatches.slice(0,12)},null,2));
  assert.equal(mismatches.length,0,
    String(mismatches.length)+" of "+cases.length+" TS/Rust parity cases differ");
});
