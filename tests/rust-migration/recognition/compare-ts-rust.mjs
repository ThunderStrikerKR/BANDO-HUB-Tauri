/**
 * Real cross-runtime differential audit; TypeScript is executed, not copied.
 * stdin: { state, client, cases:[{ id, raw, rust, match? }] }
 */
import { tsImport } from "tsx/esm/api";
const { parseEvidence } = await tsImport("../../../src/parser.ts", import.meta.url);
let input="";
for await (const chunk of process.stdin) input+=chunk;
const payload=JSON.parse(input);
const cases=payload.cases;
if (!Array.isArray(cases) || cases.length < 15)
  throw Error("Expected at least fifteen real Rust outputs");
const volatileKeys=new Set(["id","recipientId","targetId","anchorId"]);
const missing="<MISSING>";
const normalize=(v,key="")=>{
  if (v===undefined) return missing;
  if (v===null) return null;
  if (volatileKeys.has(key)) return "<GENERATED_ID>";
  if (Array.isArray(v)) return v.map(x=>normalize(x));
  if (typeof v==="object")
    return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,normalize(x,k)]));
  return v;
};
const differences=[],countsByField=new Map(),caseSummaries=[];
let comparedLeaves=0;
function compare(ts,rs,path,caseId){
  if(ts && rs && typeof ts==="object" && typeof rs==="object" &&
      !Array.isArray(ts) && !Array.isArray(rs)){
    for(const key of [...new Set([...Object.keys(ts),...Object.keys(rs)])].sort())
      compare(ts[key],rs[key],path?path+"."+key:key,caseId);
    return;
  }
  if(Array.isArray(ts)&&Array.isArray(rs)){
    if(ts.length!==rs.length){
      differences.push({caseId,path:path+".length",ts:ts.length,rust:rs.length});
      countsByField.set(path+".length",(countsByField.get(path+".length")||0)+1);
    }
    for(let i=0;i<Math.max(ts.length,rs.length);i++)
      compare(ts[i],rs[i],path+"["+i+"]",caseId);
    return;
  }
  comparedLeaves++;
  const key=path.match(/(?:^|\.)([^.[\]]+)$/)?.[1]??"";
  const left=normalize(ts,key),right=normalize(rs,key);
  if(JSON.stringify(left)!==JSON.stringify(right)){
    differences.push({caseId,path,ts:left,rust:right});
    const field=path.replace(/\[\d+\]/g,"[]");
    countsByField.set(field,(countsByField.get(field)||0)+1);
  }
}
const items=output=>(output?.recipients||[]).flatMap(r=>r.items||[]);
for(const entry of cases){
  const fromTs=parseEvidence(entry.raw,payload.client,payload.state);
  const tsItems=items(fromTs),rustItems=items(entry.rust);
  const before=differences.length;
  compare(tsItems,rustItems,"items",entry.id);
  // The TypeScript original lacks a match_products entrypoint. Check fields
  // shared with its actual parseEvidence-derived Item, separately.
  if(entry.match && tsItems.length===1){
    for(const field of [
      "productId","variantId","name","color","origin","recognitionReason","match"
    ]) compare(tsItems[0][field],entry.match[field],"standaloneMatch."+field,entry.id);
    if(entry.match.evidence){
      const productSource=tsItems[0].sources?.find(s=>s.field==="product");
      if(productSource){
        compare(productSource.start,entry.match.evidence.start,
          "standaloneMatch.evidence.start",entry.id);
        compare(productSource.end,entry.match.evidence.end,
          "standaloneMatch.evidence.end",entry.id);
      }
    }
  }
  caseSummaries.push({
    id:entry.id,tsItemCount:tsItems.length,rustItemCount:rustItems.length,
    tsProductIds:tsItems.map(i=>i.productId),
    rustProductIds:rustItems.map(i=>i.productId),
    mismatchCount:differences.length-before
  });
}
const report={
  source:"src/parser.ts::parseEvidence (real TS)",
  target:"recognition::execute analyze_order (real Rust)",
  comparison:"All parsed Item fields recursively; generated UUID-like identifiers normalized; overlapping standalone endpoint fields separately checked",
  cases:cases.length,
  casesWithDifferences:caseSummaries.filter(x=>x.mismatchCount>0).length,
  comparedLeaves,
  mismatchCount:differences.length,
  byField:[...countsByField.entries()].sort((a,b)=>b[1]-a[1])
    .map(([field,count])=>({field,count})),
  byCase:caseSummaries,
  differences:differences.slice(0,1500),
  truncated:differences.length>1500
};
process.stdout.write(JSON.stringify(report));
