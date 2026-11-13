import test from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {tsImport} from "tsx/esm/api";

const {clientCandidates,suggestClient,normalizeColor,validateProduct}=
  await tsImport("../../../src/domain.ts",import.meta.url);
const {searchProducts,representativeProducts}=
  await tsImport("../../../src/product-search.ts",import.meta.url);
const {categoryIds,classifiedProducts}=
  await tsImport("../../../src/product-registry.ts",import.meta.url);
const {suggestGroupRepresentative}=
  await tsImport("../../../src/model-groups.ts",import.meta.url);
const {officialLinksFromSnapshot}=
  await tsImport("../../../src/official-links.ts",import.meta.url);
const {productKey,registeredProducts}=
  await tsImport("../../../src/product-models.ts",import.meta.url);
const {catalogFromCategory,withCatalogRoots}=
  await tsImport("../../../src/category-roots.ts",import.meta.url);
const manifest=fileURLToPath(new URL("./Cargo.toml",import.meta.url));
const root=fileURLToPath(new URL("../../../",import.meta.url));

const product=(id,name,category="보면대",cat="BANDOSTAND")=>({
  id,code:id,name,category,categories:[category],catalog:cat,origin:"FACTORY",
  subtitle:"",active:true,defaultColor:"Black",saleUnit:true,
  createdAt:"2026-11-13",updatedAt:"2026-11-13",
  variants:[{id:id+"-v",option:"",color:"Black",wholesale:10000,semi:11000,
    retail:12000,url:"",source:"MANUAL"}]
});
const state=()=>({
  revision:7,
  products:[
    product("p709","BD 709","보면대"),
    product("p709b","BD 709-1","보면대"),
    product("p709c","BD 710","보면대"),
    product("pMic","마이크 스탠드","마이크 스탠드"),
    product("pAcc","마이크 악세사리","악세사리"),
    product("pD","공구 세트","공구"),
  ],
  clients:[
    {id:"c1",name:"반도 악기사",displayName:"반도마트",shortNames:"반도",
      identifiers:"반악",address:"경기도 의정부시",phone:"010-1234-5678",mobile:""},
    {id:"c2",name:"샘플 악기",displayName:"",shortNames:"",identifiers:"",
      address:"서울특별시",phone:"02-1234-5678",mobile:""},
    {id:"c3",name:"삭제 매장",address:"서울",phone:"123",deletedAt:"2026-10-01"},
  ],
  brands:[{id:"brand1",name:"Shubb",korean:"셔브",aliases:["Shubb カポ"],
    evidenceUrl:"https://example.com"}],
  aliases:[
    {id:"a1",text:"악보대",productId:"p709",clientId:null,variantId:"p709-v"},
    {id:"a2",text:"반도 비타공",productId:"p709b",clientId:"c1",variantId:"p709b-v"},
    {id:"a3",text:"블랙 캡",productId:"p709c",clientId:null,variantId:"p709c-v"},
  ],
  categories:[
    {id:"catalog-root:BANDOSTAND",name:"반도스탠드",parentId:null},
    {id:"catalog-root:BANDOMALL",name:"반도몰",parentId:null},
    {id:"보면대",name:"보면대",parentId:"catalog-root:BANDOSTAND"},
    {id:"마이크 스탠드",name:"마이크 스탠드",parentId:"catalog-root:BANDOSTAND"},
    {id:"악세사리",name:"악세사리",parentId:"마이크 스탠드"},
    {id:"공구",name:"공구",parentId:"catalog-root:BANDOSTAND"},
  ],
  orders:[],
  workflow:{shipments:[]},
  settings:{colorGuidanceGroups:{
    "group-1":{name:"709 타공 유무",productIds:["p709","p709b"],representativeProductId:"p709"}
  },accounts:[]},
});
const trials=[];
const add=(name,operation,payload,compute)=>{
  let oracle;
  try{oracle={ok:true,value:compute()}}
  catch(e){oracle={ok:false,error:String(e instanceof Error?e.message:e)}}
  trials.push({name,operation,payload,oracle});
};

for(const text of ["","반도","반 도","반악","0101234","의정부","서울","악기사","BANDO","9999"]){
  const s=state();
  add("client search "+text,"client_candidates",{state:s,query:text,raw:""},
    ()=>({ids:clientCandidates(text,s.clients).map(c=>c.id),suggestedIds:[]}));
}
for(const raw of ["","반도 악기사 발주","샘플 악기 주문","반도마트 주문","반도","삭제 매장"]){
  const s=state();
  add("raw client suggestion "+raw,"client_candidates",{state:s,query:"",raw},
    ()=>({ids:[],suggestedIds:suggestClient(raw,s.clients).map(c=>c.id)}));
}
for(const [category,minor,brand] of [
  ["","",""],["보면대","",""],["마이크 스탠드","",""],
  ["catalog-root:BANDOSTAND","",""],["악세사리","",""],
  ["보면대","","brand1"],["missing","",""],["마이크 스탠드","악세사리",""],
]){
  const s=state();
  add("classified "+category+"/"+minor+"/"+brand,"classified_products",
    {state:s,category,minor,brand},
    ()=>classifiedProducts(s,category,minor,brand).map(p=>p.id));
}
for(const [category,minor] of [
  ["보면대",""],["마이크 스탠드",""],["마이크 스탠드","악세사리"],
  ["catalog-root:BANDOSTAND",""],["",""],["unknown",""],
]){
  const s=state();
  add("category ids "+category+"/"+minor,"category_ids",
    {state:s,category,minor},
    ()=>[...categoryIds(s,category,minor)].sort());
}
for(const [query,clientId,major,brand] of [
  ["","","",""],["BD","","",""],["악보대","","",""],
  ["비타공","c1","",""],["비타공","c2","",""],["셔브","","",""],
  ["마이크","","",""],["BD 709","c1","보면대",""],
  ["BD 709","c1","악세사리",""],["","","보면대",""],
  ["missing","","",""],["블랙 캡","","",""],
]){
  const s=state();
  const oracle=searchProducts(s,query,clientId||undefined)
    .filter(p=>p.catalog!=="DEMO"&&!p.variants.some(v=>v.source==="DEMO")&&
      classifiedProducts(s,major,"",brand).some(x=>x.id===p.id)).map(p=>p.id);
  add("product search "+query+"/"+clientId+"/"+major,"search_products",
    {state:s,query,clientId,major,brand,excludeDemo:true},()=>oracle);
}
for(const [category,brand,query,missing] of [
  ["","","",false],["보면대","","",false],["보면대","","BD 709",false],
  ["","","BD",true],["마이크 스탠드","","마이크",false],
  ["","","없는상품",false],["","brand1","",false],
]){
  const s=state();
  s.products.find(p=>p.id==="p709b").variants[0].retail=null;
  s.products.find(p=>p.id==="pD").deletedAt="2026-11-10";
  const classified=new Set(classifiedProducts(s,category,"",brand).map(p=>p.id));
  const expected=s.products.filter(p=>
    !p.deletedAt && !p.supersededBy &&
    p.catalog!=="DEMO" && !p.variants.some(v=>v.source==="DEMO") &&
    classified.has(p.id) &&
    (p.name+" "+(p.subtitle??"")).toLowerCase().replace(/\\s/g,"")
      .includes(query.toLowerCase().replace(/\\s/g,"")) &&
    (!missing || p.variants.some(v=>!v.wholesale||!v.semi||!v.retail))
  ).map(p=>p.id);
  add("management products "+category+"/"+query+"/"+missing,"management_products",
    {state:s,category,brand,query,missing},()=>expected);
}
for(const text of ["보면대","악보대","마이크","키보드 스탠드","없는 모델","709"]){
  const s=state();
  add("representative "+text,"representative_products",{state:s,text,clientId:"c1"},
    ()=>representativeProducts(s,text,"c1").map(p=>p.id));
}
for(const candidates of [
  ["p709","p709b"],["p709","p709c"],["p709"],["p709","p709b","p709c"],
  ["p709b","p709"],["p709","p709","p709b"],["pMic","pAcc"],["missing","p709"],
]){
  const s=state(), products=candidates.flatMap(id=>s.products.filter(p=>p.id===id));
  add("representative group "+candidates.join(","),"suggest_group_representative",
    {state:s,candidateIds:candidates},
    ()=>suggestGroupRepresentative(s,products)??null);
}
for(const links of [
  [
    ["709","BD 709","https://www.bandostand.com/product/709/709"],
    ["711","BD 711","https://www.bandostand.com/product/detail.html?product_no=711"],
    ["709","BD duplicate","https://bandostand.com/product/709/709"]
  ],
  [
    ["706","BD 706","https://www.bandostand.com/product/706/706"],
    ["707","BD 707","http://www.bandostand.com/product/707/707"],
    ["708","BD 708","https://user@www.bandostand.com/product/708/708"]
  ],
  [
    ["700","오류 링크","https://bandostand.com/product/731/731"],
    ["1200","실제 상품","https://bandomall.co.kr/product/detail.html?product_no=1200"]
  ],
  [
    ["800","번호 누락","https://www.bandostand.com/product/detail.html"],
    ["801","쿼리 중복","https://www.bandostand.com/product/detail.html?product_no=801&product_no=801"],
    ["802","상품번호 문자열","https://www.bandostand.com/product/detail.html?product_no=x"]
  ]
]){
  const report={products:links.map(([siteId,name,url])=>({
    id:siteId,siteId,name,variants:[{url}],
  }))};
  add("official links set "+trials.length,"official_links",{report},
    ()=>officialLinksFromSnapshot(report));
}
function editorOracle(s,p,updatedAt){
  const proposed=structuredClone(p);
  proposed.name=proposed.name.trim();
  proposed.code ||= proposed.id;
  if(proposed.variants.length!==1)throw Error(
    "상품은 한 가지 판매 구성으로만 등록할 수 있습니다. 기존 복수 구성은 각각 별도 상품으로 전환하세요.");
  proposed.saleUnit=true;
  proposed.familyKey ??= proposed.id;
  proposed.modelKey=productKey(proposed);
  proposed.variants=proposed.variants.map(v=>({...v,color:normalizeColor(v.color)}));
  proposed.defaultColor=normalizeColor(proposed.defaultColor);
  proposed.updatedAt=updatedAt;
  if(proposed.categories?.length){
    const catalog=catalogFromCategory(withCatalogRoots(s.categories),proposed.categories.at(-1));
    if(catalog)proposed.catalog=catalog;
  }
  validateProduct(proposed,registeredProducts(s.products));
  const result=structuredClone(s);
  const index=result.products.findIndex(x=>x.id===proposed.id);
  if(index>=0)result.products[index]=proposed;else result.products.push(proposed);
  return {state:result};
}
for(const [name,mutate] of [
  ["create product, normalize model key and colors",(_s,p)=>{}],
  ["trim product name and code",(_s,p)=>{p.name="  BD 709-1  ";p.code="";}],
  ["move to BANDOMALL catalog",(s,p)=>{
    s.categories.push({id:"mall-leaf",name:"상품",parentId:"catalog-root:BANDOMALL"});
    p.categories=["mall-leaf"];
  }],
  ["preserve familyKey",(s,p)=>{p.familyKey="old-family";}],
  ["normalize Rose Gold",(s,p)=>{
    p.defaultColor="로즈골드";p.variants[0].color="rose gold";
  }],
  ["existing product changed with history",(s,p)=>{
    s.products.push({...p,name:"Original"});
    p.name="Edited";
  }],
  ["invalid second selling option",(_s,p)=>{
    p.variants.push({...p.variants[0],id:"v2"});
  }],
]){
  const s=state();
  const p=product("new-p","  BD 709-1 ","보면대");
  p.variants[0].color="블랙";p.defaultColor="검정";
  mutate(s,p);
  const updatedAt="2026-11-13T20:00:00.000Z";
  add("editor "+name,"upsert_product_from_editor",
    {state:s,product:p,updatedAt},()=>editorOracle(s,p,updatedAt));
}

test("actual compiled Rust business reads and product editor equal original TS oracle",()=>{
  const req=trials.map(({operation,payload})=>({operation,payload}));
  const run=spawnSync("cargo",["run","--quiet","--manifest-path",manifest,
    "--bin","parity_runner"],{
    cwd:root,encoding:"utf8",input:JSON.stringify(req),
    timeout:180000,maxBuffer:32*1024*1024
  });
  assert.equal(run.status,0,run.stderr||run.error?.message);
  const actual=JSON.parse(run.stdout);
  assert.equal(actual.length,trials.length);
  trials.forEach((t,i)=>{
    const actualCase=actual[i];
    if(t.operation==="category_ids"&&actualCase.ok){
      actualCase.value.sort();
    }
    if(t.operation==="upsert_product_from_editor"&&!t.oracle.ok){
      assert.equal(actualCase.ok,false,t.name+": native must reject invalid product");
    }else{
      assert.deepEqual(actualCase,t.oracle,t.name+": original TS and Rust diverged");
    }
  });
});
