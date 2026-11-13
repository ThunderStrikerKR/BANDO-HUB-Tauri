/** Compare native brand-save policy with the original, unmodified
 * src/product-registry.ts::validateBrands implementation.
 * The old React form assembled aliases with Map(registryKey -> alias).
 * Replicate only that form's field projection, and invoke the original TS
 * validator for every expected decision.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {tsImport} from "tsx/esm/api";

const {validateBrands,registryKey}=
  await tsImport("../../../src/product-registry.ts",import.meta.url);
const manifest=fileURLToPath(new URL("./Cargo.toml",import.meta.url));
const root=fileURLToPath(new URL("../../../",import.meta.url));

const original=()=>({
  id:"b1",name:"BANDO",korean:"반도",aliases:["반도스탠드"],
  evidenceUrl:"https://www.bandostand.com/product/709",
});
const fixture=()=>({
  revision:8,brands:[original()],
  categories:[{id:"root",name:"보면대",parentId:null}],
  products:[{id:"p1",name:"BD 709",brandId:"b1"}],
  clients:[{id:"c1",name:"악기사"}],
  orders:[{id:"old",total:25000,productId:"p1",locked:true}],
});
const trials=[];
function oracleRun(action){
  try{return {ok:true,value:action()}}
  catch(error){return {ok:false,error:error instanceof Error?error.message:String(error)}}
}
function addUpsert(name,mutate=()=>{}){
  const state=fixture();
  const values={
    editing:"",id:"b2",name:"Shubb",korean:"셔브",
    aliases:"카포, 기타카포",evidence:"https://shubb.com/product/capo"
  };
  mutate(state,values);
  const oracle=oracleRun(()=>{
    const knownNames=new Map();
    for(const value of values.aliases.split(",").map(s=>s.trim()).filter(Boolean)){
      knownNames.set(registryKey(value),value);
    }
    const brandRow={
      id:values.editing||values.id,name:values.name.trim(),korean:values.korean.trim(),
      aliases:[...knownNames.values()],evidenceUrl:values.evidence.trim()
    };
    const next={...state,brands:[...(state.brands??[])
      .filter(brand=>brand.id!==values.editing),brandRow]};
    validateBrands(next,state);
    return {state:next};
  });
  trials.push({name,oracle,operation:"upsert_brand",payload:{
    state,...values
  }});
}
function addValidation(name,mutate=()=>{}){
  const before=fixture(),state=structuredClone(before);
  mutate(state,before);
  const oracle=oracleRun(()=>{
    validateBrands(state,before);
    return {valid:true};
  });
  trials.push({name,oracle,operation:"validate_brands",payload:{state,before}});
}

addUpsert("valid new brand with verified HTTPS evidence");
addUpsert("trim brand name, localized name and link",(s,b)=>{
  b.name="  Shubb  ";b.korean="  셔브  ";
  b.evidence=" https://shubb.com/product/capo ";
});
addUpsert("dedupe repeated alias retaining latest text",(s,b)=>{
  b.aliases="기타 카포, 기타  카포, 기타카포, Guitar Capo";
});
addUpsert("unicode NFKC duplicate aliases",(s,b)=>{
  b.aliases="ｓｈｕｂｂ, SHUBB, 슈브";
});
addUpsert("blank optional korean and aliases",(s,b)=>{
  b.korean="";b.aliases="";
});
addUpsert("brand renamed with original stable ID",(s,b)=>{
  b.editing="b1";b.name="BANDO NEW";b.aliases="반도스탠드, 신제품";
});
addUpsert("brand source reference survives edit",(s,b)=>{
  b.editing="b1";b.name="BANDO";b.aliases="반도스탠드, 식별자";
});
addUpsert("unchanged historical invalid brand ignored on adding another",(s,b)=>{
  s.brands.push({id:"legacy",name:"옛기록",korean:"",
    aliases:[],evidenceUrl:"http://legacy.example"});
});
addUpsert("duplicate existing brand official name blocked",(s,b)=>{
  b.name="BANDO";
});
addUpsert("duplicate existing localized name blocked",(s,b)=>{
  b.korean="반도";
});
addUpsert("duplicate existing alias blocked",(s,b)=>{
  b.aliases="반도스탠드";
});
addUpsert("case-folded duplicate alias blocked",(s,b)=>{
  b.aliases="bando";
});
addUpsert("NFKC-equivalent duplicate alias blocked",(s,b)=>{
  b.aliases="ＢＡＮＤＯ";
});
addUpsert("cross-language brand collision blocked",(s,b)=>{
  b.name="반도스탠드";
});
addUpsert("HTTPS required",(s,b)=>{b.evidence="http://shubb.com";});
addUpsert("HTTP credentials rejected",(s,b)=>{b.evidence="https://u:p@shubb.com/product";});
addUpsert("invalid brand URL rejected",(s,b)=>{b.evidence="not-a-url";});
addUpsert("invalid protocol rejected",(s,b)=>{b.evidence="ftp://shubb.com/product";});
addUpsert("missing brand URL rejected",(s,b)=>{b.evidence="";});
addUpsert("empty official name rejected",(s,b)=>{b.name="   ";});
addUpsert("same ID in state but new registration creates duplicate",(s,b)=>{
  b.id="b1";
});
addUpsert("edit one brand with another brand alias collision",(s,b)=>{
  s.brands.push({id:"b3",name:"CAPO",korean:"카포",aliases:[],
    evidenceUrl:"https://example.org"});
  b.editing="b1";b.name="BANDO NEW";b.korean="카포";
});
addUpsert("new distinct brand with same word repeated in one record",(s,b)=>{
  b.aliases="Shubb,SHUBB, Shubb";
});
addUpsert("brand URL query and fragment accepted",(s,b)=>{
  b.evidence="https://shubb.com/product/capo?color=black#details";
});
addUpsert("URL with explicit HTTPS port 443 accepted",(s,b)=>{
  b.evidence="https://shubb.com:443/product/capo";
});

addValidation("unchanged legacy bad evidence allowed",(s,b)=>{
  s.brands[0].evidenceUrl="http://old.invalid";b.brands[0].evidenceUrl="http://old.invalid";
});
addValidation("new brand missing official name",(s)=>{
  s.brands.push({id:"b2",name:"",korean:"한국어",aliases:[],
    evidenceUrl:"https://example.org"});
});
addValidation("new brand missing ID",(s)=>{
  s.brands.push({id:"",name:"상품",korean:"",aliases:[],
    evidenceUrl:"https://example.org"});
});
addValidation("new brand duplicate ID",(s)=>{
  s.brands.push({...original()});
});
addValidation("changed evidence URL with username rejected",(s)=>{
  s.brands[0].evidenceUrl="https://user@bandostand.com";
});
addValidation("changed legacy brand with HTTPS invalid evidence rejected",(s)=>{
  s.brands[0].name="새 이름";s.brands[0].evidenceUrl="ftp://example.org";
});
addValidation("changed brand with NFKC alias colliding with another",(s)=>{
  s.brands.push({id:"b2",name:"CAPO",korean:"",aliases:["ＧＵＩＴＡＲ"],
    evidenceUrl:"https://example.org"});
  s.brands[0].aliases=["guitar"];
});
addValidation("same brand ID but different alias representation rejected",(s)=>{
  s.brands.push({...original(),name:"새 상품"});
});
addValidation("brand no alias or Korean name accepted",(s)=>{
  s.brands.push({id:"new",name:"GOTOH",korean:"",aliases:[],
    evidenceUrl:"https://g-gotoh.com/"});
});
addValidation("new brand with duplicate alias within itself accepted",(s)=>{
  s.brands.push({id:"new",name:"SHUBB",korean:"",aliases:["one","one"],
    evidenceUrl:"https://shubb.com"});
});
addValidation("case-normalized alias across two changed brands rejected",(s)=>{
  s.brands.push({id:"new",name:"SHUBB",korean:"",aliases:["bando"],
    evidenceUrl:"https://shubb.com"});
});
addValidation("legacy historical brand name collision ignored if not modified",(s,b)=>{
  const duplicate={id:"old",name:"BANDO",korean:"",aliases:[],
    evidenceUrl:"http://legacy.invalid"};
  s.brands.push(duplicate);b.brands.push(structuredClone(duplicate));
});
addValidation("changed brand ID cannot silently collide",(s)=>{
  s.brands.push({...original(),name:"Other",aliases:[],korean:"other"});
});

test("native Rust brand edit and validation exactly match original TS",()=>{
  const input=trials.map(({operation,payload})=>({operation,payload}));
  const run=spawnSync("cargo",["run","--quiet","--manifest-path",manifest,
    "--bin","parity_runner"],{
    cwd:root,encoding:"utf8",input:JSON.stringify(input),
    timeout:180000,maxBuffer:32*1024*1024,
  });
  assert.equal(run.status,0,run.stderr||run.error?.message);
  const results=JSON.parse(run.stdout);
  assert.equal(results.length,trials.length);
  trials.forEach((t,i)=>assert.deepEqual(results[i],t.oracle,
    t.name+": Rust brand policy diverged from original TypeScript"));
});
