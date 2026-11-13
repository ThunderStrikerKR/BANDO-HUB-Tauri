/** Actual compiled Rust tariff history decision vs original ShippingManager. */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const root=fileURLToPath(new URL("../../../",import.meta.url));
const cargo=fileURLToPath(new URL("../integration/Cargo.toml",import.meta.url));
const old={
  version:"old-version",at:"2026-11-01T00:00:00.000Z",
  fees:{"1":3000,"2":4000,"3":null},
  maxBundle:2,maxConfirmed:true,perItem:null,notes:"historical",
};
const shipping={
  epoch:2,combinations:[],groups:[
    {id:"g1",name:"보면대 그룹",current:old,history:[]},
    {id:"g2",name:"별도 그룹",current:{...old,version:"other-version"},history:[]},
  ],
};
const rule={
  ...old,notes:"직원 확인",maxBundle:3,
  fees:{"1":3000,"2":4500,"3":6000},
  validFrom:"old-date",validUntil:"new-date",basis:"historical",packable:true,
};
const now="2026-11-13T10:00:00.000Z";
function oracle(payload) {
  const next=structuredClone(payload.shipping);
  const group=next.groups.find(g=>g.id===payload.groupId);
  group.history.push(group.current);
  if(Object.entries(payload.rule.fees).some(([count,amount])=>
    typeof amount==="number" && payload.rule.maxBundle!==null &&
    Number(count)>payload.rule.maxBundle))
    throw Error("최대 묶음 수량을 초과하는 운임 구간을 확인하세요.");
  group.current={
    ...payload.rule,maxConfirmed:payload.rule.maxBundle!==null,
    version:payload.versionId,at:payload.now,
  };
  delete group.current.validFrom;
  delete group.current.validUntil;
  delete group.current.basis;
  delete group.current.packable;
  return {shipping:next};
}
const cases=[
  ["valid edited rate, full history",rule],
  ["unbounded group, numeric fees",{...rule,maxBundle:null}],
  ["reject fee above maximum",{...rule,maxBundle:1,fees:{"1":3000,"2":4000}}],
  ["keep unknown fee as null",{...rule,fees:{"1":null,"2":4500,"3":null}}],
  ["only update one group's price",{...rule,fees:{"1":3500,"2":4000,"3":null}}],
];
const requests=cases.map(([,modified])=>({
  domain:"rules",operation:"apply_shipping_action",
  payload:{
    action:"save_group_rule",shipping,groupId:"g1",
    rule:modified,versionId:"new-version",now,
  }
}));
const run=spawnSync("cargo",["run","--quiet","--manifest-path",cargo,
  "--bin","reception_runner"],{
  cwd:root,input:JSON.stringify(requests),encoding:"utf8",
  timeout:900000,maxBuffer:64*1024*1024,
});
if(run.error)throw run.error;
assert.equal(run.status,0,run.stderr);
const actual=JSON.parse(run.stdout);
assert.equal(actual.length,cases.length);
for(let i=0;i<cases.length;i++){
  const [name]=cases[i],payload=requests[i].payload;
  test("Rust group tariff: "+name,()=>{
    let expected,expectedError;
    try{expected=oracle(payload)}catch(e){expectedError=e.message}
    const result=actual[i];
    if(expectedError){
      assert.equal(result.ok,false);
      assert.equal(result.error,expectedError);
    }else{
      assert.equal(result.ok,true,JSON.stringify(result.error));
      assert.deepEqual(result.value,expected);
    }
    assert.equal(shipping.groups[0].history.length,0);
    assert.equal(shipping.groups[0].current.version,"old-version");
    assert.equal(shipping.groups[1].current.version,"other-version");
  });
}
