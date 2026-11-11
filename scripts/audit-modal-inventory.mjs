import { readFileSync, readdirSync } from "node:fs";
import { relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const src=resolve(root,"src");
const skip=new Set(["styles"]);
function walk(path){
  return readdirSync(path,{withFileTypes:true}).flatMap(item=>{
    const next=resolve(path,item.name);
    if(item.isDirectory())return skip.has(item.name)?[]:walk(next);
    return /\.tsx?$/.test(item.name)?[next]:[];
  });
}
function lineFor(code,index){return code.slice(0,index).split("\n").length}
function nearby(code,index){return code.slice(index,index+310).split("\n").slice(0,5).join(" ").replace(/\s+/g," ").slice(0,220)}
export function inventoryDialogs(){
  const expressions=[
    ["NATIVE_MODAL",/<Modal(?=[\s>])/g],
    ["DIALOG",/<dialog(?=[\s>])/g],
    ["ARIA_DIALOG",/role=["']dialog["']/g],
    ["ACTION_DIALOG",/\bconfirmAction\(/g],
    ["PRODUCT_SEARCH_SURFACE",/<ProductSearchDialog(?=[\s>])/g],
    ["MANUAL_PROMPT",/<ManualPrompt(?=[\s>])/g],
    ["PORTAL",/\bcreatePortal\(/g],
  ];
  const rows=[];
  for(const file of walk(src)){
    const code=readFileSync(file,"utf8"),path=relative(root,file).replaceAll("\\","/");
    for(const [kind,regex] of expressions)for(const match of code.matchAll(regex))
      rows.push({path,line:lineFor(code,match.index),kind,source:nearby(code,match.index)});
  }
  return rows.sort((a,b)=>a.path.localeCompare(b.path)||a.line-b.line||a.kind.localeCompare(b.kind));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const rows=inventoryDialogs();
  const files=[...new Set(rows.map(x=>x.path))];
  console.log("DIALOG_INVENTORY_COUNTS",JSON.stringify({
    files:files.length,occurrences:rows.length,
    kinds:rows.reduce((result,row)=>(result[row.kind]=(result[row.kind]??0)+1,result),{}),
  }));
  if(process.argv.includes("--json"))console.log("DIALOG_INVENTORY",JSON.stringify(rows));
  else for(const row of rows)console.log(row.path+":"+row.line+" "+row.kind+" "+row.source);
}
