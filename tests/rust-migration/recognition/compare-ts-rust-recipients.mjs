/**
 * Live, source-based TS↔Rust recipient and reanalysis differential comparison.
 * -- no reimplemented recognizer and no transcript-derived expected outputs.
 * stdin {phase:"prepare"|"compare",state,client,cases:[{id,raw,rust?,order?,rustReanalyzed?}]}
 */
import { tsImport } from "tsx/esm/api";
const { parseEvidence,reanalyzeWithAliases }=await tsImport("../../../src/parser.ts",import.meta.url);
let text="";
for await(const chunk of process.stdin)text+=chunk;
const data=JSON.parse(text);
const phase=data.phase??"compare";
const cases=data.cases??[];
const generatedId=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const generatedRust=/^recognition:(?:recipient|item):/;
const canonical=(v,key="")=>{
  if(v===undefined)return "<MISSING>";
  if(v===null)return null;
  if(Array.isArray(v))return v.map(x=>canonical(x));
  if(typeof v==="object")return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,canonical(x,k)]));
  if(typeof v==="string" && ["id","recipientId","targetId","itemId"].includes(key)){
    // Stable employee IDs MUST NOT be normalized. Fresh engine identifiers
    // are opaque, but their relationships are checked separately.
    if(generatedId.test(v)||generatedRust.test(v))return "<GENERATED_ID>";
    if(key==="id" && v.startsWith("candidate:"))return "<GENERATED_ID>";
  }
  return v;
};
const diff=[],byField=new Map(),byCase=[];
let compared=0;
function difference(caseId,path,ts,rust){
  diff.push({caseId,path,ts,rust});
  const field=path.replace(/\[\d+\]/g,"[]");
  byField.set(field,(byField.get(field)||0)+1);
}
// Evidence arrays may contain an extra candidate or may be emitted in
// different discovery order. Align by immutable source coordinates first,
// never by array index. Report unmatched source records explicitly so that
// missing candidates are not hidden by index-wise cascades.
function evidenceKind(v){return v?.field??v?.kind??"";}
function chooseEvidence(v,list,used){
  const indices=list.map((_,i)=>i).filter(i=>!used.has(i));
  const exact=indices.find(i=>v?.id && v.id===list[i]?.id);
  if(exact!==undefined)return exact;
  const sameSpan=indices.find(i=>v?.start===list[i]?.start &&
    v?.end===list[i]?.end && evidenceKind(v)===evidenceKind(list[i]));
  if(sameSpan!==undefined)return sameSpan;
  const sameCoordinates=indices.find(i=>v?.start===list[i]?.start &&
    v?.end===list[i]?.end);
  if(sameCoordinates!==undefined)return sameCoordinates;
  const sameText=indices.find(i=>v?.text && v.text===list[i]?.text &&
    evidenceKind(v)===evidenceKind(list[i]));
  if(sameText!==undefined)return sameText;
  return undefined;
}
function compareEvidenceArray(caseId,path,ts,rust){
  if(ts.length!==rust.length)
    difference(caseId,path+".length",ts.length,rust.length);
  const used=new Set();
  for(let i=0;i<ts.length;i++){
    const candidate=chooseEvidence(ts[i],rust,used);
    if(candidate===undefined){
      difference(caseId,path+".missingRust["+i+"]",canonical(ts[i]),"<MISSING>");
    }else{
      used.add(candidate);
      compare(caseId,path+"["+i+"]",ts[i],rust[candidate]);
    }
  }
  for(let j=0;j<rust.length;j++)if(!used.has(j)){
    difference(caseId,path+".missingTs["+j+"]","<MISSING>",canonical(rust[j]));
  }
}
function isEvidencePath(path,ts,rust){
  return (/(?:^|\.)candidates$|(?:^|\.)analysisEvidence$|(?:^|\.)sources$/.test(path))
    && ts.some(x=>x && typeof x==="object")
    && rust.some(x=>x && typeof x==="object");
}
function compare(caseId,path,a,b){
  if(a!==null && b!==null && typeof a==="object" && typeof b==="object" &&
      !Array.isArray(a)&&!Array.isArray(b)){
    const keys=[...new Set([...Object.keys(a),...Object.keys(b)])].sort();
    for(const key of keys)compare(caseId,path?path+"."+key:key,a[key],b[key]);
    return;
  }
  if(Array.isArray(a)&&Array.isArray(b)){
    if(isEvidencePath(path,a,b)){
      compareEvidenceArray(caseId,path,a,b);
      return;
    }
    if(a.length!==b.length)difference(caseId,path+".length",a.length,b.length);
    for(let i=0;i<Math.max(a.length,b.length);i++)
      compare(caseId,path+"["+i+"]",a[i],b[i]);
    return;
  }
  compared++;
  const key=path.match(/(?:^|\.)([^.[\]]+)$/)?.[1]??"";
  const x=canonical(a,key),y=canonical(b,key);
  if(JSON.stringify(x)!==JSON.stringify(y))difference(caseId,path,x,y);
}
function validateLinks(output){
  const faults=[];
  for(let i=0;i<(output.recipients??[]).length;i++){
    const r=output.recipients[i],rid=r.id;
    for(let j=0;j<(r.sources??[]).length;j++){
      const s=r.sources[j];
      if(s.targetId!==rid)faults.push("recipient["+i+"].sources["+j+"].targetId");
      if(s.recipientId!==undefined && s.recipientId!==rid)
        faults.push("recipient["+i+"].sources["+j+"].recipientId");
    }
    for(let k=0;k<(r.items??[]).length;k++){
      const item=r.items[k];
      for(let j=0;j<(item.sources??[]).length;j++){
        const s=item.sources[j];
        if(s.targetId!==item.id)faults.push("item["+i+","+k+"].sources["+j+"].targetId");
        if(s.recipientId!==undefined && s.recipientId!==rid)
          faults.push("item["+i+","+k+"].sources["+j+"].recipientId");
      }
    }
  }
  return faults;
}
function recipientShape(output,withItems){
  return (output?.recipients??[]).map(r=>withItems?r:{
    ...r,items:undefined
  });
}
function report(mode){
  return {
    mode,cases:byCase.length,comparedLeaves:compared,
    casesWithDifferences:byCase.filter(x=>x.mismatchCount).length,
    mismatchCount:diff.length,
    byField:[...byField.entries()].sort((a,b)=>b[1]-a[1])
      .map(([field,count])=>({field,count})),
    byCase,differences:diff.slice(0,5000),truncated:diff.length>5000
  };
}
function updateStableIds(order,index){
  const recipients=order.recipients??[];
  const recipientRefs=new Map(),itemRefs=new Map();
  recipients.forEach((r,i)=>{
    recipientRefs.set(r.id,"stable-recipient-"+index+"-"+i);
    (r.items??[]).forEach((item,j)=>itemRefs.set(item.id,"stable-item-"+index+"-"+i+"-"+j));
  });
  for(const r of recipients){
    const originalId=r.id;r.id=recipientRefs.get(originalId);
    for(const s of r.sources??[]){
      if(s.targetId===originalId)s.targetId=r.id;
      if(s.recipientId===originalId)s.recipientId=r.id;
    }
    for(const item of r.items??[]){
      const original=item.id;item.id=itemRefs.get(original);
      for(const s of item.sources??[]){
        if(s.targetId===original)s.targetId=item.id;
        if(s.recipientId===originalId)s.recipientId=r.id;
      }
    }
    for(const s of r.unassignedEvidence??[]){
      if(recipientRefs.has(s.recipientId))s.recipientId=recipientRefs.get(s.recipientId);
      if(itemRefs.has(s.itemId))s.itemId=itemRefs.get(s.itemId);
    }
  }
  return order;
}
function enrich(order,mode){
  const r=order.recipients?.[0],item=r?.items?.[0];
  if(mode.includes("confirmed")&&r){
    r.confirmedFields=["name","address","phone","mobile","note"];
    r.name="직원확정";
    r.address="서울특별시 서대문구 연희로 100";
    r.phone="02-777-1234";
    r.mobile="010-9876-5432";
    r.note="직원이 확인한 배송 요청";
    r.addressStatus="CONFIRMED";
    r.addressParts={province:"서울특별시",city:"서대문구",road:"연희로",building:"100"};
  }
  if(mode.includes("freight")&&r){
    r.shippingCharges={FACTORY:3300,STORE:2500};
    r.freightCode="020";
    r.vatDefault=true;
    r.vatOverride=false;
    r.dispatchOrigin="STORE";
  }
  if(mode.includes("staff-item")&&item){
    item.manuallyConfirmed=true;
    item.productId="staff-picked-sku";
    item.variantId="staff-picked-variant";
    item.name="직원 수동 확정 품목";
    item.color="Custom Color";
    item.quantityApproval={at:"2026-11-13T00:00:00.000Z",actor:"employee",quantity:item.quantity??1};
    item.issues=[];
  }
  return order;
}
if(phase==="prepare"){
  const result=[];
  for(let i=0;i<cases.length;i++){
    const x=cases[i];
    const parsed=parseEvidence(x.raw,data.client,data.state);
    const oldRaw=x.oldRaw??x.raw;
    const oldParsed=x.oldRaw?parseEvidence(oldRaw,data.client,data.state):parsed;
    const order=updateStableIds({
      id:"stable-order-"+i,raw:oldRaw,
      analysisRaw:x.raw,clientId:data.client.id,
      clientSnapshot:data.client,manualClassification:x.mode==="manual",
      status:"RECEIVED",recipients:structuredClone(oldParsed.recipients)
    },i);
    enrich(order,x.mode??"base");
    result.push({id:x.id,raw:x.raw,mode:x.mode??"base",order});
  }
  process.stdout.write(JSON.stringify({cases:result}));process.exit(0);
}
if(phase!=="compare"&&phase!=="reanalyze")
  throw Error("unknown phase "+phase);
for(const x of cases){
  const before=diff.length;
  if(phase==="compare"){
    const ts=parseEvidence(x.raw,data.client,data.state);
    const rust=x.rust;
    if(!rust)throw Error("Rust was not executed for "+x.id);
    compare(x.id,"recipients",recipientShape(ts,false),recipientShape(rust,false));
    compare(x.id,"candidates",ts.candidates,rust.candidates);
    compare(x.id,"unassigned",ts.unassigned,rust.unassigned);
    compare(x.id,"referenceIntegrity.ts",validateLinks(ts),[]);
    compare(x.id,"referenceIntegrity.rust",[],validateLinks(rust));
    byCase.push({id:x.id,tsRecipientCount:ts.recipients.length,
      rustRecipientCount:rust.recipients.length,mismatchCount:diff.length-before});
  }else{
    if(!x.order||!x.rustReanalyzed)throw Error("No identical order reanalysis "+x.id);
    const ts=reanalyzeWithAliases(structuredClone(x.order),data.state);
    const rust=x.rustReanalyzed;
    compare(x.id,"reanalyzed",ts,rust);
    compare(x.id,"referenceIntegrity.ts",validateLinks(ts),[]);
    compare(x.id,"referenceIntegrity.rust",[],validateLinks(rust));
    const old=x.order;
    const sameIds=(result)=>result.recipients.map(r=>({
      id:r.id,items:r.items.map(item=>({
        id:item.id,productId:item.productId,quantity:item.quantity,
        quantityApproval:item.quantityApproval,
        manuallyConfirmed:item.manuallyConfirmed
      }))
    }));
    byCase.push({id:x.id,mode:x.mode,old: sameIds(old),ts:sameIds(ts),
      rust:sameIds(rust),mismatchCount:diff.length-before});
  }
}
process.stdout.write(JSON.stringify(report(phase)));
