/**
 * Source of truth: actual TypeScript parseEvidence over the unchanged
 * 20 privacy-scrubbed orders. Rust is the subject, never the oracle.
 * This test intentionally compares each business field; passing only
 * recipients/quantities in the existing Rust regression is insufficient.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {tsImport} from "tsx/esm/api";

const repoRoot=fileURLToPath(new URL("../../../",import.meta.url));
const fixture=readFileSync(new URL("../../audit-20-order-samples.test.mjs",import.meta.url),"utf8");
const start=fixture.indexOf("const samples=[");
assert.ok(start>=0,"audit-20-order-samples original fixture unavailable");
const after=fixture.indexOf("\n];",start);
assert.ok(after>start);
const samples=JSON.parse(fixture.slice(start+"const samples=".length,after+2));
assert.equal(samples.length,20);
const state=JSON.parse(readFileSync(new URL("../../../src-tauri/resources/state-seed.json",import.meta.url),"utf8"));
const client={id:"ci-dealer",name:"가상거래처",tier:"wholesale",overrides:{},
  active:true,payment:"PREPAID",identifiers:"",shippingFeeExcluded:false};
const {parseEvidence}=await tsImport("../../../src/parser.ts",import.meta.url);

const requests=samples.map(x=>({operation:"analyze_order",payload:{
  raw:x.raw,client,state,
}}));
const rust=spawnSync("cargo",["run","--quiet","--manifest-path",
  fileURLToPath(new URL("./Cargo.toml",import.meta.url)),"--bin","parity_runner"],
{cwd:repoRoot,encoding:"utf8",input:JSON.stringify(requests),
  maxBuffer:24*1024*1024,timeout:720000});
if(rust.error)throw rust.error;
assert.equal(rust.status,0,"Rust recognition failed to execute:\n"+rust.stderr);
const results=JSON.parse(rust.stdout);
assert.equal(results.length,20);

function field(target,name){return Object.hasOwn(target,name)?target[name]:null;}
function shape(row){
  return {
    name:row.name??"",address:row.address??"",phone:row.phone??"",
    mobile:row.mobile??"",note:row.note??"",
    addressStatus:row.addressStatus??null,
    items:(row.items??[]).map(i=>({
      raw:i.raw??"",name:i.name??"",productId:i.productId??null,
      variantId:i.variantId??null,color:i.color??null,
      quantity:i.quantity??null,quantityConfirmed:i.quantityConfirmed??false,
      origin:i.origin??null,matchKind:i.match?.kind??null,
      issues:i.issues??[],
    })),
  };
}
function differences(want,got,path="$"){
  if(Array.isArray(want)||Array.isArray(got)){
    if(!Array.isArray(want)||!Array.isArray(got))return [{path,ts:want,rust:got}];
    const out=[];
    if(want.length!==got.length)out.push({path:path+".length",ts:want.length,rust:got.length});
    for(let i=0;i<Math.min(want.length,got.length);i++)out.push(...differences(want[i],got[i],path+"["+i+"]"));
    return out;
  }
  if(want&&got&&typeof want==="object"&&typeof got==="object"){
    return [...new Set([...Object.keys(want),...Object.keys(got)])]
      .flatMap(k=>differences(field(want,k),field(got,k),path+"."+k));
  }
  return Object.is(want,got)?[]:[{path,ts:want,rust:got}];
}
function sourceFaults(raw,out){
  const textUnits=Array.from(raw).reduce((sum,ch)=>sum+(ch.codePointAt(0)>0xffff?2:1),0);
  const faults=[];
  const sources=[
    ...(out.candidates??[]),
    ...(out.recipients??[]).flatMap(r=>[
      ...(r.sources??[]),
      ...(r.items??[]).flatMap(i=>i.sources??[]),
    ]),
  ];
  for(const c of sources){
    if(!Number.isInteger(c.start)||!Number.isInteger(c.end)
      ||c.start<0||c.end<c.start||c.end>textUnits){
      faults.push({path:"source.bounds",start:c.start,end:c.end});continue;
    }
    const span=Buffer.from(raw,"utf16le").subarray(c.start*2,c.end*2).toString("utf16le");
    if(span!==c.text)faults.push({path:"source.text",start:c.start,end:c.end,
      expected:span,actual:c.text});
  }
  return faults;
}
test("all 20 order fixtures: TypeScript parseEvidence functional fields equal real Rust",()=>{
  const failed=[],summary=[];
  samples.forEach((sample,i)=>{
    const ts=parseEvidence(sample.raw,client,state);
    const run=results[i];
    const diffs=run.ok?differences(ts.recipients.map(shape),run.value.recipients.map(shape),
      "recipients"):[{path:"execution",ts:"success",rust:run}];
    const offsets=run.ok?sourceFaults(sample.raw,run.value):[];
    const row={id:sample.id,label:sample.label,tsRecipients:ts.recipients.length,
      rustRecipients:run.ok?run.value.recipients.length:null,
      tsItems:ts.recipients.map(r=>r.items.length),
      rustItems:run.ok?run.value.recipients.map(r=>r.items.length):[],
      fieldDifferences:diffs.length,offsetFaults:offsets.length};
    summary.push(row);
    if(diffs.length||offsets.length)failed.push({
      ...row,differences:diffs.slice(0,35),offsets:offsets.slice(0,10),
    });
  });
  console.log("ORDER20_TS_RUST_SUMMARY "+JSON.stringify(summary));
  if(failed.length)console.error("ORDER20_TS_RUST_DIFF "+JSON.stringify(failed));
  assert.equal(failed.length,0,
    failed.length+" of 20 orders differ from the TypeScript original");
});
