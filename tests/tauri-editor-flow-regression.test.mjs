import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const read = path => readFileSync(new URL("../"+path, import.meta.url), "utf8");
const src = path => read("src/"+path);
const loadDraftClose = () => {
  let decision = false, prompts = [];
  const transpiled=ts.transpileModule(src("shared/editor-flow.ts"),{
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
  }).outputText;
  const module={exports:{}};
  vm.runInNewContext(transpiled,{module,exports:module.exports,require:(path)=>{
    assert.equal(path,"../dialogs");
    return {confirmAction:async (...args)=>{
      prompts.push(args);
      return decision;
    }};
  }});
  return {close:module.exports.confirmDiscardDraft,
    choose:value=>{decision=value;},
    prompts};
};

test("clean draft closes without a prompt and busy draft never closes",async()=>{
  const a=loadDraftClose();let closed=0;
  assert.equal(await a.close("원문 정정",false,()=>{closed++;}),true);
  assert.equal(closed,1);
  assert.equal(a.prompts.length,0);
  assert.equal(await a.close("원문 정정",true,()=>{closed++;},true),false);
  assert.equal(closed,1);
  assert.equal(a.prompts.length,0);
});

test("dirty draft requires deliberate discard; continuing preserves its contents",async()=>{
  const a=loadDraftClose();let closed=0;
  a.choose(false);
  assert.equal(await a.close("직접 입력 주문",true,()=>{closed++;}),false);
  assert.equal(closed,0);
  assert.equal(a.prompts.length,1);
  assert.equal(a.prompts[0][1].cancel,"계속 편집");
  assert.equal(a.prompts[0][1].accept,"저장 안 함");
  a.choose(true);
  assert.equal(await a.close("직접 입력 주문",true,()=>{closed++;}),true);
  assert.equal(closed,1);
});

test("both freight editors refuse a no-op before versioning or history writes",()=>{
  for(const path of ["ShippingManager.tsx","ProductFreightPanel.tsx"]){
    const content=src(path);
    const method=path.startsWith("Shipping")?"saveEditedRule":"writeRule";
    const start=content.indexOf("const "+method+" = async ");
    assert.ok(start>=0,path);
    const next=content.slice(start,start+190);
    assert.match(next,/if \(!editing \|\| !editingDirty\) return true;/);
    const portion=content.slice(start);
    assert.ok(portion.indexOf("if (!editing || !editingDirty)") <
      portion.indexOf("version: crypto.randomUUID()"));
    assert.ok(portion.indexOf("if (!editing || !editingDirty)") <
      portion.indexOf("history.push"));
  }
});

test("both freight editors display Close and disable Save when unchanged",()=>{
  for (const path of ["ShippingManager.tsx","ProductFreightPanel.tsx"]) {
    const content=src(path);
    assert.match(content,/disabled=\{busy \|\| !editingDirty\}/);
    assert.match(content,/onClick=\{\(\) => void closeEditing\(\)\}>닫기/);
  }
});

test("prices require Enter to save and blur cannot persist silently",()=>{
  const s=src("PriceCell.tsx");
  assert.match(s,/if \(e.key === "Enter"\) \{\s*e.preventDefault\(\);\s*void save\(\);/);
  assert.doesNotMatch(s,/onBlur=\{\(\) => void save\(\)\}/);
  assert.match(s,/onBlur=\{\(\) => \{[^}]+setDraft\(value/);
  assert.match(s,/if \(e.key === "Escape"\)/);
});

test("category change and deletion preserve edits if user declines or save fails",()=>{
  const s=src("CategoryManager.tsx");
  assert.match(s,/const select = async \(c: Category\)/);
  assert.match(s,/if \(!leave.proceed\) return false;/);
  assert.match(s,/const ok = await save\(deleteCategory\(base, current.id\)/);
  assert.match(s,/if \(ok\) \{\s*setSelected\(current.parentId/);
});

test("committed saves never become failed saves solely because UI refresh failed",async()=>{
  const module={exports:{}};
  const transpiled=ts.transpileModule(src("shared/committed-state.ts"),{
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
  }).outputText;
  vm.runInNewContext(transpiled,{module,exports:module.exports});
  const refresh=module.exports.refreshAfterCommittedSave;
  const committed={revision:18};
  const messages=[];
  const success=await refresh("모델군",committed,async(data)=>{
    assert.equal(data,committed);
  },(message,tone)=>messages.push({message,tone}));
  assert.equal(success,true);
  assert.equal(messages.length,0);
  const failed=await refresh("모델군",committed,async()=>{
    throw Error("screen refresh unavailable");
  },(message,tone)=>messages.push({message,tone}));
  assert.equal(failed,false);
  assert.equal(messages.length,1);
  assert.match(messages[0].message,/데이터는 저장됐지만 화면 갱신에 실패했습니다/);
  assert.equal(messages[0].tone,"error");
});

test("template and notice record changes ask before switching away from a dirty editor",()=>{
  const a=src("AutomaticMessageTemplateManager.tsx");
  const n=src("ProvisionalProductNoticeManager.tsx");
  assert.match(a,/requestEditorLeave\(leaveGuard,\(message\)=>onNotice/);
  assert.match(n,/requestEditorLeave\(leaveGuard,\(message\)=>onNotice/);
  assert.match(a,/onClick=\{\(\)=>void chooseTemplate\(id\)\}/);
  assert.match(n,/onClick=\{\(\)=>void chooseProduct\(p.id\)\}/);
  for(const component of [a,n,src("ColorGuidanceManager.tsx")])
    assert.match(component,/refreshAfterCommittedSave/);
});

test("Escape in price editing cannot cancel a future independent Enter save",()=>{
  const cell=src("PriceCell.tsx");
  assert.doesNotMatch(cell,/cancelled\.current/);
  assert.match(cell,/onBlur=\{\(\) => \{[^}]*if \(saving.current/);
});

test("model-group switching checks the saved editor baseline",()=>{
  const s=src("ColorGuidanceManager.tsx");
  assert.match(s,/requestEditorLeave\(leaveGuard,setStatus\)/);
  assert.match(s,/if \(!leave.proceed\) return;\s*setSelected\(g.id\)/);
  assert.doesNotMatch(s,/변경 취소/);
});

test("shared busy guard blocks navigation even when dirty flag clears mid-save",()=>{
  const s=src("shared/page-leave.ts");
  const begin=s.indexOf("export async function requestEditorLeave");
  const section=s.slice(begin,s.indexOf("export async function requestPageLeave",begin));
  assert.ok(section.indexOf("if (guard.busy?.())") <
    section.indexOf("if (!guard.hasChanges())"));
});

test("the product confirmation wizard and retail settings navigation guard drafted choices",()=>{
  const issue=src("IssueResolver.tsx");
  const retail=src("orders/RetailOrderDialog.tsx");
  assert.match(issue,/const hasUnsavedSelection =/);
  assert.match(issue,/confirmDiscardDraft\("상품 확인 절차",hasUnsavedSelection,onClose,busy\)/);
  assert.match(issue,/onClose=\{closeDraft\} busy=\{busy\}/);
  assert.match(issue,/onClick=\{closeDraft\}>닫기/);
  assert.match(retail,/!sameValue\(order,initial\.current\),onSettings,busy/);
});

test("draft-only modal Close, X and Escape use the same discard guard",()=>{
  const cases=[
    ["orders/RetailOrderDialog.tsx","onClose={closeDraft}"],
    ["orders/ManualClassification.tsx","onClick={closeDraft}"],
    ["WorkingRawDialog.tsx","onClose={closeDraft}"],
    ["OcrReviewDialog.tsx","onClose={closeDraft}"],
    ["OrderItemEditor.tsx","onClose={closeDraft}"],
    ["CorrectionPanel.tsx","onClose={closeDraft}"],
  ];
  for(const [path,matcher] of cases){
    const content=src(path);
    assert.ok(content.includes("confirmDiscardDraft"),path);
    assert.ok(content.includes(matcher),path);
  }
});

test("managed editors label Close as Close; saved settings cannot be undone by a stale Cancel button",()=>{
  for(const path of ["ProductManager.tsx","ClientManager.tsx"]){
    const content=src(path);
    assert.match(content,/onClick=\{\(\) => void close(D\w+|Edit)\(\)\}>닫기/);
  }
  for(const path of ["AutomaticMessageTemplateManager.tsx","ProvisionalProductNoticeManager.tsx"]){
    const content=src(path);
    assert.doesNotMatch(content,/>변경 취소<\/button>/);
    assert.match(content,/변경사항 저장/);
  }
  assert.match(src("ShippingManager.tsx"),/미저장 변경 초기화/);
});
