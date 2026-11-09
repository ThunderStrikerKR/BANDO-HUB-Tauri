import { useEffect, useState } from "react";
import {
  AUTOMATIC_MESSAGE_TEMPLATES, AUTOMATIC_TEMPLATE_IDS,
  previewAutomaticTemplate, validateAutomaticMessageTemplates,
} from "./automatic-message-templates";
import type { AutomaticTemplateId, AutomaticTemplateEdits } from "./automatic-message-templates";
import type { State } from "./types";
import type { NoticeSink } from "./shared/notices";

export function AutomaticMessageTemplateManager({
  state,onRefresh,onNotice,
}:{
  state:State;onRefresh:()=>Promise<void>;onNotice:NoticeSink;
}) {
  const [baseline,setBaseline]=useState<AutomaticTemplateEdits>(()=>structuredClone(state.settings.automaticMessageTemplates??{}));
  const [draft,setDraft]=useState<AutomaticTemplateEdits>(()=>structuredClone(state.settings.automaticMessageTemplates??{}));
  const [selected,setSelected]=useState<AutomaticTemplateId>("colorDefault");
  const [status,setStatus]=useState("");
  const [busy,setBusy]=useState(false);
  const dirty=JSON.stringify(baseline)!==JSON.stringify(draft);
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
  const save=async()=>{
    if(busy||!dirty)return;
    setBusy(true);setStatus("");
    try{
      validateAutomaticMessageTemplates(draft);
      if(!window.bando?.patchSettings)throw Error("설정 저장 기능을 사용할 수 없습니다.");
      const latest=await window.bando.load();
      const expected=state.settings.automaticMessageTemplates??null;
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
      await onRefresh();
      setStatus("상황별 자동 메시지를 저장했습니다.");
      onNotice("자동 메시지 설정을 저장했습니다.","success");
    }catch(error){
      setStatus(String(error));
      onNotice(String(error),"error");
    }finally{setBusy(false);}
  };
  return <section className="family-admin-workspace" aria-label="자동 메시지 편집">
    <aside className="family-list-panel">
      <header className="family-list-heading">
        <h2>상황별 자동 메시지</h2>
        <p>수정한 문구는 앞으로 생성되는 복사용 메시지에 적용됩니다.</p>
      </header>
      <div className="family-list-scroll">
        {(["확인 안내","색상 및 수량","입금 안내"] as const).map(category=>
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
        <p>{def.description}</p>
        <div className="family-field">
          <label htmlFor="auto-template-edit">복사용 자동 메시지 편집</label>
          <textarea id="auto-template-edit" aria-label="선택한 자동 메시지 편집" rows={6}
            value={value} disabled={busy} onChange={e=>edit(e.target.value)}/>
        </div>
        <p className="muted">사용 가능한 변수: {def.variables.length
          ? def.variables.map(v=>"{" + v + "}").join(", ")
          : "없음"}
          {def.required.length ? " (필수 변수는 삭제할 수 없습니다.)":""}
        </p>
        <div className="card">
          <h3>예시 미리보기</h3>
          <p style={{whiteSpace:"pre-wrap"}}>{previewAutomaticTemplate(selected,value)}</p>
        </div>
        <p className="muted">이 편집은 안내 문구만 변경합니다. 가격 계산, 주문 확정, 출고 기록은 수정하지 않습니다.</p>
      </div>
      <footer className="family-editor-footer">
        <span role="status" className="muted">{status||(dirty?"저장하지 않은 변경사항 있음":"변경사항 없음")}</span>
        <div className="family-footer-actions">
          <button type="button" disabled={!dirty||busy} onClick={()=>{
            setDraft(structuredClone(baseline));setStatus("");
          }}>변경 취소</button>
          <button type="button" className="primary" disabled={!dirty||busy} onClick={()=>void save()}>
            {busy?"저장 중":"변경사항 저장"}
          </button>
        </div>
      </footer>
    </div>
  </section>;
}
