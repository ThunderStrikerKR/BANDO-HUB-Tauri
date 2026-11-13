/** Original category-tree.ts is the sole business oracle.
 * Compare full candidate State, not merely valid/error booleans: category
 * names, parents, product ID/category paths, historical orders and all
 * unrelated data must remain byte-equivalent through JSON/Tauri IPC.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {tsImport} from "tsx/esm/api";

const {changeCategory,deleteCategory,validateCategories} =
  await tsImport("../../../src/category-tree.ts",import.meta.url);
const manifest=fileURLToPath(new URL("./Cargo.toml",import.meta.url));
const root=fileURLToPath(new URL("../../../",import.meta.url));
const state=()=>({
  revision:19,products:[
    {id:"p1",name:"BD 709",categories:["a","a1"],category:"스탠드 > 보면대",
      variants:[{id:"v1",retail:22000}]},
    {id:"p2",name:"가방",categories:["a","a2"],category:"스탠드 > 악세사리"},
    {id:"p3",name:"카포",categories:["b","b1"],category:"기타 > 카포"},
    {id:"p4",name:"기존 직접 연결",categories:["a"],category:"스탠드"},
    {id:"p5",name:"미분류",categories:[],category:"미분류"},
  ],
  categories:[
    {id:"a",name:"스탠드",parentId:null},
    {id:"a1",name:"보면대",parentId:"a"},
    {id:"a2",name:"악세사리",parentId:"a"},
    {id:"b",name:"기타",parentId:null},
    {id:"b1",name:"카포",parentId:"b"},
  ],
  clients:[{id:"old-client",name:"기존 거래처"}],
  orders:[{id:"historical",confirmedAt:"2026-11-12",pricesLocked:true,
    items:[{productId:"p1",unitPrice:18000}]}],
});
const trials=[];
function addChange(name,categoryId,rename,parentId,transfer=false,mutate=()=>{}){
  const s=state();mutate(s);
  let oracle;
  try{oracle={ok:true,value:{state:changeCategory(s,categoryId,rename,parentId,transfer)}}}
  catch(error){oracle={ok:false,error:error instanceof Error?error.message:String(error)}}
  trials.push({name,oracle,operation:"change_category",payload:{
    state:s,categoryId,name:rename,parentId,transfer,
  }});
}
function addDelete(name,categoryId,destination="",mutate=()=>{}){
  const s=state();mutate(s);
  let oracle;
  try{oracle={ok:true,value:{state:deleteCategory(s,categoryId,destination)}}}
  catch(error){oracle={ok:false,error:error instanceof Error?error.message:String(error)}}
  trials.push({name,oracle,operation:"delete_category",payload:{
    state:s,categoryId,destination,
  }});
}
function addValidate(name,mutate=()=>{},before=true){
  const s=state(),old=structuredClone(s);mutate(s);
  let oracle;
  try{validateCategories(s,before?old:undefined);oracle={ok:true,value:{valid:true}}}
  catch(error){oracle={ok:false,error:error instanceof Error?error.message:String(error)}}
  trials.push({name,oracle,operation:"validate_categories",payload:{state:s,...(before?{before:old}:{})}});
}
addChange("rename registered leaf keeps all old order price snapshots","a1","악보 받침대","a");
addChange("rename active root adjusts descriptive paths","a","스탠드와 받침대",null);
addChange("same name root no-op keeps original products","a","스탠드",null);
addChange("duplicate sibling name is denied","a1","악세사리","a");
addChange("same name allowed in different parent","b1","악세사리","b");
addChange("blank category name denied","a1","   ","a");
addChange("new root category created","new-root","보조 장비",null);
addChange("new category under parent already having children","new-leaf","신형 제품","a");
addChange("new category under empty parent without attached products","fresh","부품","b1");
addChange("adding new child to directly-linked leaf requires transfer","child","기타 액세서리","b1",false);
addChange("adding child to existing direct-linked leaf transfers with confirmation","child","기타 액세서리","b1",true);
addChange("move leaf to new parent removes historical ancestors","a1","보면대","b");
addChange("move subtree with linked products","a","스탠드","b1");
addChange("rename legacy root that is not linked","b","현악기",null);
addChange("rename with whitespace trimming","a1","  스탠드 보조  ","a");
addChange("rename category under same parent then preserve sales state","a2","마이크 스탠드","a");
addChange("broken parent is rejected","a1","보면대","not-found");
addChange("self-parent cycle is rejected","a1","보면대","a1");
addChange("descendant cycle is rejected","a","스탠드","a1");
addChange("editing existing ID should not create duplicate","a1","스탠드 악세사리","a");
addChange("add child to active leaf with archived product still requires confirmation","child","보조 카포","b1",false,(s)=>{
  s.products[2].deletedAt="2026-10-01";
});
addChange("inactive parent traversal remains available for untouched categories","a1","새 이름","a",false,(s)=>{
  s.categories.find(c=>c.id==="a").active=false;
});
addChange("category with legacy missing parent triggers validation","a1","새 이름","a",false,(s)=>{
  s.categories.push({id:"legacy",name:"옛 분류",parentId:"missing"});
});
addChange("renaming root with circular sibling is denied","a","새 이름",null,false,(s)=>{
  s.categories.find(c=>c.id==="b").parentId="b1";
});
addChange("uncategorized product stays uncategorized","b1","카포 고급","b");

addDelete("delete empty leaf without product","new-empty","",(s)=>{
  s.categories.push({id:"new-empty",name:"빈 분류",parentId:"a"});
});
addDelete("delete linked leaf leaves product uncategorized","a1");
addDelete("delete linked leaf transfers to sibling","a1","a2");
addDelete("delete linked leaf to other parent denied","a1","b1");
addDelete("delete linked leaf to self denied","a1","a1");
addDelete("delete linked leaf into inactive sibling denied","a1","a2",(s)=>{
  s.categories.find(c=>c.id==="a2").active=false;
});
addDelete("deleting parent with child is rejected","a");
addDelete("deleting unknown category rejected","unknown");
addDelete("delete leaf with unknown destination rejected","a1","unknown");
addDelete("delete empty leaf under root with other product assignments","a2","",(s)=>{
  s.products=s.products.filter(p=>p.id!=="p2");
});
addDelete("delete active leaf with sibling destination","b1","b2",(s)=>{
  s.categories.push({id:"b2",name:"스트랩",parentId:"b"});
});
addDelete("delete leaf when destination has children denied","a1","a2",(s)=>{
  s.categories.push({id:"a2child",name:"세부",parentId:"a2"});
});
addDelete("deleting cyclic category still rejects child","a1","",(s)=>{
  s.categories.find(c=>c.id==="a").parentId="a1";
});
addDelete("delete linked product whose category has no old explicit parent","a1","",(s)=>{
  s.products[0].categories=["a1"];
});

addValidate("unchanged valid category map");
addValidate("duplicate category ID rejected",(s)=>{
  s.categories.push({id:"a1",name:"복제",parentId:"a"});
});
addValidate("blank category name rejected",(s)=>{
  s.categories.find(c=>c.id==="a1").name=" ";
});
addValidate("missing parent rejected",(s)=>{
  s.categories.find(c=>c.id==="a1").parentId="unknown";
});
addValidate("category cycle rejected",(s)=>{
  s.categories.find(c=>c.id==="a").parentId="a1";
});
addValidate("inactive ancestor blocks reassigned product",(s)=>{
  s.categories.find(c=>c.id==="a").active=false;
  s.products[0].categories=["a1"];
});
addValidate("parent with an unselected child blocks reassignment",(s)=>{
  s.products[0].categories=["a"];
});
addValidate("legacy nonexistent category is allowed when product assignment changes",(s)=>{
  s.products[0].categories=["legacy-id"];
});
addValidate("unchanged legacy product assignment remains valid",(s)=>{
  s.products[0].categories=["legacy-id"];
  s.categories.find(c=>c.id==="a1").name="새 이름";
});
addValidate("new product skips existing category reassignment check",(s)=>{
  s.products.push({id:"new",categories:["missing"],category:"미등록"});
});
addValidate("category duplicate without historical baseline",s=>{
  s.categories.push({id:"a1",name:"복제",parentId:"a"});
},false);
addValidate("valid category tree without historical baseline",()=>{},false);

test("original TS and compiled Rust category mutations agree on full state and errors",()=>{
  const cases=trials.map(({operation,payload})=>({operation,payload}));
  const run=spawnSync("cargo",["run","--quiet","--manifest-path",manifest,
    "--bin","parity_runner"],{
    cwd:root,encoding:"utf8",input:JSON.stringify(cases),
    timeout:180000,maxBuffer:32*1024*1024,
  });
  assert.equal(run.status,0,run.stderr||run.error?.message);
  const results=JSON.parse(run.stdout);
  assert.equal(results.length,trials.length);
  trials.forEach((t,i)=>assert.deepEqual(results[i],t.oracle,
    t.name+": native category rule diverged from original TypeScript"));
});
