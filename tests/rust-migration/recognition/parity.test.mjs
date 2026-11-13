/**
 * True TS/Rust differential: invoke real parseEvidence() and real Rust engine
 * on the 20 original privacy-scrubbed order cases and original catalog seed.
 * The TS oracle's own pre-existing failures are reported separately; parity
 * does not imply the oracle is correct.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tsImport } from "tsx/esm/api";

const root=fileURLToPath(new URL("../../../",import.meta.url));
const manifest=fileURLToPath(new URL("./Cargo.toml",import.meta.url));
const fixtureFile=new URL("../../audit-20-order-samples.test.mjs",import.meta.url);
const fixture=readFileSync(fixtureFile,"utf8");
const start=fixture.indexOf("const samples=")+"const samples=".length;
const end=fixture.indexOf("\n];",start)+2;
assert.ok(start>15 && end>start,"20-case fixture syntax changed");
const samples=JSON.parse(fixture.slice(start,end));
assert.equal(samples.length,20);
const state=JSON.parse(readFileSync(new URL("../../../src-tauri/resources/state-seed.json",import.meta.url),"utf8"));
const client={id:"ci-dealer",name:"가상거래처",tier:"wholesale",overrides:{},
  active:true,payment:"PREPAID",identifiers:"",shippingFeeExcluded:false};
const {parseEvidence}=await tsImport("../../../src/parser.ts",import.meta.url);

function property(x,key){return x?.[key]??null;}
function sourceProjection(s){return {field:property(s,"field"),
  text:property(s,"text"),start:property(s,"start"),end:property(s,"end")};}
function candidateProjection(c){return {kind:property(c,"kind"),
  text:property(c,"text"),value:property(c,"value"),
  start:property(c,"start"),end:property(c,"end")};}
function productCandidateProjection(c){return {
  label:property(c,"label"),productId:property(c,"productId"),
  variantId:property(c,"variantId"),start:property(c,"start"),end:property(c,"end")
};}
function normalized(out){
  if(!out.ok)return out;
  const result=out.value;
  return {ok:true,value:{
    candidates:(result.candidates??[]).map(candidateProjection),
    recipients:(result.recipients??[]).map(r=>({
      name:property(r,"name"),address:property(r,"address"),
      phone:property(r,"phone"),mobile:property(r,"mobile"),note:property(r,"note"),
      addressStatus:property(r,"addressStatus"),addressKind:property(r,"addressKind"),
      addressParts:property(r,"addressParts"),
      sources:(r.sources??[]).map(sourceProjection),
      items:(r.items??[]).map(i=>({
        raw:property(i,"raw"),name:property(i,"name"),quantity:property(i,"quantity"),
        quantityConfirmed:property(i,"quantityConfirmed"),
        productId:property(i,"productId"),variantId:property(i,"variantId"),
        color:property(i,"color"),origin:property(i,"origin"),
        unitPrice:property(i,"unitPrice"),url:property(i,"url"),
        catalog:property(i,"catalog"),defaulted:property(i,"defaulted"),
        recognitionReason:property(i,"recognitionReason"),
        match:i.match?{kind:property(i.match,"kind"),term:property(i.match,"term"),
          productIds:i.match.productIds??[],aliasId:property(i.match,"aliasId")}:null,
        issues:i.issues??[],
        sources:(i.sources??[]).map(sourceProjection),
        productCandidates:(i.productCandidates??[]).map(productCandidateProjection),
      })),
    })),
  }};
}
function catchResult(callback) {
  try{return {ok:true,value:callback()};}
  catch(e){return {ok:false,error:e instanceof Error?e.message:String(e)};}
}
function projectionDiff(a,b) {
  const result=[];
  const walk=(left,right,path)=>{
    if(JSON.stringify(left)===JSON.stringify(right))return;
    if(Array.isArray(left)&&Array.isArray(right)){
      if(left.length!==right.length)result.push({path:path+".length",ts:left.length,rust:right.length});
      for(let i=0;i<Math.min(left.length,right.length);i++)walk(left[i],right[i],path+"["+i+"]");
    }else if(left&&right&&typeof left==="object"&&typeof right==="object"){
      for(const key of new Set([...Object.keys(left),...Object.keys(right)]))
        walk(left[key],right[key],path+"."+key);
    }else if(left!==right)result.push({path,ts:left??null,rust:right??null});
  };
  walk(a,b,"");
  return result;
}
function inspectSpans(result,raw) {
  if(!result?.ok)return [];
  const errors=[], units=Array.from(raw);
  const chars=raw.split("");
  const check=(source,desc)=>{
    const start=source?.start,end=source?.end;
    if(!Number.isInteger(start)||!Number.isInteger(end)||start<0||end>raw.length||end<start){
      errors.push({desc,error:"invalid UTF16 range",start,end});return;
    }
    const actual=chars.slice(start,end).join("");
    if(source.text!==actual)errors.push({desc,error:"span differs from raw",expected:actual,got:source.text});
  };
  for(const [index,c] of (result.value.candidates??[]).entries())check(c,"candidate "+index);
  for(const [ri,r] of (result.value.recipients??[]).entries()){
    for(const [si,s] of (r.sources??[]).entries())check(s,"recipient "+ri+" source "+si);
    for(const [ii,i] of (r.items??[]).entries())
      for(const [si,s] of (i.sources??[]).entries())check(s,"item "+ri+"/"+ii+" source "+si);
  }
  return errors;
}

test("20 actual orders: TS oracle and Rust parser produce identical business fields",()=>{
  const requests=samples.map(s=>({operation:"analyze_order",
    payload:{raw:s.raw,state,client}}));
  const proc=spawnSync("cargo",["run","--quiet","--manifest-path",manifest,
    "--bin","parity_runner"],{
    cwd:root,input:JSON.stringify(requests),encoding:"utf8",timeout:900000,
    maxBuffer:50*1024*1024,
  });
  if(proc.error)throw proc.error;
  assert.equal(proc.status,0,"Rust runner build failed:\n"+proc.stderr);
  const rust=JSON.parse(proc.stdout);
  assert.equal(rust.length,20);
  const summary=[],discrepancies=[],baselineFailures=[],spans=[],baselineExceptions=[];
  samples.forEach((s,i)=>{
    const ts=catchResult(()=>parseEvidence(s.raw,client,state));
    const t=normalized(ts),r=normalized(rust[i]);
    const fields=projectionDiff(t,r);
    const tsRecipients=ts.ok?ts.value.recipients??[]:[];
    const quantity=tsRecipients.flatMap(r=>(r.items??[]).map(i=>i.quantity));
    const basicOkay=ts.ok && tsRecipients.length===s.expectedRecipients &&
      JSON.stringify(quantity.map(String).sort())===
        JSON.stringify(s.expectedQuantities.map(String).sort());
    if(!basicOkay)baselineFailures.push({id:s.id,label:s.label,
      expectedRecipients:s.expectedRecipients,gotRecipients:tsRecipients.length,
      expectedQuantities:s.expectedQuantities,gotQuantities:quantity});
    const badSpans=inspectSpans(rust[i],s.raw);
    if(badSpans.length)spans.push({id:s.id,problems:badSpans.slice(0,10)});
    // The source TypeScript is the behavioral oracle except for documented
    // baseline defects. Do not regress Rust to reproduce phantom orders:
    // 2: TS truncates "예수아님" into the recipient's name ("예수아").
    // 19: TS converts the order date into a product and loses BB-3 quantity.
    // 20: TS creates "발주일" recipient and a false 2026-11-03 product.
    // Those three cases use independent business assertions below.
    const knownSourceDefect = [2,19,20].includes(s.id);
    if(knownSourceDefect) {
      assert.equal(rust[i].ok,true,"Rust parser must not panic on known bad TS fixtures");
      const rows=rust[i].value.recipients;
      const expectedName=({2:"김가상",19:"여가상",20:"이가상"})[s.id];
      assert.equal(rows.length,1,"Only one legitimate delivery in original fixture "+s.id);
      assert.equal(rows[0].name,expectedName,"Correct human recipient in fixture "+s.id);
      assert.equal(rows[0].items.length,s.id===19||s.id===20?1:rows[0].items.length,
        "Do not create an order-date product or freight item");
      if(s.id===19||s.id===20){
        assert.equal(rows[0].items[0].quantity,1,"Original product quantity must be preserved");
        assert.equal(rows[0].items[0].quantityConfirmed,true);
        assert.ok(rows[0].items[0].productId,"Original real SKU must remain linked");
        assert.ok(rows[0].address&&Boolean(rows[0].phone||rows[0].mobile),
          "Real recipient contact and destination must survive the tabular input");
      }
      if(fields.length)baselineExceptions.push({id:s.id,label:s.label,
        reason:s.id===2?"TS recipient name truncates a suffix":
          "TS misreads the order date as a product/recipient",
        fields:fields.slice(0,30)});
    } else if(fields.length)discrepancies.push({id:s.id,label:s.label,fields:fields.slice(0,50),
      fieldCount:fields.length,
      tsIssues:ts.ok?ts.value.recipients.flatMap(row=>row.items.flatMap(item=>item.issues??[])):[],
      rustIssues:rust[i].ok?rust[i].value.recipients.flatMap(row=>row.items.flatMap(item=>item.issues??[])):[],
    });
    summary.push({id:s.id,tsRecipients:tsRecipients.length,
      rustRecipients:rust[i].ok?rust[i].value.recipients?.length:null,
      differences:fields.length,spanErrors:badSpans.length,tsBaselinePass:basicOkay});
  });
  console.log("20-order differential summary:",JSON.stringify({
    summary,baselineFailures,mismatchCount:discrepancies.length,
    mismatches:discrepancies,documentedSourceDefects:baselineExceptions,
    invalidRustSpans:spans,
  },null,2));
  assert.equal(spans.length,0,"Rust returned invalid UTF-16 source spans");
  assert.equal(discrepancies.length,0,"TS/Rust business projections differ for "+discrepancies.length+" of 20 source orders");
});
