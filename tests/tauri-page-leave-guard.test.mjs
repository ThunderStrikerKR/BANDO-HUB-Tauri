import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";

const source = readFileSync(new URL("../src/shared/page-leave.ts", import.meta.url), "utf8");
const transpiled = ts.transpileModule(source
  .replace(/^import .*;\r?\n/gm, "")
  .replace(/export /g, ""), {
  compilerOptions:{target: ts.ScriptTarget.ES2022, module:ts.ModuleKind.None}
}).outputText;

function makeGuard(choice) {
  let currentChoice=choice;
  const module = new Function("useRef", "useEffect", "askSaveChanges",
    transpiled + "\nreturn { usePageLeaveGuard, requestPageLeave };");
  const cleanups=[];
  const app=module((value)=>({current:value}), (effect)=>{cleanups.push(effect());},
    async ()=>currentChoice);
  return {app, cleanups, setChoice:(value)=>{currentChoice=value;}};
}

test("page guard offers three distinct leave decisions", async () => {
  const x=makeGuard("cancel"); let saved=0, discarded=0;
  x.app.usePageLeaveGuard({hasChanges:()=>true,save:async()=>{saved++;return true;},
    discard:()=>{discarded++;},label:"상품"});
  assert.deepEqual(await x.app.requestPageLeave(()=>{}),{proceed:false,handled:false});
  assert.equal(saved,0); assert.equal(discarded,0);
  x.setChoice("save");
  assert.deepEqual(await x.app.requestPageLeave(()=>{}),{proceed:true,handled:true});
  assert.equal(saved,1); assert.equal(discarded,0);
  x.setChoice("discard");
  assert.deepEqual(await x.app.requestPageLeave(()=>{}),{proceed:true,handled:true});
  assert.equal(discarded,1);
  x.cleanups.forEach(fn=>fn());
});

test("failed saves or active work prevent navigation and do not discard edits", async () => {
  const x=makeGuard("save");let discarded=0;
  x.app.usePageLeaveGuard({hasChanges:()=>true,save:async()=>false,discard:()=>{discarded++;}});
  assert.deepEqual(await x.app.requestPageLeave(()=>{}),{proceed:false,handled:false});
  assert.equal(discarded,0);
  x.cleanups.forEach(fn=>fn());
  const y=makeGuard("discard");let error="";
  y.app.usePageLeaveGuard({hasChanges:()=>true,save:async()=>true,discard:()=>{discarded++;},
    busy:()=>true});
  assert.deepEqual(await y.app.requestPageLeave(msg=>{error=msg;}),{proceed:false,handled:false});
  assert.match(error,/저장/);
  assert.equal(discarded,0);
  y.cleanups.forEach(fn=>fn());
});
