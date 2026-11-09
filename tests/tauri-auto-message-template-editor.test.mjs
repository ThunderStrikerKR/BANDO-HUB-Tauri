import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { tsImport } from "tsx/esm/api";
const source = path => readFileSync(new URL("../"+path,import.meta.url),"utf8");

test("new client management tab exposes editable situation templates",()=>{
  const ui=source("src/ClientManager.tsx");
  const editor=source("src/AutomaticMessageTemplateManager.tsx");
  assert.match(ui,/자동 메시지 편집/);
  assert.match(ui,/<AutomaticMessageTemplateManager state=\{state\} onRefresh=\{onRefresh\}/);
  assert.match(editor,/자동 메시지 편집/);
  assert.match(editor,/previewAutomaticTemplate\(selected,value\)/);
  assert.match(editor,/await window.bando\.patchSettings\(/);
  assert.match(editor,/await window.bando\.backup\(\)/);
  assert.match(editor,/기본 문구 복원/);
});

test("all 19 situations have defaults, example previews and permitted tokens",async()=>{
  const {AUTOMATIC_TEMPLATE_IDS,AUTOMATIC_MESSAGE_TEMPLATES,
    previewAutomaticTemplate,renderAutomaticTemplate}=
    await tsImport("../src/automatic-message-templates.ts",import.meta.url);
  assert.equal(AUTOMATIC_TEMPLATE_IDS.length,19);
  for(const key of AUTOMATIC_TEMPLATE_IDS) {
    const def=AUTOMATIC_MESSAGE_TEMPLATES[key];
    assert.ok(def.label && def.body);
    assert.ok(previewAutomaticTemplate(key,def.body));
    assert.equal(renderAutomaticTemplate({},key,def.sample),
      previewAutomaticTemplate(key,def.body));
  }
  assert.equal(renderAutomaticTemplate({automaticMessageTemplates:{colorDefault:"{색상}으로 보내드릴게요."}},
    "colorDefault",{색상:"블랙"}),"블랙으로 보내드릴게요.");
});

test("financial variables and unknown variables are protected",async()=>{
  const {validateAutomaticMessageTemplates}=await tsImport("../src/automatic-message-templates.ts",import.meta.url);
  assert.doesNotThrow(()=>validateAutomaticMessageTemplates({
    colorDefault:"{색상}으로 보내드릴게요.",
    paymentTotal:"입금해 주실 금액은 {합계}입니다.",
    recipientName:"받는 분 성함을 알려주세요.",
  }));
  assert.throws(()=>validateAutomaticMessageTemplates({paymentTotal:"합계는 얼마인가요?"}),/변수를 삭제/);
  assert.throws(()=>validateAutomaticMessageTemplates({paymentAccount:"{계좌번호}"}),/변수를 삭제/);
  assert.throws(()=>validateAutomaticMessageTemplates({colorDefault:"{알수없음}으로 보내드릴게요."}),/지원하지 않는 변수/);
  assert.throws(()=>validateAutomaticMessageTemplates({recipientName:""}),/1자 이상/);
});

test("saved color notice stays declarative and is never a question",async()=>{
  const {appliedDefaultColorNotice}=await tsImport("../src/color-guidance.ts",import.meta.url);
  const item={name:"BD 709",appliedDefaultColor:{color:"Black",groupId:"x"}};
  const settings={automaticMessageTemplates:{colorDefault:"{색상}으로 보내드릴게요."}};
  assert.equal(appliedDefaultColorNotice(item,settings),"블랙으로 보내드릴게요.");
  assert.equal(appliedDefaultColorNotice({...item,appliedDefaultColor:undefined},settings),"");
});

test("editing templates does not modify sale prices or historical orders",()=>{
  const ui=source("src/AutomaticMessageTemplateManager.tsx");
  const native=source("src-tauri/src/lib.rs");
  assert.match(ui,/\{automaticMessageTemplates:draft\}/);
  assert.match(ui,/const expected=Object\.keys\(baseline\)\.length \? baseline : null/);
  assert.doesNotMatch(ui,/state_save|setPrice|write_snapshot/);
  assert.match(native,/"automaticMessageTemplates"/);
  assert.match(native,/validate_message_templates\(&state\)/);
  assert.match(native,/before != &expected\[field\] && before != updated/);
});

test("the live copy pipelines resolve templates for payment, request and color",()=>{
  for(const path of ["src/automatic-message.ts","src/hub-messages.ts","src/domain.ts"])
    assert.match(source(path),/renderAutomaticTemplate/);
  assert.match(source("src/hub-messages.ts"),/appliedDefaultColorNotice\(i,state\.settings\)/);
  assert.match(source("src/automatic-message.ts"),/requestClosing/);
  assert.match(source("src/customer-questions.ts"),/renderAutomaticTemplate/);
});
