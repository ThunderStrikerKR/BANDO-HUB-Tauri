/** Real src/product-sync-workbook.ts::previewProductSyncRows against
 * compiled production Rust, including full proposed products and price audit.
 * Only generated UUIDs/timestamps are normalized.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {tsImport} from "tsx/esm/api";
const {previewProductSyncRows}=await tsImport("../../../src/product-sync-workbook.ts",import.meta.url);
const manifest=fileURLToPath(new URL("./Cargo.toml",import.meta.url));
const root=fileURLToPath(new URL("../../../",import.meta.url));
const oldProduct=()=>({
  id:"p1",code:"p1",name:"BD 709 블랙 기본",subtitle:"",catalog:"BANDOSTAND",
  origin:"FACTORY",category:"보면대",categories:["leaf"],defaultColor:"Black",
  active:true,createdAt:"2026-11-01T00:00:00Z",updatedAt:"2026-11-01T00:00:00Z",
  saleUnit:true,variants:[{id:"v1",color:"Black",option:"",wholesale:10000,semi:12000,
    retail:15000,source:"MANUAL",url:"",siteOptionId:""}]
});
const state=()=>({
  revision:11,clients:[],products:[oldProduct()],
  categories:[{id:"leaf",name:"보면대",parentId:null,active:true}],
  brands:[{id:"brand1",name:"반도",aliases:[]}],
  orders:[{id:"old-order",confirmedAt:"2026-11-10",pricesLocked:true}]
});
const existing=()=>({
  products:[{row:2,cells:["p1","","BD 709 블랙 기본","","","반도스탠드",
    "공장","leaf","","","","Black","사용","정상"]}],
  options:[{row:2,cells:["p1","","v1","Black","","10000","12000","15000","MANUAL",""]}]
});
const fresh=(key="newA",name="BD 708 블랙 기본")=>({
  products:[{row:3,cells:["",key,name,"","","반도스탠드",
    "공장","leaf","","","","Black","사용","정상"]}],
  options:[{row:3,cells:["",key,"","Black","","22000","24000","28000","",""]}]
});
const trials=[];
function add(name,change=()=>{}) {
  const s=state(), source={revision:s.revision,...existing()};
  const t={name,state:s,source};
  change(t);
  let oracle;
  try{oracle={ok:true,value:previewProductSyncRows(t.state,t.source)}}
  catch(error){oracle={ok:false,error:error instanceof Error?error.message:String(error)}}
  trials.push({...t,oracle});
}
add("existing product and price unchanged");
add("existing product rename",(t)=>{t.source.products[0].cells[2]="BD 709 블랙 타공";});
add("existing subtitle edit",(t)=>{t.source.products[0].cells[3]="설명 수정";});
add("existing color update matching price",(t)=>{
  t.source.products[0].cells[11]="화이트";t.source.options[0].cells[3]="화이트";
});
add("existing wholesale price change with history",t=>{t.source.options[0].cells[5]="13,000";});
add("existing retail price change with history",t=>{t.source.options[0].cells[7]="16000";});
add("existing deleted retail price",t=>{t.source.options[0].cells[7]="[비우기]";});
add("existing price zero accepted",t=>{t.source.options[0].cells[7]="0";});
add("existing invalid decimal price",t=>{t.source.options[0].cells[7]="10.5";});
add("existing price beyond safe limit",t=>{t.source.options[0].cells[7]="9007199254740992";});
add("existing option source edit rejected",t=>{t.source.options[0].cells[8]="OFFICIAL";});
add("existing read-only option text edit rejected",t=>{t.source.options[0].cells[4]="가방포함";});
add("product group change rejected",t=>{t.source.products[0].cells[5]="반도몰";});
add("product shipping origin change rejected",t=>{t.source.products[0].cells[6]="매장";});
add("product category changed to unknown",t=>{t.source.products[0].cells[7]="bogus";});
add("product brand changed to unknown",t=>{t.source.products[0].cells[8]="unknown";});
add("new product with one price record",t=>{
  const f=fresh();t.source.products.push(...f.products);t.source.options.push(...f.options);
});
add("new product no price record",t=>{t.source.products.push(...fresh().products);});
add("new product price color mismatch",t=>{
  const f=fresh();f.options[0].cells[3]="Rose Gold";
  t.source.products.push(...f.products);t.source.options.push(...f.options);
});
add("new product with unregistered key in price sheet",t=>{
  const f=fresh();f.options[0].cells[1]="wrong";
  t.source.products.push(...f.products);t.source.options.push(...f.options);
});
add("new product with invalid registration key",t=>{
  const f=fresh("bad key");t.source.products.push(...f.products);t.source.options.push(...f.options);
});
add("new duplicate of existing product name",t=>{
  const f=fresh("newA","BD 709 블랙 기본");
  t.source.products.push(...f.products);t.source.options.push(...f.options);
});
add("new zero price and explicit empty semi",t=>{
  const f=fresh();f.options[0].cells[5]="0";f.options[0].cells[6]="삭제";
  t.source.products.push(...f.products);t.source.options.push(...f.options);
});
add("unknown existing product id rejected",t=>{
  t.source.products[0].cells[0]="not-known";
});
add("duplicate product rows in the same workbook",t=>{
  t.source.products.push({row:3,cells:[...t.source.products[0].cells]});
});
add("duplicate price rows in workbook",t=>{
  t.source.options.push({row:3,cells:[...t.source.options[0].cells]});
});
add("an existing product cannot acquire a second sale configuration",t=>{
  t.source.options.push({row:3,cells:["p1","","","Rose Gold","","100","","","",""]});
});
add("archived product and original price unchanged",t=>{
  t.state.products[0].deletedAt="2026-11-10";
  t.source.products[0].cells[13]="보관";
});
add("archived product edit rejected",t=>{
  t.state.products[0].deletedAt="2026-11-10";
  t.source.products[0].cells[13]="보관";
  t.source.products[0].cells[2]="재고정리";
});
add("archived price edit rejected",t=>{
  t.state.products[0].deletedAt="2026-11-10";
  t.source.products[0].cells[13]="보관";
  t.source.options[0].cells[7]="17000";
});
add("stale spreadsheet revision",t=>{t.source.revision=10;});
add("new product without any registered leaf",t=>{
  t.state.categories[0].active=false;
  const f=fresh();t.source.products.push(...f.products);t.source.options.push(...f.options);
});
add("new BANDOMALL product creates STORE origin",t=>{
  const f=fresh("kMall","AC-1");
  f.products[0].cells[5]="반도몰";f.products[0].cells[6]="매장";
  t.source.products.push(...f.products);t.source.options.push(...f.options);
});

// Port-completion matrix: compare raw TS decisions across every editable
// product and price column rather than only hand-picked happy-path rows.
const productColumnMatrix=[
  [2,"product-name",["BD 709-1 비타공","GT-1","Desk TS-1","", "[비우기]"]],
  [3,"subtitle",["","[비우기]","가방 미포함","Bar 길이 10cm"]],
  [5,"catalog",["","반도스탠드","반도몰","BANDOSTAND"]],
  [6,"origin",["","공장","매장","STORE"]],
  [7,"category",["","leaf","bogus","leaf / bogus"]],
  [8,"brand",["","brand1","unknown","[비우기]"]],
  [9,"specification",["","[비우기]","높이 100cm"]],
  [10,"unit",["","[비우기]","개","세트"]],
  [11,"default-color",["","블랙","화이트","Rose Gold"]],
  [12,"active",["","사용","중지","예","INVALID"]],
  [13,"archived",["","정상","보관","[비우기]"]],
];
for(const [index,label,values] of productColumnMatrix){
  for(const value of values){
    add("product matrix "+label+" "+JSON.stringify(value),t=>{
      t.source.products[0].cells[index]=value;
    });
  }
}
const priceColumnMatrix=[
  [2,"variant-id",["","v1","invalid-variant"]],
  [3,"color",["","Black","검정","Rose Gold","[비우기]"]],
  [4,"official-option",["","가방 포함","[비우기]"]],
  [5,"wholesale",["","0","[비우기]","12,000","-100","9007199254740992"]],
  [6,"semi",["","1","[비우기]","12,000","12.5","123,45"]],
  [7,"retail",["","1","[비우기]","15,000","삭제","9999999999999999999"]],
  [8,"source",["","MANUAL","OFFICIAL","UNKNOWN"]],
  [9,"official-id",["","p-code-123","[비우기]"]],
];
for(const [index,label,values] of priceColumnMatrix){
  for(const value of values){
    add("price matrix "+label+" "+JSON.stringify(value),t=>{
      t.source.options[0].cells[index]=value;
    });
  }
}
for (const model of ["BD 709-1 / 비타공 상판","GT-1 / 기타 스탠드",
  "SS-1 / 마이크 스탠드","Desk TS-1 (Bar 길이 10cm)","BD LED 709"]) {
  add("new independent model "+model,t=>{
    const f=fresh("product_"+model.replace(/\W/g,"").slice(0,12),model);
    t.source.products.push(...f.products);
    t.source.options.push(...f.options);
  });
}

function stable(output,initial){
  const clone=JSON.parse(JSON.stringify(output));
  if(!clone.ok)return clone;
  const before=new Map(initial.products.map(p=>[p.id,p]));
  const idMap=new Map();
  for(const p of clone.value.products){
    const prev=before.get(p.id);
    if(!prev){
      idMap.set(p.id,"GENERATED-PRODUCT-"+p.name);
      idMap.set(p.code,"GENERATED-PRODUCT-"+p.name);
      p.createdAt="NOW";p.updatedAt="NOW";
    }else if(p.updatedAt!==prev.updatedAt){p.updatedAt="NOW";}
    for(const variant of p.variants){
      if(!prev?.variants.some(v=>v.id===variant.id)){
        idMap.set(variant.id,"GENERATED-VARIANT-"+p.name);
      }
    }
    const priorHistory=prev?.priceHistory?.length??0;
    p.priceHistory?.slice(priorHistory).forEach(h=>{h.at="NOW";});
  }
  let wire=JSON.stringify(clone);
  for(const [id,canonical] of [...idMap].sort((a,b)=>b[0].length-a[0].length)){
    wire=wire.split(id).join(canonical);
  }
  return JSON.parse(wire);
}
test("33 real product/price Excel TS preview cases match compiled Rust exactly",()=>{
  const cases=trials.map(t=>({operation:"preview_product_sync_rows",payload:{
    state:t.state,source:t.source,now:"2026-11-13T14:00:00Z",
    productIds:t.source.products.map((_,i)=>"generated-product-"+(i+1)),
    optionIds:t.source.options.map((_,i)=>"generated-variant-"+(i+1))
  }}));
  const run=spawnSync("cargo",["run","--quiet","--manifest-path",manifest,
    "--bin","parity_runner"],{
    cwd:root,encoding:"utf8",input:JSON.stringify(cases),
    maxBuffer:32*1024*1024,timeout:180000
  });
  assert.equal(run.status,0,run.stderr||run.error?.message);
  const results=JSON.parse(run.stdout);
  assert.equal(results.length,trials.length);
  trials.forEach((t,i)=>{
    assert.deepEqual(stable(results[i],t.state),stable(t.oracle,t.state),
      t.name+": native product preview differs from original TypeScript");
  });
});
