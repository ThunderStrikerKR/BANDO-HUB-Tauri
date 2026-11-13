import { useEffect, useState } from "react";
import { HelpTooltip } from "./ui/HelpTooltip";
import { usePendingChanges } from "./shared/pending-changes";
import { usePageLeaveGuard } from "./shared/page-leave";
import {
  AUTOMATIC_MESSAGE_TEMPLATES, AUTOMATIC_TEMPLATE_IDS,
  previewAutomaticTemplate, validateAutomaticMessageTemplates,
} from "./automatic-message-templates";
import type { AutomaticTemplateId, AutomaticTemplateEdits } from "./automatic-message-templates";
import type { State } from "./types";
import type { NoticeSink } from "./shared/notices";

export function AutomaticMessageTemplateManager({
  state,onRefresh,onNotice,onDirtyChange,
}:{
  state:State;onRefresh:(committed?:State)=>Promise<void>;onNotice:NoticeSink;onDirtyChange?:(dirty:boolean)=>void;
}) {
  const [baseline,setBaseline]=useState<AutomaticTemplateEdits>(()=>structuredClone(state.settings.automaticMessageTemplates??{}));
  const [draft,setDraft]=useState<AutomaticTemplateEdits>(()=>structuredClone(state.settings.automaticMessageTemplates??{}));
  const [selected,setSelected]=useState<AutomaticTemplateId>("colorDefault");
  const [status,setStatus]=useState("");
  const [busy,setBusy]=useState(false);
  // A template that displays the built-in text is unchanged even if an
  // explicit duplicate override was temporarily entered.
  const dirty=Object.entries(AUTOMATIC_MESSAGE_TEMPLATES).some(([id,definition])=>
    (baseline[id as AutomaticTemplateId]??definition.body)!==
    (draft[id as AutomaticTemplateId]??definition.body));
  usePendingChanges(dirty);
  useEffect(()=>{onDirtyChange?.(dirty);},[dirty,onDirtyChange]);
  useEffect(()=>{
    if(!dirty){
      const current=structuredClone(state.settings.automaticMessageTemplates??{});
      setBaseline(current);setDraft(structuredClone(current));
    }
    // Keep local unsaved changes until an explicit save/reset.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[state]);
  const def=AUTOMATIC_MESSAGE_TEMPLATES[selected];
  const value=draft[selected]??def.body;
  const edit=(next:string)=>{
    setDraft(previous=>({...previous,[selected]:next}));
    setStatus("");
  };
  const restore=()=>{
    setDraft(previous=>{
      const next={...previous};
      delete next[selected];
      return next;
    });setStatus("");
  };
  const save = async (): Promise<boolean> => {
    if (busy || !dirty) return !dirty && !busy;
    setBusy(true);setStatus("");
    try{
      validateAutomaticMessageTemplates(draft);
      if(!window.bando?.patchSettings)throw Error("설정 저장 기능을 사용할 수 없습니다.");
      const latest=await window.bando.load();
      const expected=Object.keys(baseline).length ? baseline : null;
      const candidate=structuredClone(latest);
      candidate.settings.automaticMessageTemplates=structuredClone(draft);
      validateAutomaticMessageTemplates(candidate.settings.automaticMessageTemplates);
      await window.bando.backup();
      const updated=await window.bando.patchSettings(
        {automaticMessageTemplates:draft},
        {automaticMessageTemplates:expected},
      );
      const saved=structuredClone(updated.settings.automaticMessageTemplates??{});
      setBaseline(saved);setDraft(structuredClone(saved));
      await onRefresh(updated);
      setStatus("상황별 자동 메시지를 저장했습니다.");
      onNotice("자동 메시지 설정을 저장했습니다.","success");
      return true;
    }catch(error){
      setStatus(String(error));
      onNotice(String(error),"error");
      return false;
    }finally{setBusy(false);}
  };
  usePageLeaveGuard({
    label: "상황별 자동 메시지",
    hasChanges: () => dirty,
    busy: () => busy,
    save,
    discard: () => { setDraft(structuredClone(baseline)); setStatus(""); },
  });
  return <section className="family-admin-workspace" aria-label="자동 메시지 편집">
    <aside className="family-list-panel">
      <header className="family-list-heading">
        <h2>상황별 자동 메시지 <HelpTooltip title="상황별 자동 메시지" purpose="거래처에 복사해서 보낼 안내 문구를 상황에 맞게 미리 수정합니다." when="자주 사용하는 확인 요청이나 입금 안내 문구를 바꾸고 싶을 때 사용합니다." steps={["왼쪽 목록에서 수정할 안내 문구를 선택합니다.", "오른쪽 입력창에서 문구를 수정합니다.", "아래 미리보기로 실제 안내 문장을 확인합니다.", "변경사항 저장을 눌러 저장합니다."]} result="새로 생성하는 복사용 안내 문구에 저장한 내용이 적용됩니다." caution="금액 계산이나 주문 자체는 바뀌지 않습니다." /></h2>
      </header>
      <div className="family-list-scroll">
        {(["확인 안내","색상 및 수량","모델 및 옵션","입금 안내"] as const).map(category=>
          <div key={category}>
            <h3>{category}</h3>
            {AUTOMATIC_TEMPLATE_IDS.filter(id=>AUTOMATIC_MESSAGE_TEMPLATES[id].category===category)
              .map(id=><button key={id} type="button"
                onClick={()=>{setSelected(id);setStatus("");}}
                className={"family-list-row"+(id===selected?" selected":"")}>
                  <span><strong>{AUTOMATIC_MESSAGE_TEMPLATES[id].label}</strong>
                    <small>{draft[id]!==undefined?"수정됨":"기본 문구"}</small>
                  </span>
                </button>)}
          </div>)}
      </div>
    </aside>
    <div className="family-editor-panel">
      <header className="family-editor-heading"><h2>{def.label}</h2>
        <button type="button" disabled={busy||draft[selected]===undefined} onClick={restore}>기본 문구 복원</button>
      </header>
      <div className="family-editor-scroll">
        <div className="family-inline-help">
          <HelpTooltip title={def.label} purpose="선택한 상황에서 거래처에 보여줄 안내 문장을 수정합니다." when={def.description} steps={["아래 입력창에서 안내 문장을 바꿉니다.", "미리보기에서 결과를 확인합니다.", "변경사항 저장을 누릅니다."]} result="같은 상황의 새 안내 메시지를 만들 때 수정한 문장이 사용됩니다." />
        </div>
        <div className="family-field">
          <label htmlFor="auto-template-edit">복사용 자동 메시지 편집</label>
          <textarea id="auto-template-edit" aria-label="선택한 자동 메시지 편집" rows={6}
            value={value} disabled={busy} onChange={e=>edit(e.target.value)}/>
        </div>
        <p className="muted">안내문에 넣을 수 있는 자동 표시 항목: <HelpTooltip title="자동 표시 항목" purpose="주문마다 달라지는 이름, 상품명, 금액을 안내 문구에 자동으로 넣을 수 있습니다." when="주문마다 다른 내용을 직접 다시 입력하지 않으려고 사용할 때 필요합니다." steps={["아래에 표시된 중괄호로 감싼 단어를 문구에 넣습니다.", "미리보기로 바뀐 값을 확인합니다.", "필수로 표시된 항목은 삭제하지 않고 저장합니다."]} result="복사용 메시지를 만들 때 실제 주문 정보로 바뀌어 표시됩니다." caution="괄호 안의 단어를 임의로 바꾸면 저장되지 않을 수 있습니다." /> {def.variables.length
          ? def.variables.map(v=>"{" + v + "}").join(", ")
          : "없음"}
          {def.required.length ? " (필수 변수는 삭제할 수 없습니다.)":""}
        </p>
        <div className="card">
          <h3>예시 미리보기</h3>
          <p style={{whiteSpace:"pre-wrap"}}>{previewAutomaticTemplate(selected,value)}</p>
        </div>

      </div>
      <footer className="family-editor-footer">
        <span role="status" className="muted">{status||(dirty?"저장하지 않은 변경사항 있음":"변경사항 없음")}</span>
        <div className="family-footer-actions">

          <button type="button" className="primary" disabled={!dirty||busy} onClick={()=>void save()}>
            {busy?"저장 중":"변경사항 저장"}
          </button>
        </div>
      </footer>
    </div>
  </section>;
}
