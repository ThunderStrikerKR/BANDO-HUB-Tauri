import { useEffect, useState } from "react";
import { requestEditorLeave, usePageLeaveGuard } from "./shared/page-leave";
import { sameValue } from "./shared/draft";
import { confirmAction } from "./dialogs";
import { uid } from "./domain";
import { validateModelGroups } from "./model-groups";
import { colorLabel, registeredProducts } from "./product-models";
import type { State } from "./types";
import { Field } from "./ui";
import { Button } from "./ui/Button";
import { ManagementSearch } from "./ui/ManagementSearch";

export function ColorGuidanceManager({state,onRefresh,query="",onQueryChange}: {
  state:State;onRefresh:(committed?:State)=>Promise<void>;query?:string;
  onQueryChange:(query:string)=>void;
}) {
  const [draft,setDraft]=useState<State>(()=>structuredClone(state));
  const [baseline,setBaseline]=useState<State>(()=>structuredClone(state));
  const [selected,setSelected]=useState("");
  const [name,setName]=useState("");
  const [search,setSearch]=useState("");
  const [status,setStatus]=useState("");
  const [busy,setBusy]=useState(false);
  const groups=draft.settings.colorGuidanceGroups ?? {};
  const rows=Object.entries(groups).map(([id,g])=>({id,...g}));
  const activeId=selected && groups[selected]?selected:"";
  const active=groups[activeId];
  const unsaved=!sameValue(draft.settings.colorGuidanceGroups??{},
    baseline.settings.colorGuidanceGroups??{});
  useEffect(()=>{
    if(!unsaved){setDraft(structuredClone(state));setBaseline(structuredClone(state));}
    // Reset clean drafts on incoming state, but preserve edits until saved.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[state]);
  const edit=(fn:(g:NonNullable<State["settings"]["colorGuidanceGroups"]>)=>void)=>{
    setDraft(previous=>{
      const next=structuredClone(previous);
      fn(next.settings.colorGuidanceGroups??={});
      return next;
    });
    setStatus("");
  };
  const add=()=>{
    const value=name.trim();
    if(!value){setStatus("그룹 이름을 입력하세요.");return;}
    if(rows.some(g=>g.name.trim().toLocaleLowerCase()===value.toLocaleLowerCase())){
      setStatus("이미 같은 이름의 그룹이 있습니다.");return;
    }
    const id=uid();
    edit(g=>{g[id]={name:value,productIds:[],representativeProductId:""};});
    setSelected(id);setName("");
  };
  const memberships=new Map(rows.flatMap(g=>g.productIds.map(id=>[id,g.name] as const)));
  const choices=registeredProducts(draft.products).filter(p=>
    search.trim()&&!active?.productIds.includes(p.id)&&
    (p.name+" "+(p.subtitle??"")).toLocaleLowerCase()
      .includes(search.trim().toLocaleLowerCase())
  ).slice(0,30);
  const save=async(): Promise<boolean>=>{
    if(busy||!unsaved)return !unsaved && !busy;
    setBusy(true);setStatus("");
    try{
      validateModelGroups(draft);
      if(!window.bando?.patchSettings)throw Error("설정 저장 기능을 사용할 수 없습니다.");
      const latest=await window.bando.load();
      const next=structuredClone(latest);
      next.settings.colorGuidanceGroups=structuredClone(draft.settings.colorGuidanceGroups??{});
      validateModelGroups(next);
      await window.bando.backup();
      const updated=await window.bando.patchSettings(
        {colorGuidanceGroups:draft.settings.colorGuidanceGroups??{}},
        {colorGuidanceGroups:baseline.settings.colorGuidanceGroups??null}
      );
      setDraft(structuredClone(updated));setBaseline(structuredClone(updated));
      await onRefresh(updated);
      setStatus("모델군 설정을 저장했습니다. 기존 상품과 주문은 변경하지 않았습니다.");
      return true;
    }catch(error){setStatus(String(error));return false;}
    finally{setBusy(false);}
  };
  const discardDraft = () => {
    // The last confirmed save is the baseline. The state prop may still be
    // older while a refresh is finishing, so never use it to undo a saved edit.
    setDraft(structuredClone(baseline));
    setSelected("");
    setName("");
    setSearch("");
    setStatus("");
  };
  const leaveGuard = {
    label: "모델군 관리",
    hasChanges: () => unsaved || name.trim().length > 0,
    busy: () => busy,
    save: async () => {
      if (name.trim().length > 0) {
        setStatus("새 그룹 이름은 먼저 그룹 생성으로 등록하세요.");
        return false;
      }
      return save();
    },
    discard: discardDraft,
  };
  usePageLeaveGuard(leaveGuard);
  const closeEditor = async () => {
    const result = await requestEditorLeave(leaveGuard, setStatus);
    if (!result.proceed) return;
    setSelected("");
    setSearch("");
    setStatus("");
  };
  return <section className="family-admin-workspace" aria-label="모델군 관리">
    <aside className="family-list-panel">
      <header className="family-list-heading">
        <h2>직원 등록 모델군</h2>
        <p>색상, 크기, 규격, 타공 여부가 다른 상품을 직원이 직접 묶고 그중 대표모델을 정합니다. 자동으로 묶거나 주문에 자동 적용하지 않습니다.</p>
      </header>
      <div className="family-create-form">
        <Field label="새 그룹 이름">
          <input id="new-color-group" placeholder="직원이 알아보기 쉬운 이름" value={name}
            onChange={e=>setName(e.target.value)}/>
        </Field>
        <Button onClick={add} disabled={busy}>그룹 생성</Button>
      </div>
      <div className="management-search-toolbar">
        <ManagementSearch label="상품 검색" placeholder="그룹 이름 또는 상품명 검색"
          value={query} onChange={onQueryChange}/>
      </div>
      <div className="family-list-scroll">
        {rows.filter(g=>!query.trim()||(g.name+" "+g.productIds.map(id=>
          draft.products.find(p=>p.id===id)?.name??"").join(" ")).toLocaleLowerCase()
            .includes(query.trim().toLocaleLowerCase())).map(g=>
          <button type="button" key={g.id} onClick={()=>void (async()=>{
            if (g.id===activeId) return;
            const leave=await requestEditorLeave(leaveGuard,setStatus);
            if (!leave.proceed) return;
            setSelected(g.id);setSearch("");setStatus("");
          })()}
            className={"family-list-row"+(activeId===g.id?" selected":"")}>
            <span><strong>{g.name}</strong><small>대표모델: {draft.products.find(p=>p.id===g.representativeProductId)?.name ?? (g.representativeColor ? "이전 대표색상 " + colorLabel(g.representativeColor) + " / 대표모델 재지정 필요" : "미지정")}</small></span>
            <span className="family-member-count">{g.productIds.length}개 상품</span>
          </button>)}
        {!rows.length&&<p className="muted">등록된 모델군이 없습니다.</p>}
      </div>
    </aside>
    <div className="family-editor-panel">
      {active?<>
        <header className="family-editor-heading">
          <h2>모델군 및 대표모델 설정</h2>
          <Button variant="danger" disabled={busy}
            onClick={()=>void (async()=>{
              if(await confirmAction("이 그룹을 삭제할까요? 기존 주문과 상품은 유지됩니다.")){
                edit(g=>{delete g[activeId];});setSelected("");
              }
            })()}>그룹 삭제</Button>
        </header>
        <div className="family-editor-scroll">
          <div className="family-detail-fields">
            <Field label="그룹 이름">
              <input id="color-group-name" value={active.name}
                onChange={e=>edit(g=>{g[activeId].name=e.target.value;})}/>
            </Field>
          </div>
          <div className="family-members-section">
            <div className="family-section-heading"><h3>상품 추가</h3></div>
            <input aria-label="모델군 상품 검색" value={search}
              placeholder="상품명으로 찾아서 추가"
              onChange={e=>setSearch(e.target.value)}/>
            <div className="family-search-results">
              {choices.map(p=><div className="family-member" key={p.id}>
                <div className="family-member-name"><strong>{p.name}</strong>
                  <span>{p.subtitle}</span>
                  {memberships.has(p.id)&&<small>현재 그룹: {memberships.get(p.id)}</small>}
                </div>
                <Button size="compact" disabled={busy||memberships.has(p.id)} onClick={()=>edit(g=>{
                  g[activeId].productIds.push(p.id);
                })}>추가</Button>
              </div>)}
              {search.trim()&&!choices.length&&<p className="muted">일치하는 상품이 없습니다.</p>}
            </div>
          </div>
          <div className="family-members-section">
            <div className="family-section-heading"><h3>등록한 상품</h3><span>{active.productIds.length}개</span></div>
            {active.representativeColor && !active.representativeProductId && (
              <p className="family-help">이전 대표색상 설정({colorLabel(active.representativeColor)})이 있습니다. 아래 상품의 '대표 지정' 버튼으로 실제 대표모델을 선택하세요.</p>
            )}
            <div className="family-member-table">
              {active.productIds.map(id=>{
                const p=draft.products.find(p=>p.id===id);
                const isRepresentative=active.representativeProductId===id;
                return <div className="family-member" key={id}>
                  <div className="family-member-name"><strong>{p?.name??"확인할 상품"}</strong><span>{p?.subtitle}</span></div>
                  {isRepresentative
                    ? <span className="family-representative-tag">대표모델</span>
                    : <Button size="compact" disabled={busy||!p} onClick={()=>edit(g=>{
                        g[activeId].representativeProductId=id;
                        delete g[activeId].representativeColor;
                      })}>대표 지정</Button>}
                  <Button size="compact" disabled={busy} onClick={()=>edit(g=>{
                    g[activeId].productIds=g[activeId].productIds.filter(x=>x!==id);
                    if(g[activeId].representativeProductId===id)g[activeId].representativeProductId="";
                  })}>제외</Button>
                </div>;
              })}
              {!active.productIds.length&&<p className="muted">위에서 상품을 검색해 추가하세요.</p>}
            </div>
          </div>
        </div>
      </>:<p className="muted">모델군을 만든 다음 상품을 추가하고 대표모델을 직접 지정하세요.</p>}
      {(active || unsaved) && <footer className="family-editor-footer">
        <span role="status" className="muted">{status||(unsaved?"저장하지 않은 변경사항 있음":"변경사항 없음")}</span>
        <div className="family-footer-actions">
          <Button disabled={busy} onClick={()=>void closeEditor()}>닫기</Button>
          {unsaved && <Button variant="primary" disabled={busy}
            onClick={()=>void save()}>{busy?"저장 중":"변경사항 저장"}</Button>}
        </div>
      </footer>}
    </div>
  </section>;
}
