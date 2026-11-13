import { useEffect, useMemo, useState } from "react";
import { HelpTooltip } from "./ui/HelpTooltip";
import { usePendingChanges } from "./shared/pending-changes";
import { usePageLeaveGuard } from "./shared/page-leave";
import { sameValue } from "./shared/draft";
import { registeredProducts } from "./product-models";
import { validateProvisionalProductNotices } from "./provisional-product-notices";
import type { NoticeSink } from "./shared/notices";
import type { State } from "./types";

type NoticeMap = Record<string, string>;
export function ProvisionalProductNoticeManager({
  state,onRefresh,onNotice,onDirtyChange,query,onQueryChange,
}:{
  state: State;
  onRefresh: (committed?: State) => Promise<void>;
  onNotice: NoticeSink;
  onDirtyChange?: (dirty: boolean) => void;
  query: string;
  onQueryChange: (value: string) => void;
}) {
  const [baseline,setBaseline] = useState<NoticeMap | null>(
    () => structuredClone(state.settings.provisionalProductNotices ?? null));
  const [draft,setDraft] = useState<NoticeMap>(
    () => structuredClone(state.settings.provisionalProductNotices ?? {}));
  const [selected,setSelected] = useState("");
  const [busy,setBusy] = useState(false);
  const [status,setStatus] = useState("");
  const dirty = !sameValue(draft,baseline ?? {});
  usePendingChanges(dirty);
  useEffect(() => {onDirtyChange?.(dirty);}, [dirty,onDirtyChange]);
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
      ? (p.name+" "+(p.subtitle ?? "")).toLocaleLowerCase()
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
  const save = async (): Promise<boolean> => {
    if (busy || !dirty) return !dirty && !busy;
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
      await onRefresh(updated);
      setStatus("상품별 잠정 선택 안내문을 저장했습니다.");
      onNotice("상품별 잠정 선택 안내문을 저장했습니다.","success");
      return true;
    } catch (error) {
      setStatus(String(error));
      onNotice(String(error),"error");
      return false;
    } finally {setBusy(false);}
  };
  usePageLeaveGuard({
    label: "상품별 잠정 선택 안내문",
    hasChanges: () => dirty,
    busy: () => busy,
    save,
    discard: () => { setDraft(structuredClone(baseline??{})); setStatus(""); },
  });
  return <section className="family-admin-workspace" aria-label="잠정 상품 선택 안내">
    <aside className="family-list-panel">
      <header className="family-list-heading">
        <h2>상품별 안내문 등록 <HelpTooltip title="상품별 안내문" purpose="발주서의 상품 이름이 불명확할 때 직원이 선택한 상품에 대한 안내를 거래처에 덧붙입니다." when="주문에 적힌 상품명만으로 정확한 모델을 확인하기 어려운 경우 사용합니다." steps={["안내할 상품을 검색해 선택합니다.", "상품별 안내 문장을 작성합니다.", "아래 미리보기에서 안내 위치를 확인합니다.", "변경사항 저장을 누릅니다."]} result="직원이 해당 상품을 잠정 선택한 주문의 계좌 안내에만 문장이 추가됩니다." caution="해당 상품의 모든 주문에 자동으로 표시되지는 않습니다. 금액과 계좌 안내 뒤, 상품 링크 앞에 표시됩니다." /></h2>
      </header>
      <div className="family-field">
        <label htmlFor="provisional-notice-product-search">안내문을 등록할 상품 검색</label>
        <input id="provisional-notice-product-search" defaultValue={query}
          placeholder="상품명 검색" onInput={e=>onQueryChange(e.currentTarget.value)}/>
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
          <div className="family-inline-help">
          <HelpTooltip title="안내문을 등록할 상품" purpose="선택한 상품 하나에만 안내문을 연결합니다." steps={["안내문을 사용할 상품을 선택합니다.", "아래에 문장을 입력하고 저장합니다."]} result="그 상품을 직원이 잠정 선택했을 때만 안내할 수 있습니다." caution="이름이 비슷하더라도 각각 따로 등록된 상품은 안내문을 각각 작성해야 합니다." />
        </div>
          <div className="family-field">
            <label htmlFor="provisional-product-notice">잠정 선택 시 복사용 계좌안내에 추가할 문구</label>
            <textarea id="provisional-product-notice" aria-label="상품별 잠정 선택 안내문" rows={5}
              value={content} disabled={busy}
              placeholder="예: 709는 상판에 구멍이 있습니다. 구멍이 없는 제품은 709-1 모델을 확인해 주세요."
              onChange={e=>edit(e.target.value)}/>

          </div>
          <div className="card">
            <h3>계좌안내에 표시될 위치</h3>
            <p>상품명, 수량, 금액</p>
            <p>운임 및 부가세</p>
            <p>합계, 입금 계좌</p>
            <p style={{whiteSpace:"pre-wrap"}}>{content.trim() || "이 상품에 등록된 안내문이 없습니다."}</p>
            <p>상품 링크 (추가한 경우에만)</p>
          </div>
        </div>
      </> : <p className="muted">상품을 검색해서 선택하면 해당 상품의 전용 안내문을 등록할 수 있습니다.</p>}
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
