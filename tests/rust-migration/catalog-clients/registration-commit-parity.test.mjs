/** Actual original prepareRegistrationCommit vs compiled Rust on business-shaped
 * snapshots, including audit, stale revision and historical product protection.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {tsImport} from "tsx/esm/api";
const {prepareRegistrationCommit}=await tsImport("../../../src/product-registration-xlsx.ts",import.meta.url);
const {productKey}=await tsImport("../../../src/product-models.ts",import.meta.url);
const manifest=fileURLToPath(new URL("./Cargo.toml",import.meta.url));
const root=fileURLToPath(new URL("../../../",import.meta.url));
const s=()=>({
  revision:11,clients:[],products:[],
  orders:[{id:"historical-order",confirmedAt:"2026-11-10",pricesLocked:true}],
  deletedProductKeys:[],registrationBatches:[],settings:{operatorName:"관리자"}
});
const product=(id="p1",name="BD 709 블랙 기본")=>({
  id,code:id,name,catalog:"BANDOSTAND",origin:"FACTORY",
  category:"반도스탠드 > 보면대",categories:["catalog-root:BANDOSTAND","leaf"],
  defaultColor:"Black",active:true,createdAt:"2026-11-13",updatedAt:"2026-11-13",
  variants:[{id:"v-"+id,color:"Black",option:"기본",source:"MANUAL",url:"",
    wholesale:10000,semi:12000,retail:15000}],
  specification:"",sellingUnit:"개",saleUnit:true,registrationIdentity:"identity-"+id,
  verificationStatus:"REGISTERED",familyKey:id,modelKey:"REG|identity-"+id,
});
const preview=(state,products=[product()])=>({
  fingerprint:"sha256-test",revision:state.revision,
  rows:products.map((p,i)=>({row:i+2,status:"READY",identity:"identity-"+p.id,
    errors:[],duplicateIds:[],values:{"최종 등록명":p.name},product:p})),
});
const trials=[];
function check(name,change=()=>{}){
  const state=s(),p=preview(state);
  const t={name,state,preview:p};
  change(t);
  let oracle;
  try{oracle={ok:true,value:prepareRegistrationCommit(t.state,t.preview,"검증 직원")}}
  catch(error){oracle={ok:false,error:error instanceof Error?error.message:String(error)}}
  trials.push({...t,oracle});
}
check("one independent registered product");
check("two distinct product rows",t=>{t.preview=preview(t.state,[product("p1"),product("p2","BD 708 블랙 기본")]);});
check("invalid rows skipped",t=>{
  t.preview.rows.push({row:3,status:"ERROR",values:{"최종 등록명":"미승인"},errors:["검증 필요"],duplicateIds:[],identity:"bad"});
});
check("hold and duplicate rows skipped",t=>{
  t.preview.rows.push({row:3,status:"HOLD",errors:["검토"],identity:"review",values:{}});
  t.preview.rows.push({row:4,status:"DUPLICATE",errors:[],duplicateIds:["p0"],values:{}});
});
check("stale source revision",t=>{t.preview.revision=10;});
check("all rows unapproved",t=>{t.preview.rows[0].status="HOLD";});
check("duplicate existing product",t=>{t.state.products=[product("old","BD 709 블랙 기본")];});
check("duplicate registration identity",t=>{
  const old=product("old","BD 709 블랙 기본");
  old.registrationIdentity=t.preview.rows[0].product.registrationIdentity;
  t.state.products=[old];
});
check("deleted product key blocks resurrection",t=>{
  t.state.deletedProductKeys=[productKey(t.preview.rows[0].product)];
});
check("archived identical product remains explicit duplicate",t=>{
  const prior=product("past","BD 709 블랙 기본");
  prior.deletedAt="2026-11-01";t.state.products=[prior];
});
check("special order locked prices remain immutable",t=>{
  t.state.orders[0].items=[{productId:"p1",variantId:"v-p1",unitPrice:22000}];
});
check("empty existing audit is not omitted",t=>{delete t.state.registrationBatches;});

function stable(value){
  const v=JSON.parse(JSON.stringify(value));
  if(!v.ok)return v;
  v.value.batch.id="RANDOM-BATCH-ID";
  v.value.batch.at="TIMESTAMP";
  for(const b of v.value.next.registrationBatches??[]){
    b.id="RANDOM-BATCH-ID";b.at="TIMESTAMP";
  }
  return v;
}
test("12 original TS registration commits match compiled Rust with immutable order and audit output",()=>{
  const cases=trials.map(t=>({operation:"prepare_registration_commit",payload:{
    state:t.state,preview:t.preview,actor:"검증 직원",
    batchId:"00000000-0000-4000-8000-000000000001",
    now:"2026-11-13T14:00:00.000Z",
  }}));
  const run=spawnSync("cargo",["run","--quiet","--manifest-path",manifest,
    "--bin","parity_runner"],{
    cwd:root,encoding:"utf8",input:JSON.stringify(cases),
    timeout:180000,maxBuffer:16*1024*1024
  });
  assert.equal(run.status,0,run.stderr||run.error?.message);
  const results=JSON.parse(run.stdout);
  results.forEach((result,i)=>assert.deepEqual(stable(result),stable(trials[i].oracle),
    trials[i].name+": native registration commit differs from original TypeScript"));
});
