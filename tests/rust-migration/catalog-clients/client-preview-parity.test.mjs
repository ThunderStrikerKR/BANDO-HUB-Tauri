/** Compiled Rust vs real, unmodified TypeScript previewClientRows oracle.
 * UUID differences are normalized; row order, statuses, full candidate fields,
 * error strings, collisions and missing-client count are compared verbatim.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {tsImport} from "tsx/esm/api";
const {previewClientRows}=await tsImport("../../../src/client-workbook.ts",import.meta.url);
const manifest=fileURLToPath(new URL("./Cargo.toml",import.meta.url));
const root=fileURLToPath(new URL("../../../",import.meta.url));
const base=()=>({
  revision:17,
  settings:{accounts:[{id:"bank-1",bank:"우리",holder:"반도",number:"123"}]},
  clients:[],products:[],orders:[{id:"locked-order",status:"EXPORTED"}],
});
const old=(id,name,phone="02-2222-3333")=>({
  id,name,address:"서울 종로구 1",postcode:"",phone,mobile:"",
  displayName:"",person:"",contact:"",identifiers:"",shortNames:"",
  tier:"wholesale",payment:"PREPAID",active:true,shippingFeeExcluded:false,
  defaultApplyVat:false,preferredAccountId:"bank-1",overrides:{v1:18500},
});
const cells=(id="",name="동네악기",phone="02-1111-2222")=>[
  id,name,"","서울 종로구 17","",phone,"","","","도매","선입금",
  "아니오","아니오","거래중","","","bank-1","사용",
];
const trials=[];
function add(name,edit=(state,rows)=>{}) {
  const state=base(),rows=[{row:2,cells:cells()}];
  edit(state,rows);
  const newIds=rows.map((row,i)=>row.cells[0]?.trim()?null:
    "00000000-0000-4000-8000-"+String(i+1).padStart(12,"0"));
  let oracle;
  try {oracle={ok:true,value:previewClientRows(state,state.revision,rows)}}
  catch(error){oracle={ok:false,error:error instanceof Error?error.message:String(error)}}
  trials.push({name,state,rows,newIds,sourceRevision:state.revision,oracle});
}
add("new valid client");
add("empty worksheet",(_,r)=>{r.length=0;});
add("all blank lines",(_,r)=>{r[0].cells=Array(18).fill("");});
add("sender address required",(_,r)=>{r[0].cells[3]="";});
add("phone or mobile required",(_,r)=>{r[0].cells[5]="";});
add("mobile alone accepted",(_,r)=>{r[0].cells[5]="";r[0].cells[6]="010-9876-1234";});
add("empty company name error",(_,r)=>{r[0].cells[1]="";});
add("invalid price tier error",(_,r)=>{r[0].cells[9]="vip";});
add("invalid payment method error",(_,r)=>{r[0].cells[10]="외상";});
add("invalid shipping flag error",(_,r)=>{r[0].cells[11]="혹시";});
add("invalid VAT flag error",(_,r)=>{r[0].cells[12]="모름";});
add("invalid activity flag error",(_,r)=>{r[0].cells[13]="가능";});
add("archival Excel flag forbidden",(_,r)=>{r[0].cells[13]="보관";});
add("archive status change forbidden",(_,r)=>{r[0].cells[17]="보관";});
add("account setting mismatch",(_,r)=>{r[0].cells[16]="bank-missing";});
add("excessive field length",(_,r)=>{r[0].cells[3]="가".repeat(351);});
add("new name matches existing", (s,r)=>{
  s.clients=[old("c1","동네악기","02-5555-4444")];
});
add("new telephone matches existing",(s,r)=>{
  s.clients=[old("c1","다른악기","02-1111-2222")];
});
add("phone normalization matches punctuation", (s,r)=>{
  s.clients=[old("c1","다른악기","0211112222")];
});
add("new client with same name within file",(_,r)=>{
  r.push({row:3,cells:cells("","동네악기","02-9000-1111")});
});
add("new client with same phone within file",(_,r)=>{
  r.push({row:3,cells:cells("","낯선악기","02-1111-2222")});
});
add("two distinct new clients",(_,r)=>{
  r.push({row:3,cells:cells("","옆집악기","02-9000-1111")});
});
add("update existing name preserves special prices",(s,r)=>{
  s.clients=[old("c1","원래악기")];r[0].cells=cells("c1","바뀐악기","02-2222-3333");
});
add("existing blank address cells preserve existing address",(s,r)=>{
  s.clients=[old("c1","원래악기")];r[0].cells=cells("c1","원래악기","02-2222-3333");r[0].cells[3]="";
});
add("existing explicit clearing required address rejected",(s,r)=>{
  s.clients=[old("c1","원래악기")];r[0].cells=cells("c1","원래악기","02-2222-3333");r[0].cells[3]="[비우기]";
});
add("existing explicit clearing optional field accepted",(s,r)=>{
  s.clients=[old("c1","원래악기")];s.clients[0].postcode="12345";
  r[0].cells=cells("c1","원래악기","02-2222-3333");r[0].cells[4]="[비우기]";
});
add("multiple conflicting IDs in same file",(s,r)=>{
  s.clients=[old("c1","원래악기")];r[0].cells=cells("c1","원래악기","02-2222-3333");
  r.push({row:3,cells:cells("c1","바뀐악기","02-2222-3333")});
});
add("unknown existing client ID rejected",(_,r)=>{
  r[0].cells[0]="not-registered";
});
add("archived existing client unchanged",(s,r)=>{
  const c=old("c1","원래악기");c.deletedAt="2026-11-10";s.clients=[c];
  r[0].cells=cells("c1","원래악기","02-2222-3333");r[0].cells[3]="";
  r[0].cells[17]="보관";
});
add("archived client modification rejected",(s,r)=>{
  const c=old("c1","원래악기");c.deletedAt="2026-11-10";s.clients=[c];
  r[0].cells=cells("c1","변경악기","02-2222-3333");r[0].cells[17]="보관";
});
add("existing stale missing address unchanged does not block",(s,r)=>{
  const c=old("c1","원래악기");c.address="";s.clients=[c];
  r[0].cells=Array(18).fill("");r[0].cells[0]="c1";
});
add("editing phone collides with another client",(s,r)=>{
  s.clients=[old("c1","원래악기"),old("c2","다른악기","02-4444-7777")];
  r[0].cells=cells("c1","원래악기","02-4444-7777");
});
add("two edited clients collide after file changes",(s,r)=>{
  s.clients=[old("c1","원래악기"),old("c2","다른악기","02-3333-6666")];
  r[0].cells=cells("c1","같은상호","02-2222-3333");
  r.push({row:3,cells:cells("c2","같은상호","02-3333-6666")});
});


add("distinct edited entries sharing a numeric row marker still collide",(s,r)=>{
  s.clients=[
    old("c1","기존A","02-1111-3333"),
    old("c2","기존B","02-2222-4444"),
  ];
  r[0].cells=cells("c1","변경된상호","02-1111-3333");
  r.push({row:2,cells:cells("c2","변경된상호","02-2222-4444")});
});
add("both edited rows must be checked even when row numbers repeat",(s,r)=>{
  s.clients=[
    old("c1","원래상호A","02-1111-3333"),
    old("c2","원래상호B","02-2222-4444"),
  ];
  r[0].cells=cells("c1","같은상호","02-1111-3333");
  r.push({row:2,cells:cells("c2","같은상호","02-2222-4444")});
  r.push({row:3,cells:cells("","새로운상호","02-7777-9999")});
});

function canonical(result,rows) {
  // JSON is the real Tauri IPC transport: undefined fields are omitted.
  const copy=JSON.parse(JSON.stringify(result));
  if(!copy.ok)return copy;
  for(const entry of copy.value.rows){
    const source=rows.find(row=>row.row===entry.row);
    if(source && !source.cells[0]?.trim()){
      if(entry.id)entry.id="UUID:"+entry.row;
      if(entry.client?.id)entry.client.id="UUID:"+entry.row;
    }
  }
  return copy;
}

test("actual TS and compiled Rust client preview match in every row, status and mutation",()=>{
  const cases=trials.map(x=>({operation:"preview_client_rows",payload:{
    state:x.state,sourceRevision:x.sourceRevision,input:x.rows,newIds:x.newIds,
  }}));
  cases.push({operation:"preview_client_rows",payload:{
    state:base(),sourceRevision:16,input:[],newIds:[],
  }});
  const run=spawnSync("cargo",["run","--quiet","--manifest-path",manifest,
    "--bin","parity_runner"],{cwd:root,encoding:"utf8",input:JSON.stringify(cases),
    maxBuffer:16*1024*1024,timeout:180000});
  assert.equal(run.status,0,run.stderr||run.error?.message);
  const output=JSON.parse(run.stdout);
  assert.equal(output.length,cases.length);
  trials.forEach((x,i)=>{
    const expected=canonical(x.oracle,x.rows);
    const actual=canonical(output[i],x.rows);
    assert.deepEqual(actual,expected,x.name+": native Rust differs from original TS");
  });
  assert.equal(output.at(-1).ok,false);
  assert.match(output.at(-1).error,/내려받은 이후 데이터가 바뀌었습니다/);
});
