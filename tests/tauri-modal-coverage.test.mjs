import assert from "node:assert/strict";
import test from "node:test";
import { inventoryDialogs } from "../scripts/audit-modal-inventory.mjs";

test("dialog inventory covers every native modal owner and custom dialog",()=>{
  const rows=inventoryDialogs();
  const kinds=new Set(rows.map(row=>row.kind));
  assert.ok(rows.length>=35,"Modal owner inventory unexpectedly small");
  for(const kind of ["NATIVE_MODAL","DIALOG","ARIA_DIALOG","ACTION_DIALOG","PRODUCT_SEARCH_SURFACE","MANUAL_PROMPT"])
    assert.ok(kinds.has(kind),"Missing dialog kind: "+kind);
  for(const file of ["src/ui/Modal.tsx","src/ProductManager.tsx","src/ClientManager.tsx",
    "src/orders/ManualClassification.tsx","src/developer/DeveloperModalWorkbench.tsx"])
    assert.ok(rows.some(row=>row.path===file),"Modal source missing: "+file);
  const direct=rows.filter(row=>row.kind==="NATIVE_MODAL" || row.kind==="ARIA_DIALOG" || row.kind==="DIALOG");
  console.log("STAGE7_MODAL_SOURCE_INVENTORY",JSON.stringify({
    occurrences:rows.length,
    files:[...new Set(rows.map(row=>row.path))].length,
    entryPoints:direct.map(row=>({path:row.path,line:row.line,kind:row.kind,source:row.source})),
  }));
});
