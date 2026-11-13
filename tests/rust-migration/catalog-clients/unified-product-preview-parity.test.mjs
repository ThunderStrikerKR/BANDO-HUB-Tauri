import test from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {tsImport} from "tsx/esm/api";
const {previewUnifiedProductRows}=await tsImport("../../../src/product-unified-workbook.ts",import.meta.url);
const manifest=fileURLToPath(new URL("./Cargo.toml",import.meta.url));
const root=fileURLToPath(new URL("../../../",import.meta.url));
const product=()=>({
  id:"p1",code:"p1",name:"BD 709 블랙 기본",subtitle:"",
  catalog:"BANDOSTAND",origin:"FACTORY",category:"보면대",categories:["leaf"],
  defaultColor:"Black",active:true,saleUnit:true,
  createdAt:"2026-11-01T00:00:00Z",updatedAt:"2026-11-01T00:00:00Z",
  variants:[{id:"v1",color:"Black",option:"",source:"MANUAL",
    wholesale:10000,semi:12000,retail:15000,url:"",siteOptionId:""}]
});
const state=()=>({revision:6,products:[product()],orders:[{id:"old-order"}],
  clients:[],categories:[{id:"leaf",name:"보면대",parentId:null,active:true}],
  brands:[]});
const existing=()=>["p1","","BD 709 블랙 기본","","Black",
  "10000","12000","15000","반도스탠드","공장","leaf","","","","사용",
  "정상","v1","","MANUAL",""];
const fresh=()=>["","NEW1","BD 708 블랙 기본","","Black",
  "22000","24000","26000","반도스탠드","공장","leaf","","","","사용",
  "정상","","","",""];
const cases=[];
function add(name,change=()=>{}) {
  const st=state(),input={revision:st.revision,rows:[{row:2,cells:existing()}]};
  const fixture={name,state:st,input};
  change(fixture);
  let oracle;
  try{oracle={ok:true,value:previewUnifiedProductRows(st,input)}}
  catch(error){oracle={ok:false,error:error instanceof Error?error.message:String(error)}}
  cases.push({...fixture,oracle});
}
add("unchanged complete row");
add("existing retail edit",t=>{t.input.rows[0].cells[7]="17000";});
add("existing name and price edit",t=>{
  t.input.rows[0].cells[2]="BD 709 블랙 비타공";t.input.rows[0].cells[7]="17000";
});
add("existing optional description edit",t=>{t.input.rows[0].cells[3]="설명 교체";});
add("empty price requested",t=>{t.input.rows[0].cells[7]="[비우기]";});
add("wrong origin in same row",t=>{t.input.rows[0].cells[9]="매장";});
add("new product with exactly one price",t=>{t.input.rows.push({row:3,cells:fresh()});});
add("new missing price color",t=>{
  const row=fresh();row[4]="";t.input.rows.push({row:3,cells:row});
});
add("new duplicate name",t=>{
  const row=fresh();row[2]="BD 709 블랙 기본";t.input.rows.push({row:3,cells:row});
});
add("two new products with same name",t=>{
  t.input.rows.push({row:3,cells:fresh()});
  const other=fresh();other[1]="NEW2";t.input.rows.push({row:4,cells:other});
});
add("two rows with identical existing product ID",t=>{
  t.input.rows.push({row:3,cells:existing()});
});
add("existing archived product unchanged",t=>{
  t.state.products[0].deletedAt="2026-11-01";t.input.rows[0].cells[15]="보관";
});
add("existing archived option changed",t=>{
  t.state.products[0].deletedAt="2026-11-01";
  t.input.rows[0].cells[15]="보관";t.input.rows[0].cells[7]="25000";
});
add("stale workbook",t=>{t.input.revision=5;});

function toSource(input){
  const products=[],options=[];
  for(const {row,cells:values} of input.rows){
    if(!values.some(Boolean))continue;
    const c=values.length===20?[...values.slice(0,8),"",...values.slice(8)]:values;
    products.push({row,cells:[c[0],c[1],c[2],c[3],c[8],c[9],c[10],c[11],
      c[12],c[13],c[14],c[4],c[15],c[16]]});
    options.push({row,cells:[c[0],c[1],c[17],c[4],c[18],c[5],c[6],c[7],c[19],c[20]]});
  }
  return {revision:input.revision,products,options};
}
function stable(result,priorState) {
  const resultCopy=JSON.parse(JSON.stringify(result));
  if(!resultCopy.ok)return resultCopy;
  const old=priorState.products;
  const remap=new Map();
  for(const p of resultCopy.value.products){
    const prior=old.find(x=>x.id===p.id);
    if(!prior){
      remap.set(p.id,"NEW-PRODUCT-"+p.name);
      p.createdAt="NOW";p.updatedAt="NOW";
    }else if(prior.updatedAt!==p.updatedAt){p.updatedAt="NOW"}
    p.variants.forEach((v)=>{
      if(!prior?.variants.some(x=>x.id===v.id)){
        remap.set(v.id,"NEW-VARIANT-"+p.name);
      }
    });
    const historyLength=prior?.priceHistory?.length??0;
    p.priceHistory?.slice(historyLength).forEach(change=>{change.at="NOW"});
  }
  let output=JSON.stringify(resultCopy);
  for(const [oldId,newId] of [...remap].sort((a,b)=>b[0].length-a[0].length)){
    output=output.split(oldId).join(newId);
  }
  return JSON.parse(output);
}
test("14 real unified TypeScript workbook previews agree with compiled Rust",()=>{
  const payloads=cases.map(item=>{
    const source=toSource(item.input);
    return {operation:"preview_product_sync_rows",payload:{
      state:item.state,source,unified:true,now:"2026-11-13T14:00:00Z",
      productIds:source.products.map((_,i)=>"test-product-"+(i+1)),
      optionIds:source.options.map((_,i)=>"test-variant-"+(i+1))
    }};
  });
  const run=spawnSync("cargo",["run","--quiet","--manifest-path",manifest,
    "--bin","parity_runner"],{
    cwd:root,encoding:"utf8",input:JSON.stringify(payloads),
    maxBuffer:32*1024*1024,timeout:180000
  });
  assert.equal(run.status,0,run.stderr||run.error?.message);
  const rust=JSON.parse(run.stdout);
  cases.forEach((item,i)=>assert.deepEqual(stable(rust[i],item.state),
    stable(item.oracle,item.state),item.name+": unified row decisions diverged"));
});
