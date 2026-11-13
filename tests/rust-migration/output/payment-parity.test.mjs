/** Compare the real hubMessages payment text to Rust's rendering of the same resolved data. */
import test from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {tsImport} from "tsx/esm/api";
const {hubMessages}=await tsImport("../../../src/hub-messages.ts",import.meta.url);
const {totals}=await tsImport("../../../src/domain.ts",import.meta.url);
const {provisionalProductNotice}=await tsImport("../../../src/provisional-product-notices.ts",import.meta.url);
const manifest=fileURLToPath(new URL("./Cargo.toml",import.meta.url));
const root=fileURLToPath(new URL("../../../",import.meta.url));
const cases=[];
function makeState(){
  const client={id:"client-1",name:"거래처A",contact:"",tier:"wholesale",
    shippingFeeExcluded:false,payment:"PREPAID",active:true,identifiers:"",
    overrides:{},address:"서울시 강남구 1",phone:"02-1234-5678",mobile:""};
  const product={id:"p1",code:"709",name:"BD 709",category:"보면대",
    colorStatus:"KNOWN",origin:"FACTORY",active:true,defaultColor:"Black",
    variants:[{id:"v1",color:"Black",wholesale:50000,semi:55000,retail:60000,
      url:"https://www.bandostand.com/product/709"}]};
  const order={id:"o1",clientId:"client-1",raw:"가상 주문",orderType:"AGENCY",
    freightCode:"010",shippingFee:3000,applyVat:true,vatAmount:null,
    pricesLocked:false,status:"REVIEW",
    recipients:[{id:"r1",name:"김민수",address:"서울 강남구 1",addressStatus:"COMPLETE",
      phone:"010-1234-5678",mobile:"",note:"",
      items:[{id:"i1",productId:"p1",variantId:"v1",raw:"709",name:"709",
        color:"Black",quantity:2,unitPrice:50000,origin:"FACTORY",
        defaulted:false,quantityConfirmed:true,issues:[],
        url:"https://www.bandostand.com/product/709"}]}]};
  return {state:{clients:[client],products:[product],orders:[order],exports:[],
      settings:{operatorName:"직원",accounts:[{id:"a1",bank:"국민은행",
        number:"123-456",holder:"반도"}],defaultAccountId:"a1",
        provisionalProductNotices:{}},workflow:undefined},order};
}
function mapping(order,state,includeLinks) {
  const client=state.clients.find(c=>c.id===order.clientId);
  const recipients=order.recipients.map(r=>{
    const vat=r.vatOverride??r.vatDefault??order.applyVat;
    const code=r.freightCode??order.freightCode;
    const shippingFee=client.shippingFeeExcluded?0:r.shippingCharges
      ?Object.values(r.shippingCharges).every(v=>v!==null)
        ?Object.values(r.shippingCharges).reduce((n,v)=>n+(v??0),0):null
      :order.recipients.length===1?order.shippingFee:null;
    const price=totals({...order,recipients:[r],freightCode:code,applyVat:vat,
      shippingFee,pricesLocked:false,vatAmount:null},client);
    const items=r.items.map(i=>({
      ...i,
      amount:i.unitPrice!==null&&i.quantity!==null?i.unitPrice*i.quantity:null,
      colorNotRequired:state.products.find(p=>p.id===i.productId)?.colorStatus==="NOT_REQUIRED",
      provisionalNotice:provisionalProductNotice(i,state),
    }));
    return {name:r.name,freightCode:code,shipping:price.shipping,vat:price.vat,
      applyVat:vat,items,computedTotal:price.total};
  });
  const total=recipients.length&&recipients.every(r=>r.computedTotal!==null)
    ?recipients.reduce((n,r)=>n+r.computedTotal,0):null;
  return {mode:"payment",settings:state.settings,recipients,total,
    clientSelected:Boolean(client?.id),account:state.settings.accounts.find(a=>a.id==="a1"),
    includeLinks};
}
function add(name,mutate=()=>{},includeLinks=true) {
  const {order,state}=makeState();
  mutate(order,state);
  const payload=mapping(order,state,includeLinks);
  let oracle;
  try {
    const text=hubMessages(order,state,undefined,{payment:includeLinks,options:false});
    oracle={ok:true,value:{payment:text.payment,mixedVat:text.mixedVat}};
  } catch(error) {
    oracle={ok:false,error:error instanceof Error?error.message:String(error)};
  }
  cases.push({name,operation:"render_messages",payload,oracle});
}
add("single prepaid with VAT and link");
add("VAT excluded",o=>{o.applyVat=false;});
add("freight collect",o=>{o.freightCode="020";});
add("link disabled",()=>{},false);
add("color hidden",(o,s)=>{s.products[0].colorStatus="NOT_REQUIRED";});
add("default color notice",o=>{o.recipients[0].items[0].appliedDefaultColor={
  groupId:"c1",color:"Black"};});
add("representative model notice",o=>{o.recipients[0].items[0].appliedRepresentativeModel={
  groupId:"g1",productId:"p1",productName:"BD 709"};});
add("quantity one provisional",o=>{
  o.recipients[0].items[0].quantity=1;
  o.recipients[0].items[0].quantityApproval={quantity:1,actor:"직원",at:"2026-11-13"};
  o.recipients[0].items[0].quantityConfirmed=false;
});
add("custom payment template",(o,s)=>{
  s.settings.automaticMessageTemplates={paymentGreeting:"안녕하세요, 입금 안내드립니다.",
    paymentItem:"{상품명}: {금액} / 수량 {수량}"};
});
add("no default account",(o,s)=>{s.settings.accounts=[];});
add("mixed VAT two recipients",(o,s)=>{
  o.recipients[0].shippingCharges={FACTORY:3000};
  o.recipients.push({...structuredClone(o.recipients[0]),id:"r2",name:"박수취",
    vatOverride:false,shippingCharges:{FACTORY:4000},
    items:[{...structuredClone(o.recipients[0].items[0]),id:"i2",quantity:1}]});
});

test("real hubMessages.payment text is identical to Rust's resolved-input renderer",()=>{
  const result=spawnSync("cargo",["run","--quiet","--manifest-path",manifest,
    "--bin","parity_runner"],{cwd:root,encoding:"utf8",
    input:JSON.stringify(cases.map(({operation,payload})=>({operation,payload}))),
    maxBuffer:20*1024*1024,timeout:180000});
  if(result.error)throw result.error;
  assert.equal(result.status,0,result.stderr);
  const actual=JSON.parse(result.stdout),mismatches=[];
  assert.equal(actual.length,cases.length);
  cases.forEach((c,i)=>{
    try{assert.deepStrictEqual(actual[i],c.oracle);}
    catch{mismatches.push({name:c.name,ts:c.oracle,rust:actual[i]});}
  });
  if(mismatches.length)console.error(JSON.stringify({count:cases.length,
    mismatchCount:mismatches.length,mismatches},null,2));
  assert.equal(mismatches.length,0,mismatches.length+" of "+cases.length+" payment cases differ");
});
