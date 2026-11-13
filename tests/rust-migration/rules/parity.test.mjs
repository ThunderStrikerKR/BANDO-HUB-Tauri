/** Compare real src/domain.ts and src/shipping.ts directly against staged Rust rules. */
import test from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {tsImport} from "tsx/esm/api";
const {resolvePrice,totals,repriceOrder}=await tsImport("../../../src/domain.ts",import.meta.url);
const {shouldRefreshUncommittedOrderPricing}=await tsImport("../../../src/orders/passive-pricing.ts",import.meta.url);
const {recommendShipping}=await tsImport("../../../src/shipping.ts",import.meta.url);
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
    try{assert.deepStrictEqual(results[index],c.ts);}
    catch{failures.push({name:c.name,ts:c.ts,rust:results[index]});}
  }
  if(failures.length)console.error(JSON.stringify({
    cases:cases.length,mismatchCount:failures.length,mismatches:failures.slice(0,35),
  },null,2));
  assert.equal(failures.length,0,failures.length+" of "+cases.length+" rules parity cases differ");
});
