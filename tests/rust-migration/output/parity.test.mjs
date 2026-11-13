/** Real TypeScript oracle compared against the compiled Rust output module. */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tsImport } from "tsx/esm/api";

const { previewFactoryExport } = await tsImport("../../../src/factory-export.ts", import.meta.url);
const { previewStoreExport } = await tsImport("../../../src/store-export.ts", import.meta.url);
const { dailySettlement } = await tsImport("../../../src/app/settlement-report.ts", import.meta.url);
const { AUTOMATIC_MESSAGE_TEMPLATES, renderAutomaticTemplate, validateAutomaticMessageTemplates } =
  await tsImport("../../../src/automatic-message-templates.ts", import.meta.url);

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const manifest = fileURLToPath(new URL("./Cargo.toml", import.meta.url));
const cases = [];
function capture(fn) {
  try { return {ok:true,value:fn()}; }
  catch (error) { return {ok:false,error:error instanceof Error ? error.message : String(error)}; }
}
function add(name,operation,payload,oracle) {
  cases.push({name,operation,payload,ts:capture(oracle)});
}
function base(origin) {
  return {
    revision:7,orders:[{id:"order-1",createdAt:"2026-11-13T08:00:00+09:00"}],
    exports:[],clients:[{id:"client-1",name:"거래처A"}],
    products:[{id:"product-1",name:"BD 709 타공 상판 가방 미포함",
      variants:[{id:"price-1",color:"블랙"}]}],
    workflow:{
      shipments:[{id:"shipment-1",orderId:"order-1",recipientId:"recipient-1",
        step:4,transferred:true,legacyArchived:false}],
      queue:[{id:"queue-1",shipmentId:"shipment-1",origin,status:"QUEUED",
        snapshot:{freightCode:"010",
          recipient:{id:"recipient-1",name:"김민수",address:"서울시 중구 3",
            phone:"02-111-2222",mobile:"",note:"문앞",
            items:[{id:"item-1",productId:"product-1",variantId:"price-1",
              origin,name:"BD 709 타공 상판 가방 미포함",color:"블랙",quantity:2}]},
          sender:{name:"대리점",displayName:"대리점 송장상호",address:"서울 강남구 9",
            phone:"02-333-4444",mobile:"",postcode:"04500"}}}],
      payments:[],confirmations:[],events:[],
    },
  };
}
for(const origin of ["FACTORY","STORE"]) {
  const operation=origin==="FACTORY"?"prepare_factory_export":"prepare_store_export";
  const oracle=origin==="FACTORY"?previewFactoryExport:previewStoreExport;
  function run(name,change=()=>{},ids=["queue-1"]) {
    const state=base(origin);change(state);
    add(origin+": "+name,operation,{state,ids},()=>oracle(state,ids));
  }
  run("normal");
  run("two products",s=>s.workflow.queue[0].snapshot.recipient.items.push({
    id:"item-2",productId:"product-1",variantId:"price-1",
    origin,name:"SS-1",color:"단일",quantity:1,
  }));
  run("missing recipient contact",s=>{s.workflow.queue[0].snapshot.recipient.phone="";});
  run("missing sender address",s=>{s.workflow.queue[0].snapshot.sender.address="";});
  run("wrong freight code",s=>{s.workflow.queue[0].snapshot.freightCode="999";});
  run("not transferred",s=>{s.workflow.shipments[0].transferred=false;});
  run("wrong workflow step",s=>{s.workflow.shipments[0].step=3;});
  run("archived shipment",s=>{s.workflow.shipments[0].legacyArchived=true;});
  run("missing order",s=>{s.orders=[];});
  run("deleted order",s=>{s.orders[0].deletedAt="2026-11-12";});
  run("wrong item origin",s=>{s.workflow.queue[0].snapshot.recipient.items[0].origin="OTHER";});
  run("missing quantity",s=>{s.workflow.queue[0].snapshot.recipient.items[0].quantity=null;});
  run("too large quantity",s=>{s.workflow.queue[0].snapshot.recipient.items[0].quantity=Number.MAX_SAFE_INTEGER+1;});
  run("prior export record",s=>{s.exports=[{queueEntryIds:["queue-1"]}];});
  run("other EXPORTED queue entry",s=>{s.workflow.queue.push({
    id:"queue-2",shipmentId:"shipment-1",origin,status:"EXPORTED",
  });});
  run("duplicate selection",()=>{},["queue-1","queue-1"]);
  run("missing queue selection",()=>{},["missing"]);
  run("empty selection",()=>{},[]);
  run("missing revision",s=>{delete s.revision;});
  run("whitespace sender display name",s=>{s.workflow.queue[0].snapshot.sender.displayName="  ";});
  if(origin==="STORE") {
    run("trailing whitespace on special color",s=>{
      s.workflow.queue[0].snapshot.recipient.items[0].color="단일 ";
    });
    run("trailing whitespace on normal color",s=>{
      s.workflow.queue[0].snapshot.recipient.items[0].color="블랙  ";
    });
  } else {
    run("unregistered product",s=>{s.products=[];});
    run("wrong variant ID",s=>{s.workflow.queue[0].snapshot.recipient.items[0].variantId="wrong";});
    run("missing product ID",s=>{s.workflow.queue[0].snapshot.recipient.items[0].productId=null;});
    run("bag configuration mismatch",s=>{
      s.workflow.queue[0].snapshot.recipient.items[0].name="BD 709 타공 상판 가방 포함";
    });
    run("board configuration mismatch",s=>{
      s.workflow.queue[0].snapshot.recipient.items[0].name="BD 709 비타공 상판 가방 미포함";
    });
    run("historical mapping valid",s=>{
      s.products[0].id="product-new";
      s.products[0].sourceProductId="product-1";
      s.productMappings={"product-1|price-1":"product-new"};
    });
    run("historical mapping invalid",s=>{
      s.products[0].id="product-new";
      s.products[0].sourceProductId="product-1";
      s.productMappings={"product-1|wrong":"product-new"};
    });
  }
}

const values={
  "수취인":"김민수","상품명":"BD 709","번호":"1","확인항목":"주소 확인",
  "색상":"블랙","수량":"2","금액":"5,000원","운임":"3,000원",
  "부가세":"500원","합계":"5,500원","은행명":"국민은행",
  "계좌번호":"12345","예금주":"반도",
};
const definitions=Object.entries(AUTOMATIC_MESSAGE_TEMPLATES);
for(const [key,template] of definitions) {
  add("template default: "+key,"render_messages",{
    mode:"template",templateId:key,settings:{},values,
  },()=>({text:renderAutomaticTemplate({},key,values)}));
  const edits={[key]:template.body+" 안내입니다."};
  add("template edited: "+key,"render_messages",{
    mode:"template",templateId:key,settings:{automaticMessageTemplates:edits},values,
  },()=>{
    validateAutomaticMessageTemplates(edits);
    return {text:renderAutomaticTemplate({automaticMessageTemplates:edits},key,values)};
  });
}
const invalid=[
  ["unknown key",{"NOT_A_TEMPLATE":"hello"}],
  ["unknown variable",{"modelConfirm":"{상품명} {없는변수}"}],
  ["missing required",{"paymentTotal":"총액 별도 문의"}],
  ["unclosed bracket",{"modelConfirm":"{상품명} {깨진"}],
  ["empty",{"modelConfirm":"   "}],
  ["non-string",{"modelConfirm":null}],
  ["UTF16 length",{"paymentGreeting":"😀".repeat(1001)}],
  ["too many keys",Object.fromEntries([...definitions.map(([k])=>[k,"x"]),["EXTRA","x"]])],
];
for(const [name,edits] of invalid) {
  add("template invalid: "+name,"render_messages",{
    mode:"validate_templates",settings:{automaticMessageTemplates:edits},
  },()=>{validateAutomaticMessageTemplates(edits);return {valid:true};});
}
add("template default validation","render_messages",{mode:"validate_templates",settings:{}},
  ()=>({valid:true}));

function settle(name,mutate=()=>{}) {
  const state=base("STORE");
  const date="2026-11-13";
  const historyRows=[{
    order:{id:"order-1",confirmedAt:"2026-11-13T10:00:00+09:00",
      createdAt:"2026-11-13T09:00:00+09:00",orderType:"AGENCY",paid:false,
      recipients:[{id:"recipient-1",actualFreight:3000,items:[{origin:"STORE"}]}]},
    client:{name:"거래처A",payment:"PREPAID"},
    billing:{subtotal:100000,shipping:3000,vat:0,total:103000},
    shipmentIds:["shipment-1"],status:"엑셀 추출 대기",
  }];
  const payload={state,date,historyRows};
  mutate(payload);
  add("settlement: "+name,"prepare_settlement",payload,
    ()=>dailySettlement(payload.state,payload.date,payload.historyRows));
}
settle("normal");
settle("unknown actual freight",p=>{delete p.historyRows[0].order.recipients[0].actualFreight;});
settle("postpaid",p=>{p.historyRows[0].client.payment="POSTPAID";});
settle("retail",p=>{p.historyRows[0].order.orderType="RETAIL";});
settle("unknown total",p=>{p.historyRows[0].billing.total=null;});
settle("legacy date",p=>{delete p.historyRows[0].order.confirmedAt;});
settle("same day bank receipt",p=>{p.state.workflow.payments=[{
  id:"payment-1",dealerId:"client-1",paidAt:"2026-11-13T11:00:00+09:00",
  account:{bank:"국민",holder:"반도",number:"12345"},
  amount:50000,allocations:[{id:"alloc-1",shipmentId:"shipment-1",amount:50000}],memo:"",
}];});
settle("UTC receipt crosses Seoul midnight",p=>{p.state.workflow.payments=[{
  id:"payment-1",dealerId:"client-1",paidAt:"2026-11-12T16:00:00Z",
  account:{bank:"국민",holder:"반도",number:"12345"},
  amount:50000,allocations:[],memo:"",
}];});
settle("invalid calendar date",p=>{p.date="2026-02-30";});
settle("overallocated receipt",p=>{p.state.workflow.payments=[{
  id:"payment-1",dealerId:"client-1",paidAt:"2026-11-13T11:00:00+09:00",
  account:{bank:"국민",holder:"반도",number:"12345"},
  amount:1000,allocations:[{shipmentId:"shipment-1",amount:5000}],memo:"",
}];});
settle("duplicate payment record",p=>{
  const item={id:"dup",dealerId:"client-1",paidAt:"2026-11-13T11:00:00+09:00",
    account:{bank:"국민",holder:"반도",number:"12345"},amount:1000,allocations:[],memo:""};
  p.state.workflow.payments=[item,structuredClone(item)];
});

test("TypeScript reference and Rust output engine have identical outcomes",()=>{
  const child=spawnSync("cargo",["run","--quiet","--manifest-path",manifest,
    "--bin","parity_runner"],{
    cwd:repoRoot,input:JSON.stringify(cases.map(({operation,payload})=>({operation,payload}))),
    encoding:"utf8",maxBuffer:20*1024*1024,timeout:180000,
  });
  if(child.error)throw child.error;
  assert.equal(child.status,0,"Rust parity runner failed:\n"+child.stderr);
  const results=JSON.parse(child.stdout);
  assert.equal(results.length,cases.length);
  const discrepancies=[];
  for(const [i,record] of cases.entries()){
    try{assert.deepStrictEqual(results[i],record.ts);}
    catch{discrepancies.push({name:record.name,ts:record.ts,rust:results[i]});}
  }
  if(discrepancies.length)console.error(JSON.stringify({
    sampleCount:cases.length,mismatchCount:discrepancies.length,
    mismatches:discrepancies.slice(0,35),
  },null,2));
  assert.equal(discrepancies.length,0,
    discrepancies.length+" of "+cases.length+" TS/Rust parity cases differ");
});
