/**
 * Real cross-runtime differential audit; TypeScript is executed, not copied.
 * stdin: { state, client, cases:[{ id, raw, rust, match? }] }
 */
import { tsImport } from "tsx/esm/api";
const { parseEvidence } = await tsImport("../../../src/parser.ts", import.meta.url);
const { registeredNameCandidates } = await tsImport("../../../src/product-name-match.ts", import.meta.url);
const { registeredProducts } = await tsImport("../../../src/product-models.ts", import.meta.url);
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
const differences=[],countsByField=new Map(),caseSummaries=[],diagnostics=[],standaloneChecks=[];
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
// A legacy TS result sometimes contains an additional unresolved item
// before a confirmed SKU (notably samples 19/20). Align by registered
// productId and raw evidence first, then report the surplus item separately.
// Otherwise comparing array index 0 to index 0 invents false field mismatches.
function compareAlignedItems(tsItems,rustItems,caseId){
  compare(tsItems.length,rustItems.length,"items.length",caseId);
  const used=new Set();
  for(let i=0;i<rustItems.length;i++){
    const item=rustItems[i];
    let candidate=-1;
    if(item?.productId){
      candidate=tsItems.findIndex((x,j)=>!used.has(j)&&
        x?.productId===item.productId);
    }
    if(candidate<0) candidate=tsItems.findIndex((x,j)=>
      !used.has(j)&&x?.raw===item?.raw);
    if(candidate<0) candidate=tsItems.findIndex((x,j)=>!used.has(j)&&
      x?.productId===item?.productId);
    if(candidate<0){
      compare(undefined,item,"items.unmatchedRust["+i+"]",caseId);
    }else{
      used.add(candidate);
      compare(tsItems[candidate],item,"items["+i+"]",caseId);
    }
  }
  for(let j=0;j<tsItems.length;j++) if(!used.has(j))
    compare(tsItems[j],undefined,"items.unmatchedTs["+j+"]",caseId);
}
for(const entry of cases){
  const fromTs=parseEvidence(entry.raw,payload.client,payload.state);
  const tsItems=items(fromTs),rustItems=items(entry.rust);
  const before=differences.length;
  compareAlignedItems(tsItems,rustItems,entry.id);
  // TS has no standalone match_products API. Comparing different input
  // strings (name vs name+quantity) would be a false parity assertion.
  // Keep standalone SKU consistency separate from the same-raw TS/Rust diff.
  if(entry.match && rustItems.length===1){
    standaloneChecks.push({
      id:entry.id,
      productId:entry.match.productId,
      analyzedProductId:rustItems[0].productId,
      variantId:entry.match.variantId,
      analyzedVariantId:rustItems[0].variantId
    });
  }
  if(entry.id==="corrected-01"){
    const productLine=entry.raw.split("\n")[0];
    const tsCandidates=registeredNameCandidates(
      registeredProducts(payload.state.products),productLine
    );
    const target=payload.state.products.find(p=>p.id==="bando-site-104");
    diagnostics.push({
      id:entry.id,productLine,
      tsCandidateIds:tsCandidates.map(p=>p.id),
      matchedSkuColor:target?.variants?.[0]?.color,
      matchedSkuDefaultColor:target?.defaultColor,
      tsItem:tsItems[0],rustItem:rustItems[0]
    });
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
  comparison:"All Item fields recursively on identical raw order inputs; generated UUID-like identifiers normalized; unlike-input standalone endpoint checked separately",
  cases:cases.length,
  casesWithDifferences:caseSummaries.filter(x=>x.mismatchCount>0).length,
  comparedLeaves,
  mismatchCount:differences.length,
  byField:[...countsByField.entries()].sort((a,b)=>b[1]-a[1])
    .map(([field,count])=>({field,count})),
  byCase:caseSummaries,
  diagnostics,
  standaloneChecks,
  differences:differences.slice(0,1500),
  truncated:differences.length>1500
};
process.stdout.write(JSON.stringify(report));
