/** Real approved official-product import oracle vs compiled production Rust.
 * Covers new product registration, exact source matching, prices, audit and
 * stale/ambiguous/deleted data protection. No fake business-rule oracle.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {tsImport} from "tsx/esm/api";
const {applyOfficialProductPreview}=await tsImport("../../../src/official-product-import.ts",import.meta.url);
const manifest=fileURLToPath(new URL("./Cargo.toml",import.meta.url));
const root=fileURLToPath(new URL("../../../",import.meta.url));

const URL709="https://www.bandostand.com/product/709";
const makeState=()=>({
  revision:12, clients:[],products:[],orders:[{
    id:"past-order",confirmedAt:"2026-11-12T12:00:00Z",pricesLocked:true,
    recipients:[{items:[{productId:"past",variantId:"old-v",unitPrice:15000}]}]
  }],
  categories:[
    {id:"catalog-root:BANDOSTAND",name:"반도스탠드",parentId:null},
    {id:"catalog-root:BANDOMALL",name:"반도몰",parentId:null},
    {id:"leaf",name:"보면대",parentId:"catalog-root:BANDOSTAND",active:true},
    {id:"nonleaf",name:"상판",parentId:"catalog-root:BANDOSTAND",active:true},
    {id:"child",name:"바퀴",parentId:"nonleaf",active:true},
    {id:"mall-leaf",name:"매장 물품",parentId:"catalog-root:BANDOMALL",active:true}
  ],
});
const makeProduct=()=>({
  id:"import-1",code:"import-1",name:"BD 709 / 타공 상판",
  category:"",categories:[],catalog:"BANDOSTAND",origin:"FACTORY",
  active:true,siteId:"709",siteRefs:["709"],defaultColor:"Black",
  colorStatus:"KNOWN",saleUnit:true,
  createdAt:"2026-11-13T12:00:00.000Z",
  updatedAt:"2026-11-13T12:00:00.000Z",
  variants:[{
    id:"import-v1",color:"Black",option:"",
    wholesale:null,semi:null,retail:22000,officialRetail:22000,
    url:URL709,source:"OFFICIAL",siteProductId:"709",
    collectedAt:"2026-11-13T12:00:00.000Z"
  }],
});
const makePreview=()=>({
  revision:12,canApply:true,existingId:null,optionEvidence:[],
  sourceUrl:URL709,product:makeProduct(),warnings:[],
});
const existing=(id="existing-1")=>{
  const p=makeProduct();
  p.id=id;p.code=id;
  p.variants[0].id="v-"+id;
  p.variants[0].retail=18000;
  p.variants[0].officialRetail=18000;
  p.variants[0].wholesale=13000;
  p.variants[0].semi=15000;
  p.variants[0].source="MANUAL";
  p.category="반도스탠드 > 보면대";
  p.categories=["catalog-root:BANDOSTAND","leaf"];
  return p;
};

const trials=[];
function add(name,edit=()=>{}){
  const state=makeState(),preview=makePreview();
  const t={name,state,preview,selectedCategoryId:"leaf"};
  edit(t);
  let oracle;
  try{oracle={ok:true,value:applyOfficialProductPreview(
    t.state,t.preview,t.selectedCategoryId
  )};}
  catch(error){oracle={ok:false,error:error instanceof Error?error.message:String(error)};}
  trials.push({...t,oracle});
}
add("approved independent new product preserves past orders");
add("approved new BANDOMALL sale product",(t)=>{
  t.preview.product.catalog="BANDOMALL";
  t.preview.product.origin="STORE";
  t.preview.product.name="매장 전용 부품";
  t.selectedCategoryId="mall-leaf";
});
add("reject preview without approval",(t)=>{t.preview.canApply=false;});
add("reject unresolved options",(t)=>{t.preview.product.requiresOption=true;});
add("reject option evidence",(t)=>{t.preview.optionEvidence=[{group:"색상",kind:"SELECT",values:[]}];});
add("reject blank product name",(t)=>{t.preview.product.name="  ";});
add("reject stale DB revision",(t)=>{t.preview.revision=11;});
add("reject missing official ID",(t)=>{delete t.preview.product.siteId;});
add("reject zero known price? accepted as TS if only null checked",(t)=>{
  t.preview.product.variants[0].retail=0;
});
add("reject null official retail",(t)=>{t.preview.product.variants[0].retail=null;});
add("reject omitted variant",(t)=>{t.preview.product.variants=[];});
add("reject untrusted source URL",(t)=>{t.preview.sourceUrl="https://evil.example/product/709";});
add("reject HTTP source URL",(t)=>{t.preview.sourceUrl="http://www.bandostand.com/product/709";});
add("new duplicate model name blocked",(t)=>{
  const p=existing();p.siteId="different";p.siteRefs=["different"];
  p.variants[0].siteProductId="different";t.state.products.push(p);
});
add("same business model in other catalog is distinct",(t)=>{
  const p=existing();p.catalog="BANDOMALL";p.siteId="other";
  p.siteRefs=["other"];p.variants[0].siteProductId="other";
  t.state.products.push(p);
});
add("deleted product ID cannot be auto-restored",(t)=>{
  const p=existing();p.deletedAt="2026-11-10";t.state.products.push(p);
});
add("deleted matching name cannot be auto-restored",(t)=>{
  const p=existing();p.siteId="other";p.siteRefs=["other"];
  p.variants[0].siteProductId="other";p.deletedAt="2026-11-10";
  t.state.products.push(p);
});
add("reject absent leaf category",(t)=>{t.selectedCategoryId="missing";});
add("reject root category",(t)=>{t.selectedCategoryId="catalog-root:BANDOSTAND";});
add("reject category having children",(t)=>{t.selectedCategoryId="nonleaf";});
add("reject inactive leaf",(t)=>{t.state.categories.find(c=>c.id==="leaf").active=false;});
add("reject wrong catalog leaf",(t)=>{t.selectedCategoryId="mall-leaf";});
add("reject category parent cycle",(t)=>{
  t.state.categories.find(c=>c.id==="leaf").parentId="leaf";
});
add("reject product when default color does not exist",(t)=>{
  t.preview.product.defaultColor="Rose Gold";
});
add("update existing exact official site reference",(t)=>{
  t.state.products.push(existing());
});
add("preserve historical staff tier prices on official price update",(t)=>{
  const p=existing();p.variants[0].wholesale=15000;
  p.variants[0].semi=17000;t.state.products.push(p);
});
add("reject unchanged official price",(t)=>{
  const p=existing();p.variants[0].retail=22000;t.state.products.push(p);
});
add("old retail null can be replaced",(t)=>{
  const p=existing();p.variants[0].retail=null;t.state.products.push(p);
});
add("recognize canonical source ID in siteRefs",(t)=>{
  const p=existing();p.siteId="another";p.siteRefs=["709"];
  p.variants[0].siteProductId="another";t.state.products.push(p);
});
add("recognize canonical source ID in variant siteProductId",(t)=>{
  const p=existing();p.siteId="another";p.siteRefs=["another"];
  p.variants[0].siteProductId="709";t.state.products.push(p);
});
add("reject two active products tied to same site ID",(t)=>{
  t.state.products.push(existing("one"),existing("two"));
});
add("reject existing compound product configuration",(t)=>{
  const p=existing();p.variants.push({...p.variants[0],id:"second"});
  t.state.products.push(p);
});
add("re-resolve matching by actual state ignoring stale preview existingId",(t)=>{
  t.preview.existingId="stale-id";
});
add("old confirmed billing snapshot unchanged",(t)=>{
  const p=existing();t.state.products.push(p);
  t.state.orders[0].billingHistory=[{at:"2026-11-12",total:30000}];
});

function stable(input,original){
  const result=JSON.parse(JSON.stringify(input));
  if(!result.ok)return result;
  for(const p of result.value.next.products){
    const before=original.products.find(item=>item.id===p.id);
    if(before && p.updatedAt!==before.updatedAt)p.updatedAt="CLOCK";
    const count=before?.priceHistory?.length??0;
    p.priceHistory?.slice(count).forEach(entry=>{entry.at="CLOCK";});
  }
  return result;
}
test("native approved official imports equal original TS in 34 realistic source, category and audit cases",()=>{
  const cases=trials.map(t=>({
    operation:"apply_official_product_import",
    payload:{
      state:t.state,preview:t.preview,
      selectedCategoryId:t.selectedCategoryId,
      historyAt:"2026-11-13T14:00:00.000Z",
      updatedAt:"2026-11-13T14:00:00.001Z",
    }
  }));
  const run=spawnSync("cargo",["run","--quiet","--manifest-path",manifest,
    "--bin","parity_runner"],{
    cwd:root,encoding:"utf8",input:JSON.stringify(cases),
    maxBuffer:32*1024*1024,timeout:180000,
  });
  assert.equal(run.status,0,run.stderr||run.error?.message);
  const rust=JSON.parse(run.stdout);
  assert.equal(rust.length,trials.length);
  trials.forEach((t,i)=>assert.deepEqual(stable(rust[i],t.state),stable(t.oracle,t.state),
    t.name+": official import approval differs from TypeScript"));
});
