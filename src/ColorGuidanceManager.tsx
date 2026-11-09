import { useEffect, useState } from "react";
import { confirmAction } from "./dialogs";
import { uid } from "./domain";
import { validateColorGuidance } from "./color-guidance";
import { colorLabel, registeredProducts } from "./product-models";
import type { State } from "./types";

export function ColorGuidanceManager({state,onRefresh,query=""}: {
  state:State;onRefresh:()=>Promise<void>;query?:string;
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
  const activeId=groups[selected]?selected:(rows[0]?.id??"");
  const active=groups[activeId];
  const unsaved=JSON.stringify(draft.settings.colorGuidanceGroups??{})!==
    JSON.stringify(baseline.settings.colorGuidanceGroups??{});
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
    edit(g=>{g[id]={name:value,productIds:[],representativeColor:""};});
    setSelected(id);setName("");
  };
  const memberships=new Map(rows.flatMap(g=>g.productIds.map(id=>[id,g.name] as const)));
  const choices=registeredProducts(draft.products).filter(p=>
    search.trim()&&!active?.productIds.includes(p.id)&&
    (p.name+" "+p.code+" "+(p.subtitle??"")).toLocaleLowerCase()
      .includes(search.trim().toLocaleLowerCase())
  ).slice(0,30);
  const save=async()=>{
    if(busy||!unsaved)return;
    setBusy(true);setStatus("");
    try{
      validateColorGuidance(draft);
      if(!window.bando?.patchSettings)throw Error("설정 저장 기능을 사용할 수 없습니다.");
      const latest=await window.bando.load();
      const next=structuredClone(latest);
      next.settings.colorGuidanceGroups=structuredClone(draft.settings.colorGuidanceGroups??{});
      validateColorGuidance(next);
      await window.bando.backup();
      const updated=await window.bando.patchSettings(
        {colorGuidanceGroups:draft.settings.colorGuidanceGroups??{}},
        {colorGuidanceGroups:baseline.settings.colorGuidanceGroups??null}
      );
      setDraft(structuredClone(updated));setBaseline(structuredClone(updated));
      await onRefresh();
      setStatus("대표색상 설정만 저장했습니다. 기존 상품과 주문은 변경하지 않았습니다.");
    }catch(error){setStatus(String(error));}
    finally{setBusy(false);}
  };
  return <section className="family-admin-workspace" aria-label="대표색상 관리">
    <aside className="family-list-panel">
      <header className="family-list-heading">
        <h2>직원 등록 그룹</h2>
        <p>자동으로 묶지 않습니다. 직원이 같은 규격과 가격에 색상만 다른 독립 상품을 묶어 대표색상을 등록하세요.</p>
      </header>
      <div className="family-field">
        <label htmlFor="new-color-group">새 그룹 이름</label>
        <input id="new-color-group" placeholder="직원이 알아보기 쉬운 이름" value={name}
          onChange={e=>setName(e.target.value)}/>
        <button type="button" onClick={add} disabled={busy}>그룹 생성</button>
      </div>
      <div className="family-list-scroll">
        {rows.filter(g=>!query.trim()||(g.name+" "+g.productIds.map(id=>
          draft.products.find(p=>p.id===id)?.name??"").join(" ")).toLocaleLowerCase()
            .includes(query.trim().toLocaleLowerCase())).map(g=>
          <button type="button" key={g.id} onClick={()=>{setSelected(g.id);setSearch("");}}
            className={"family-list-row"+(activeId===g.id?" selected":"")}>
            <span><strong>{g.name}</strong><small>대표색상: {colorLabel(g.representativeColor)||"미지정"}</small></span>
            <span className="family-member-count">{g.productIds.length}개 상품</span>
          </button>)}
        {!rows.length&&<p className="muted">등록된 대표색상 그룹이 없습니다.</p>}
      </div>
    </aside>
    <div className="family-editor-panel">
      {active?<>
        <header className="family-editor-heading">
          <h2>대표색상 안내 설정</h2>
          <button type="button" className="danger" disabled={busy}
            onClick={()=>void (async()=>{
              if(await confirmAction("이 그룹을 삭제할까요? 기존 주문과 상품은 유지됩니다.")){
                edit(g=>{delete g[activeId];});setSelected("");
              }
            })()}>그룹 삭제</button>
        </header>
        <div className="family-editor-scroll">
          <div className="family-field">
            <label htmlFor="color-group-name">그룹 이름</label>
            <input id="color-group-name" value={active.name}
              onChange={e=>edit(g=>{g[activeId].name=e.target.value;})}/>
            <label htmlFor="representative-color">대표색상</label>
            <select id="representative-color" value={active.representativeColor}
              onChange={e=>edit(g=>{g[activeId].representativeColor=e.target.value;})}>
              <option value="">등록된 상품의 색상 선택</option>
              {[...new Map(active.productIds.flatMap(id=>{
                const product=draft.products.find(p=>p.id===id);
                const color=product?.variants[0]?.color;
                return color && !["단일","색상 미표기"].includes(color)
                  ? [[color,colorLabel(color)] as const] : [];
              })).entries()].map(([color,label])=>(
                <option key={color} value={color}>{label}</option>
              ))}
            </select>
            <p className="family-help">직원이 사전에 등록한 대표색상은 발주서의 옵션 오류 창에서 직접 선택할 때만 주문에 적용됩니다. 이후 복사용 안내문에 적용 색상을 통보합니다.</p>
          </div>
          <div className="family-members-section">
            <div className="family-section-heading"><h3>등록한 상품</h3><span>{active.productIds.length}개</span></div>
            <div className="family-member-table">
              {active.productIds.map(id=>{
                const p=draft.products.find(p=>p.id===id);
                return <div className="family-member" key={id}>
                  <div className="family-member-name"><strong>{p?.name??"확인할 상품"}</strong><span>{p?.subtitle}</span></div>
                  <button type="button" disabled={busy} onClick={()=>edit(g=>{
                    g[activeId].productIds=g[activeId].productIds.filter(x=>x!==id);
                  })}>제외</button>
                </div>;
              })}
              {!active.productIds.length&&<p className="muted">상품을 검색해 추가하세요.</p>}
            </div>
          </div>
          <div className="family-members-section">
            <div className="family-section-heading"><h3>기존 상품 검색 및 추가</h3></div>
            <input aria-label="대표색상 그룹 상품 검색" value={search}
              placeholder="상품명이나 모델코드로 찾아서 추가"
              onChange={e=>setSearch(e.target.value)}/>
            <div className="family-search-results">
              {choices.map(p=><div className="family-member" key={p.id}>
                <div className="family-member-name"><strong>{p.name}</strong>
                  <span>{p.subtitle}</span>
                  {memberships.has(p.id)&&<small>현재 그룹: {memberships.get(p.id)}</small>}
                </div>
                <button type="button" disabled={busy||memberships.has(p.id)} onClick={()=>edit(g=>{
                  g[activeId].productIds.push(p.id);
                })}>추가</button>
              </div>)}
              {search.trim()&&!choices.length&&<p className="muted">일치하는 상품이 없습니다.</p>}
            </div>
          </div>
        </div>
      </>:<p className="muted">그룹을 만든 다음 상품과 대표색상을 직접 설정하세요.</p>}
      <footer className="family-editor-footer">
        <span role="status" className="muted">{status||(unsaved?"저장하지 않은 변경사항 있음":"변경사항 없음")}</span>
        <div className="family-footer-actions">
          <button type="button" disabled={!unsaved||busy} onClick={()=>{
            setDraft(structuredClone(state));setBaseline(structuredClone(state));setSelected("");setStatus("");
          }}>변경 취소</button>
          <button type="button" className="primary" disabled={!unsaved||busy}
            onClick={()=>void save()}>{busy?"저장 중":"변경사항 저장"}</button>
        </div>
      </footer>
    </div>
  </section>;
}
