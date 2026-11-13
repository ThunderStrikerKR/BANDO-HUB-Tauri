/** Compare production TypeScript validation with compiled Rust. */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tsImport } from "tsx/esm/api";

const {validateProduct}=await tsImport("../../../src/domain.ts",import.meta.url);
const {registeredProducts}=await tsImport("../../../src/product-models.ts",import.meta.url);
const {previewClientRows,applyClientWorkbook}=await tsImport("../../../src/client-workbook.ts",import.meta.url);
const {applyProductSyncWorkbook}=await tsImport("../../../src/product-sync-workbook.ts",import.meta.url);
const manifest=fileURLToPath(new URL("./Cargo.toml",import.meta.url));
const root=fileURLToPath(new URL("../../../",import.meta.url));
const fixture=()=>({
  revision:7, clients:[], products:[],
  orders:[{id:"historic-order",status:"EXPORTED"}],
  settings:{accounts:[{id:"account-1"}]},
});
const product=()=>({
  id:"p-1",code:"p-1",name:"BD 709 타공",category:"보면대",
  origin:"FACTORY",defaultColor:"Black",active:true,
  createdAt:"2026-11-13T12:00:00Z",updatedAt:"2026-11-13T12:00:00Z",
  catalog:"BANDOSTAND",
  variants:[{id:"v-1",color:"블랙",source:"MANUAL",url:"",
    wholesale:10000,semi:12000,retail:15000}],
});
const candidates=[],original=[];
function sampleProduct(name,mutate=()=>{}) {
  const state=fixture(),p=product();
  mutate(state,p);
  let oracle;
  try {
    validateProduct(p,registeredProducts(state.products));
    oracle={ok:true};
  } catch(error) {
    oracle={ok:false,error:error instanceof Error?error.message:String(error)};
  }
  candidates.push({operation:"validate_product",payload:{state,product:p}});
  original.push({name,oracle});
}
sampleProduct("baseline product, Korean Black equivalence");
sampleProduct("same name duplicate NFKC normalization",(s,p)=>{
  s.products.push(product());p.id="p-2";p.code="p-2";p.name="ＢＤ ７０９ 타공";
});
sampleProduct("inactive duplicate excluded",(s,p)=>{
  const old=product();old.active=false;s.products.push(old);
  p.id="p-2";p.code="p-2";
});
sampleProduct("archived duplicate excluded",(s,p)=>{
  const old=product();old.deletedAt="2026-11-10";s.products.push(old);
  p.id="p-2";p.code="p-2";
});
sampleProduct("different catalog duplicate allowed",(s,p)=>{
  s.products.push(product());p.id="p-2";p.code="p-2";p.catalog="BANDOMALL";
});
sampleProduct("editing same id bypasses new duplicate checking",(s,p)=>{
  s.products.push(product());p.name="BD 709 타공 수정";
});
sampleProduct("default color does not exist",(_,p)=>{p.defaultColor="Rose Gold";});
sampleProduct("official HTTPS product link",(_,p)=>{
  p.variants[0].url="https://www.bandostand.com/product/709?x=1";
});
sampleProduct("untrusted HTTPS domain",(_,p)=>{
  p.variants[0].url="https://example.com/product/709";
});
sampleProduct("official domain wrong HTTP scheme",(_,p)=>{
  p.variants[0].url="http://www.bandostand.com/product/709";
});
sampleProduct("official domain invalid path",(_,p)=>{
  p.variants[0].url="https://www.bandostand.com/contact";
});
sampleProduct("zero price accepted",(_,p)=>{p.variants[0].retail=0;});
sampleProduct("negative price rejected",(_,p)=>{p.variants[0].retail=-1;});
sampleProduct("out of JS safe range rejected",(_,p)=>{
  p.variants[0].retail=Number.MAX_SAFE_INTEGER+1;
});
sampleProduct("null price accepted",(_,p)=>{p.variants[0].retail=null;});
sampleProduct("missing price rejected",(_,p)=>{delete p.variants[0].retail;});
sampleProduct("two sale configurations rejected",(_,p)=>{
  p.variants.push({...p.variants[0],id:"v-2"});
});
sampleProduct("no sale configuration rejected",(_,p)=>{p.variants=[];});
sampleProduct("invalid source rejected",(_,p)=>{p.variants[0].source="MISSING";});
sampleProduct("empty product name rejected",(_,p)=>{p.name="";});
sampleProduct("invalid product origin rejected",(_,p)=>{p.origin="WAREHOUSE";});
sampleProduct("retail outlet independent product",(_,p)=>{p.origin="STORE";p.catalog="BANDOMALL";});

function sampleClient(name,cells,mutate=()=>{}) {
  const state=fixture();
  mutate(state);
  const preview=previewClientRows(state,state.revision,[{row:2,cells}]);
  const row=preview.rows[0];
  assert.ok(row.client,name+": original TypeScript must build a candidate");
  const oracle={ok:["ADD","UPDATE","UNCHANGED"].includes(row.status),
    status:row.status,errors:row.errors};
  candidates.push({operation:"validate_client",payload:{state,client:row.client}});
  original.push({name,oracle});
}
const clientCells=(name="예시악기",address="서울 종로구 1",phone="02-1234-5678")=>[
  "",name,"",address,"",phone,"","","","도매","선입금","아니오","아니오",
  "거래중","","","account-1","사용",
];
sampleClient("new client with valid sender fields",clientCells());
sampleClient("client without name",clientCells("","서울 종로구 1","02-1234-5678"));
sampleClient("client without sender address",clientCells("예시악기","","02-1234-5678"));
sampleClient("client without phone or mobile",clientCells("예시악기","서울 종로구 1",""));
sampleClient("client with mobile instead of landline",(()=>{
  const row=clientCells("예시악기","서울 종로구 1","");
  row[6]="010-1234-5678";return row;
})());
sampleClient("client with account missing from settings",clientCells(),(s)=>{
  s.settings.accounts=[];
});
sampleClient("client name with whitespace accepted",clientCells(" 예시악기 "));
sampleClient("existing client changed with original account",(()=>{
  const row=clientCells("변경악기");row[0]="c-1";return row;
})(),(s)=>{
  s.clients=[{id:"c-1",name:"예시악기",address:"서울 종로구 1",
    phone:"02-1234-5678",mobile:"",contact:"",identifiers:"",tier:"wholesale",
    payment:"PREPAID",active:true,shippingFeeExcluded:false,
    preferredAccountId:"account-1",overrides:{}}];
});


function sampleApply(name,operation,state,preview,oracleFn) {
  let oracle;
  try { oracle={ok:true,value:oracleFn(state,preview)}; }
  catch(error) { oracle={ok:false,error:error instanceof Error?error.message:String(error)}; }
  candidates.push({operation,payload:{state,preview}});
  original.push({name,oracle});
}
{
  const state=fixture();
  const preview=previewClientRows(state,state.revision,[{row:2,cells:clientCells()}]);
  sampleApply("add approved client Excel", "apply_client_workbook",state,preview,applyClientWorkbook);
  sampleApply("reject stale client Excel", "apply_client_workbook",
    {...state,revision:8},preview,applyClientWorkbook);
  sampleApply("reject held client Excel", "apply_client_workbook",
    state,{...preview,rows:[{...preview.rows[0],status:"HOLD"}]},applyClientWorkbook);
}
{
  const state=fixture();
  const approved={
    revision:state.revision,products:[product()],rows:[{sheet:"상품 목록",
      row:2,id:"p-1",name:"BD 709 타공",status:"ADD",changes:[],errors:[]}],
    missingProducts:0,missingOptions:0,
    createdProducts:1,updatedProducts:0,createdOptions:1,updatedOptions:0,
  };
  sampleApply("add approved product Excel", "apply_product_workbook",
    state,approved,applyProductSyncWorkbook);
  sampleApply("reject stale product Excel", "apply_product_workbook",
    {...state,revision:8},approved,applyProductSyncWorkbook);
  sampleApply("reject held product Excel", "apply_product_workbook",
    state,{...approved,rows:[{...approved.rows[0],status:"HOLD"}]},applyProductSyncWorkbook);
  // Existing products and immutable order snapshots are untouched when the
  // approved workbook updates only a single product price.
  const older=fixture();older.products=[product()];
  const replacement=structuredClone(older.products[0]);
  replacement.variants[0].retail=17000;
  sampleApply("update price without rewriting historical orders", "apply_product_workbook",
    older,{...approved,products:[replacement],rows:[{...approved.rows[0],status:"UPDATE"}],
      createdProducts:0,updatedProducts:1,createdOptions:0,updatedOptions:1},
    applyProductSyncWorkbook);
}

test("real TypeScript management rules match compiled Rust for product/client validity",()=>{
  const run=spawnSync("cargo",["run","--quiet","--manifest-path",manifest,
    "--bin","parity_runner"],{
    cwd:root,encoding:"utf8",input:JSON.stringify(candidates),
    maxBuffer:16*1024*1024,timeout:180000,
  });
  assert.equal(run.status,0,run.stderr||run.error?.message);
  const results=JSON.parse(run.stdout);
  assert.equal(results.length,original.length);
  for(let i=0;i<results.length;i++) {
    const {name,oracle}=original[i],rust=results[i];
    assert.equal(rust.ok,oracle.ok,
      name+": original TS = "+JSON.stringify(oracle)+", Rust = "+JSON.stringify(rust));
    if(rust.ok) {
      if(candidates[i].operation.startsWith("validate_")) assert.equal(rust.value.valid,true,name);
      else assert.deepEqual(rust.value,oracle.value,name);
    }
    if(!rust.ok && /같은 상품명|상품 색상|상품 링크/.test(oracle.error??"")){
      assert.equal(rust.error,oracle.error,name);
    }
    if(!rust.ok && candidates[i].operation.startsWith("apply_")){
      assert.equal(rust.error,oracle.error,name);
    }
  }
});
