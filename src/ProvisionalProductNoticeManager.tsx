import { useEffect, useMemo, useState } from "react";
import { registeredProducts } from "./product-models";
import { validateProvisionalProductNotices } from "./provisional-product-notices";
import type { NoticeSink } from "./shared/notices";
import type { State } from "./types";

type NoticeMap = Record<string, string>;
export function ProvisionalProductNoticeManager({
  state,onRefresh,onNotice,
}:{
  state: State;
  onRefresh: () => Promise<void>;
  onNotice: NoticeSink;
}) {
  const [baseline,setBaseline] = useState<NoticeMap | null>(
    () => structuredClone(state.settings.provisionalProductNotices ?? null));
  const [draft,setDraft] = useState<NoticeMap>(
    () => structuredClone(state.settings.provisionalProductNotices ?? {}));
  const [selected,setSelected] = useState("");
  const [query,setQuery] = useState("");
  const [busy,setBusy] = useState(false);
  const [status,setStatus] = useState("");
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline ?? {});
  useEffect(() => {
    if (!dirty) {
      setBaseline(structuredClone(state.settings.provisionalProductNotices ?? null));
      setDraft(structuredClone(state.settings.provisionalProductNotices ?? {}));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[state]);
  const products = useMemo(() => registeredProducts(state.products), [state.products]);
  const visible = products.filter(p =>
    query.trim()
      ? (p.name+" "+p.code+" "+(p.subtitle ?? "")).toLocaleLowerCase()
          .includes(query.trim().toLocaleLowerCase())
      : !!draft[p.id],
  ).sort((a,b) => Number(!!draft[b.id])-Number(!!draft[a.id]) ||
      a.name.localeCompare(b.name,"ko",{numeric:true})).slice(0,80);
  const product = products.find(p => p.id === selected);
  const content = product ? draft[product.id] ?? "" : "";
  const edit = (value: string) => {
    if (!product) return;
    setDraft(previous => {
      const next = {...previous};
      if (value.trim()) next[product.id]=value;
      else delete next[product.id];
      return next;
    });
    setStatus("");
  };
  const save = async () => {
    if (busy || !dirty) return;
    setBusy(true);setStatus("");
    try {
      if (!window.bando?.patchSettings) throw Error("설정 저장 기능을 사용할 수 없습니다.");
      const latest = await window.bando.load();
      const candidate = structuredClone(latest);
      candidate.settings.provisionalProductNotices = structuredClone(draft);
      validateProvisionalProductNotices(candidate);
      await window.bando.backup();
      const updated = await window.bando.patchSettings(
        {provisionalProductNotices:draft},
        {provisionalProductNotices:baseline},
      );
      setBaseline(structuredClone(updated.settings.provisionalProductNotices ?? null));
      setDraft(structuredClone(updated.settings.provisionalProductNotices ?? {}));
      await onRefresh();
      setStatus("상품별 잠정 선택 안내문을 저장했습니다.");
      onNotice("상품별 잠정 선택 안내문을 저장했습니다.","success");
    } catch (error) {
      setStatus(String(error));
      onNotice(String(error),"error");
    } finally {setBusy(false);}
  };
  return <section className="family-admin-workspace" aria-label="잠정 상품 선택 안내">
    <aside className="family-list-panel">
      <header className="family-list-heading">
        <h2>상품별 안내문 등록</h2>
        <p>발주서의 모델이 불명확해 직원이 상품을 잠정 선택한 경우에만 계좌안내에 추가합니다.</p>
      </header>
      <div className="family-field">
        <label htmlFor="provisional-notice-product-search">안내문을 등록할 상품 검색</label>
        <input id="provisional-notice-product-search" value={query}
          placeholder="상품명이나 모델코드 검색" onChange={e=>setQuery(e.target.value)}/>
      </div>
      <div className="family-list-scroll">
        {visible.map(p=><button type="button" key={p.id}
          className={"family-list-row"+(selected===p.id?" selected":"")}
          onClick={()=>{setSelected(p.id);setStatus("");}}>
          <span><strong>{p.name}</strong><small>{draft[p.id] ? "안내문 등록됨" : "안내문 미등록"}</small></span>
        </button>)}
        {!visible.length && <p className="muted">{query.trim()
          ? "검색 결과가 없습니다." : "아직 등록된 안내문이 없습니다. 상품을 검색해 추가하세요."}</p>}
      </div>
    </aside>
    <div className="family-editor-panel">
      {product ? <>
        <header className="family-editor-heading">
          <h2>{product.name}</h2>
          <button type="button" disabled={busy || !draft[product.id]} onClick={()=>edit("")}>안내문 삭제</button>
        </header>
        <div className="family-editor-scroll">
          <p>상품 ID에 연결되는 안내문입니다. 같은 모델명이라도 독립 상품은 각각 등록할 수 있습니다.</p>
          <div className="family-field">
            <label htmlFor="provisional-product-notice">잠정 선택 시 복사용 계좌안내에 추가할 문구</label>
            <textarea id="provisional-product-notice" aria-label="상품별 잠정 선택 안내문" rows={5}
              value={content} disabled={busy}
              placeholder="예: 709는 상판에 구멍이 있습니다. 구멍이 없는 제품은 709-1 모델을 확인해 주세요."
              onChange={e=>edit(e.target.value)}/>
            <p className="family-help">상품명이 원문에 명확하게 기재된 정상 주문에는 나오지 않습니다. 상품 링크의 첨부 여부와는 별개입니다.</p>
          </div>
          <div className="card">
            <h3>계좌안내에 표시될 위치</h3>
            <p>상품명, 수량, 금액</p>
            <p style={{whiteSpace:"pre-wrap"}}>{content.trim() || "이 상품에 등록된 안내문이 없습니다."}</p>
            <p>운임, 합계, 입금 계좌</p>
          </div>
        </div>
      </> : <p className="muted">상품을 검색해서 선택하면 해당 상품의 전용 안내문을 등록할 수 있습니다.</p>}
      <footer className="family-editor-footer">
        <span role="status" className="muted">{status||(dirty?"저장하지 않은 변경사항 있음":"변경사항 없음")}</span>
        <div className="family-footer-actions">
          <button type="button" disabled={!dirty||busy} onClick={()=>{
            setDraft(structuredClone(baseline??{}));setStatus("");
          }}>변경 취소</button>
          <button type="button" className="primary" disabled={!dirty||busy} onClick={()=>void save()}>
            {busy?"저장 중":"변경사항 저장"}
          </button>
        </div>
      </footer>
    </div>
  </section>;
}
