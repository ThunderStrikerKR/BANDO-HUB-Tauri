import test from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {tsImport} from "tsx/esm/api";

const {saveAlias,aliasProblems}=await tsImport("../../../src/matching.ts",import.meta.url);
const {validateModelGroups,validateModelGroupProducts}=
  await tsImport("../../../src/model-groups.ts",import.meta.url);
const manifest=fileURLToPath(new URL("./Cargo.toml",import.meta.url));
const root=fileURLToPath(new URL("../../../",import.meta.url));
const product=(id,name,color="Black")=>({
  id,code:id,name,category:"보면대",active:true,catalog:"BANDOSTAND",
  variants:[{id:id+"v",color,source:"MANUAL",retail:10000}],
});
const state=()=>({
  revision:23,aliases:[],products:[
    product("709","BD 709 / 타공 상판"),
    product("709-1","BD 709-1 / 비타공 상판"),
    product("709G","BD 709G / 그레이"),
    product("mic","BD Mic Holder / Black"),
    product("old","폐기 상품"),
  ],orders:[{id:"past",total:29000,confirmedAt:"2026-11-01"}],
  settings:{colorGuidanceGroups:{}},clients:[{id:"c1",name:"악기사"}],
});
const aliases=[];
const modelCases=[];
const evaluate=(fn)=>{
  try{return {ok:true,value:fn()}}
  catch(error){return {ok:false,error:String(error instanceof Error?error.message:error)}}
};
const addAlias=(name,modify=()=>{})=>{
  const s=state(),record={
    id:"a-new",text:"악보대",productId:"709",variantId:"709v",
    clientId:null,actor:"직원",createdAt:"2026-11-13T13:00:00Z",
  };
  modify(s,record);
  aliases.push({name,operation:"save_alias",payload:{state:s,record},
    oracle:evaluate(()=>({state:saveAlias(s,record)}))});
};
addAlias("new common alias preserves old orders");
addAlias("per-client alias with distinct scope",(_,r)=>r.clientId="c1");
addAlias("same alias common and client scopes coexist",(s,r)=>{
  s.aliases=[{...r,id:"old-common",clientId:null}];r.clientId="c1";
});
addAlias("existing identical alias new ID retains first UUID",(s,r)=>{
  s.aliases=[{...r,id:"original"}];
});
addAlias("editing same ID replaces alias",(s,r)=>{
  s.aliases=[{...r,id:"a-new",text:"old name"}];r.text="new name";
});
addAlias("new alias same text different product is blocked",(s,r)=>{
  s.aliases=[{...r,id:"old"}];r.productId="709-1";r.variantId="709-1v";
});
addAlias("renaming to another alias in same scope is blocked",(s,r)=>{
  s.aliases=[{...r,id:"a-new",text:"old"},{...r,id:"other",text:"악보대"}];
});
addAlias("blank alias refused",(_,r)=>r.text=" ");
addAlias("missing linked product refused",(_,r)=>r.productId="missing");
addAlias("archived linked product refused",(s,r)=>{
  s.products.find(p=>p.id==="709").deletedAt="2026-10-01";
});
addAlias("invalid linked variant refused",(_,r)=>r.variantId="missing");
addAlias("active product model collision refused",(_,r)=>r.text="BD 709-1");
addAlias("model collision with other color variant refused",(_,r)=>r.text="709G");
addAlias("valid alias matching own registered product is accepted",(_,r)=>r.text="BD 709");
addAlias("model name with BD prefix normalization collision",(_,r)=>r.text="７０９-１");
addAlias("same scope normalized whitespace collision",(s,r)=>{
  r.text="AB C";s.aliases=[{...r,id:"other",text:"A BC",productId:"mic",variantId:"micv"}];
});
addAlias("same variant different product issue",(s,r)=>{
  r.text="709B";r.variantId="709v";r.productId="mic";
});
addAlias("mixed-case suffix conflict with incompatible color",(_,r)=>r.text="709br");
addAlias("suffix conflicts when configured target is another model",(_,r)=>{
  r.text="709BK";r.productId="mic";r.variantId="micv";
});
addAlias("unchanged historical conflict untouched on addition",(s,r)=>{
  s.aliases=[{...r,id:"legacy",text:"invalid",productId:"missing",variantId:"missing"}];
  r.text="새 별칭";
});
addAlias("stable client alias ID updated",(s,r)=>{
  r.clientId="c1";s.aliases=[{...r,id:"historic",text:"악보대"}];
});

function addProblems(name,modify){
  const s=state();
  s.aliases=[{
    id:"a1",text:"악보대",productId:"709",variantId:"709v",clientId:null,
  }];
  modify(s);
  aliases.push({name,operation:"alias_problems",payload:{state:s},
    oracle:evaluate(()=>s.aliases.map(a=>({
      id:a.id,problems:aliasProblems(a,s.aliases,s.products),
    })))});
}
addProblems("valid stored aliases",()=>{});
addProblems("conflicting aliases with same normalized key",s=>{
  s.aliases.push({...s.aliases[0],id:"a2",productId:"709-1",variantId:"709-1v"});
});
addProblems("old archived linked product",s=>{
  s.products[0].deletedAt="2026-11-01";
});
addProblems("different product exact model collision",s=>{
  s.aliases[0].text="709-1";
});
addProblems("unknown linked variant",s=>{
  s.aliases[0].variantId="missing";
});
addProblems("suffix color conflicting with target",s=>{
  s.aliases[0].text="709BR";s.aliases[0].productId="709";s.aliases[0].variantId="709v";
});
addProblems("suffix color matching selected variant",s=>{
  s.aliases[0].text="709BK";
});
addProblems("different client scope no conflict",s=>{
  s.aliases.push({...s.aliases[0],id:"a2",clientId:"c1",productId:"709-1"});
});

function addModel(name,modify,op="validate_model_groups",ids,rep){
  const s=state();modify(s);
  const oracle=evaluate(()=>{
    if(op==="validate_model_groups")validateModelGroups(s);
    else validateModelGroupProducts(s,ids,rep);
    return {valid:true};
  });
  modelCases.push({name,operation:op,payload:{
    state:s,...(op==="validate_model_groups"?{}:
      {productIds:ids,representativeProductId:rep})
  },oracle});
}
const g=(products=["709","709-1"],rep="709",name="타공 여부")=>({
  name,productIds:products,representativeProductId:rep,
});
addModel("empty group list is valid",()=>{});
addModel("same color different pricing groups accepted",s=>{
  s.products[1].variants[0].retail=48000;
  s.settings.colorGuidanceGroups.g=g();
});
addModel("one product group refused",s=>s.settings.colorGuidanceGroups.g=g(["709"]));
addModel("duplicate group member refused",s=>s.settings.colorGuidanceGroups.g=g(["709","709"]));
addModel("missing member refused",s=>s.settings.colorGuidanceGroups.g=g(["709","missing"]));
addModel("no representative refused",s=>s.settings.colorGuidanceGroups.g=g(["709","709-1"],""));
addModel("outside representative refused",s=>s.settings.colorGuidanceGroups.g=g(["709","709-1"],"mic"));
addModel("archived member refused",s=>{
  s.settings.colorGuidanceGroups.g=g();s.products[1].deletedAt="2026-10-01";
});
addModel("demo product refused",s=>{
  s.settings.colorGuidanceGroups.g=g();s.products[1].catalog="DEMO";
});
addModel("multi-variant member refused",s=>{
  s.settings.colorGuidanceGroups.g=g();
  s.products[1].variants.push({...s.products[1].variants[0],id:"other"});
});
addModel("overlapping group refused",s=>{
  s.settings.colorGuidanceGroups.a=g();
  s.settings.colorGuidanceGroups.b=g(["709","mic"],"mic","마이크");
});
addModel("duplicate name casefold refused",s=>{
  s.settings.colorGuidanceGroups.a=g();
  s.settings.colorGuidanceGroups.b=g(["mic","old"],"mic","타공 여부");
});
addModel("legacy group with representativeColor accepted",s=>{
  s.settings.colorGuidanceGroups.g={
    name:"기존",productIds:["709","709-1"],representativeColor:"Black",
  };
});
addModel("legacy group without representativeColor refused",s=>{
  s.settings.colorGuidanceGroups.g={
    name:"기존",productIds:["709","709-1"],representativeColor:"",
  };
});
addModel("legacy group with one product refused",s=>{
  s.settings.colorGuidanceGroups.g={
    name:"기존",productIds:["709"],representativeColor:"Black",
  };
});
addModel("group without name refused",s=>s.settings.colorGuidanceGroups.g=g(undefined,undefined,""));
addModel("duplicate group IDs cannot exist in JSON",s=>s.settings.colorGuidanceGroups.g=g());
addModel("valid member subset",()=>{},"validate_model_group_products",["709","709-1"],"709");
addModel("invalid member subset",()=>{},"validate_model_group_products",["709","missing"],"709");
addModel("duplicate member subset",()=>{},"validate_model_group_products",["709","709"],"709");
addModel("unselected representative",()=>{},"validate_model_group_products",["709","709-1"],"");
addModel("product without active flag still registered",s=>{
  delete s.products[0].active;
  s.settings.colorGuidanceGroups.g=g();
});

test("native alias save + legacy diagnostics exactly reproduce original TS",()=>{
  const req=aliases.map(({operation,payload})=>({operation,payload}));
  const run=spawnSync("cargo",["run","--quiet","--manifest-path",manifest,
    "--bin","parity_runner"],{
    cwd:root,encoding:"utf8",input:JSON.stringify(req),
    timeout:180000,maxBuffer:32*1024*1024
  });
  assert.equal(run.status,0,run.stderr||run.error?.message);
  const actual=JSON.parse(run.stdout);
  const mismatch=[];
  for(let i=0;i<aliases.length;i++){
    try{assert.deepEqual(actual[i],aliases[i].oracle)}
    catch{mismatch.push({
      scenario:aliases[i].name,expected:aliases[i].oracle,actual:actual[i],
    })}
  }
  assert.deepEqual(mismatch,[]);
});

test("native model groups exactly reproduce original TS for current and legacy groups",()=>{
  const req=modelCases.map(({operation,payload})=>({operation,payload}));
  const run=spawnSync("cargo",["run","--quiet","--manifest-path",manifest,
    "--bin","parity_runner"],{
    cwd:root,encoding:"utf8",input:JSON.stringify(req),
    timeout:180000,maxBuffer:32*1024*1024
  });
  assert.equal(run.status,0,run.stderr||run.error?.message);
  const actual=JSON.parse(run.stdout);
  const mismatch=[];
  for(let i=0;i<modelCases.length;i++){
    try{assert.deepEqual(actual[i],modelCases[i].oracle)}
    catch{mismatch.push({
      scenario:modelCases[i].name,expected:modelCases[i].oracle,actual:actual[i],
    })}
  }
  assert.deepEqual(mismatch,[]);
});
