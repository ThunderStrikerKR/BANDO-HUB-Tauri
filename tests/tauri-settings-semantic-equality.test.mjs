import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";

const read = (path) => readFileSync(new URL("../" + path, import.meta.url), "utf8");
const source = read("src/shared/draft.ts");
const compiled = ts.transpileModule(source.replace(/export /g, ""), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
const funcs = new Function(compiled + "\nreturn { sameValue, rebaseDraft };")();

test("settings equality ignores Rust JSON object key order, not changed values", () => {
  const a = { accounts: [{ id:"one", number:"123", bank:"가", holder:"김" }],
    brandAccounts: { BANDOSTAND:"one", BANDOMALL:"" }};
  const b = { brandAccounts:{ BANDOMALL:"", BANDOSTAND:"one" },
    accounts:[{ bank:"가", holder:"김", id:"one", number:"123" }]};
  assert.equal(funcs.sameValue(a,b), true);
  assert.equal(funcs.sameValue(a,{...b,accounts:[]}), false);
  assert.equal(funcs.sameValue(a,{...b,accounts:[{...b.accounts[0],number:"456"}]}), false);
  assert.equal(funcs.sameValue([1,2],[2,1]), false);
});

test("adding and deleting accounts do not produce false conflicts after successful save", () => {
  const base = {accounts:[{id:"one",bank:"가",number:"123",holder:"김"},{id:"two",bank:"나",number:"456",holder:"박"}],
    brandAccounts:{BANDOSTAND:"one",BANDOMALL:"two"}};
  const added = {...base,accounts:[...base.accounts,{id:"three",bank:"다",number:"789",holder:"최"}]};
  const savedAdd = {accounts:added.accounts.map(({id,bank,number,holder})=>({bank,holder,id,number})),
    brandAccounts:{BANDOMALL:"two",BANDOSTAND:"one"}};
  const afterAdd=funcs.rebaseDraft(base,added,savedAdd);
  assert.deepEqual(afterAdd.conflicts,[]);
  assert.equal(funcs.sameValue(afterAdd.draft,savedAdd),true);
  const removed = {accounts:[base.accounts[0]],brandAccounts:{BANDOSTAND:"one",BANDOMALL:""}};
  const savedRemove = {brandAccounts:{BANDOMALL:"",BANDOSTAND:"one"},
    accounts:[{bank:"가",holder:"김",id:"one",number:"123"}]};
  const afterRemove=funcs.rebaseDraft(base,removed,savedRemove);
  assert.deepEqual(afterRemove.conflicts,[]);
  assert.equal(funcs.sameValue(afterRemove.draft,savedRemove),true);
});

test("same settings field changed differently by another actor still conflicts", () => {
  const base = {operatorName:"김",uiScale:100};
  const local = {...base,operatorName:"박"};
  const remote = {...base,operatorName:"최"};
  assert.deepEqual(funcs.rebaseDraft(base,local,remote).conflicts,["operatorName"]);
  assert.deepEqual(funcs.rebaseDraft(base,local,{...base,uiScale:125}).conflicts,[]);
});
