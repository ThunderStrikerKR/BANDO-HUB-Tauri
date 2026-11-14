/** Production native freight read projections vs original TypeScript selectors.
 * This protects current/previous tariff badges and editable rule values.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tsImport } from "tsx/esm/api";

const { effectiveShippingRule, combinationCurrent, editableShippingRule } =
  await tsImport("../../../src/shipping.ts", import.meta.url);
const manifest=fileURLToPath(new URL("./Cargo.toml", import.meta.url));
const root=fileURLToPath(new URL("../../../", import.meta.url));
const copy=structuredClone;
const base=()=>({
  products:[
    {id:"p1",name:"BD 709",shippingGroupId:"g1"},
    {id:"p2",name:"독립 스탠드"},
    {id:"p3",name:"미등록"},
  ],
  shipping:{
    epoch:4,
    groups:[{id:"g1",name:"동급 그룹",current:{
      version:"v1",at:"2026-11-14",fees:{"1":3000,"2":4000},
      maxBundle:4,maxConfirmed:true,perItem:null,notes:"확인"
    },history:[]}],
    productRules:{p2:{
      version:"v2",at:"2026-11-14",fees:{"1":2500},
      maxBundle:null,maxConfirmed:false,perItem:null,notes:"개별"
    }},
    combinations:[
      {id:"c1",active:true,epoch:4,versions:{
        "group:g1":"v1","assignment:p1":"g1", "product:p2":"v2",
        "assignment:p2":"individual"
      }},
      {id:"c2",active:true,epoch:3,versions:{"group:g1":"v1"}},
      {id:"c3",active:false,epoch:4,versions:{}},
    ],
  },
});
const cases=[];
function add(label,modify=()=>{}){
  const state=base();modify(state);
  const effective=state.products.map(product=>{
    const {group,rule}=effectiveShippingRule(state,product.id);
    return {productId:product.id,group:group??null,rule:rule??null,
      editableRule:rule ? editableShippingRule(rule):null};
  });
  const groups=(state.shipping?.groups??[]).map(group=>({
    id:group.id,editableRule:editableShippingRule(group.current),
  }));
  const combinations=(state.shipping?.combinations??[]).map(combo=>({
    id:combo.id,current:combinationCurrent(combo,state),
  }));
  cases.push({label,operation:"shipping_read",payload:{state},
    expected:{ok:true,value:{effective,groups,combinations}}});
}
add("normal group/product rate selection and historical combination");
add("per-item group 3000 converts to one-item editor",s=>{
  const g=s.shipping.groups[0].current;
  g.perItem=3000;g.maxConfirmed=false;g.fees={};
});
add("per-item zero remains a valid editable amount",s=>{
  s.shipping.groups[0].current.perItem=0;
});
add("deleted group falls back to standalone product tariff",s=>{
  s.shipping.groups[0].deletedAt="2026-11-14";
  s.shipping.productRules.p1={...copy(s.shipping.productRules.p2),version:"other"};
});
add("assignment changed marks original combination expired",s=>{
  s.products[0].shippingGroupId="other";
});
add("group version changed marks combination expired",s=>{
  s.shipping.groups[0].current.version="v2";
});
add("product rule version changed marks combination expired",s=>{
  s.shipping.productRules.p2.version="v3";
});
add("combination unknown key checks legacy group version",s=>{
  s.shipping.combinations[0].versions={"g1":"v1"};
});
add("unregistered product version accepted as empty base",s=>{
  s.shipping.combinations[0].versions={"product:p3":"unregistered"};
});
add("missing group current falls back to individual rule",s=>{
  s.shipping.productRules.p1={...copy(s.shipping.productRules.p2)};
  delete s.shipping.groups[0].current;
  // The legacy TS group editor needs a current rule; only project
  // product lookup for this malformed historical state.
  s.shipping.groups=[];
  s.products[0].shippingGroupId=undefined;
});
add("inactive combination without a basis",s=>{
  s.shipping.combinations[0].active=false;
});
test("native freight list, editable rate and historical combination project exactly as TS",()=>{
  const run=spawnSync("cargo",["run","--quiet","--manifest-path",
    manifest,"--bin","parity_runner"],{cwd:root,
    input:JSON.stringify(cases),encoding:"utf8",
    timeout:240000,maxBuffer:8*1024*1024});
  assert.equal(run.status,0,run.stderr);
  const actual=JSON.parse(run.stdout);
  assert.equal(actual.length,cases.length);
  actual.forEach((entry,i)=>
    assert.deepStrictEqual(entry,cases[i].expected,cases[i].label));
});
