import { useState } from "react";
import { AutomaticMessageTemplateManager } from "./AutomaticMessageTemplateManager";
import { ProvisionalProductNoticeManager } from "./ProvisionalProductNoticeManager";
import { confirmAction } from "./dialogs";
import { clientCandidates, uid } from "./domain";
import { TierBadge } from "./ManagementUI";
import { ClientWorkbookTools } from "./ClientWorkbookTools";
import { colorLabel, registeredProducts } from "./product-models";
import type { NoticeSink } from "./shared/notices";
import { useAsyncTask } from "./shared/useAsyncTask";
import { sameValue } from "./shared/draft";
import { requestPageLeave, usePageLeaveGuard } from "./shared/page-leave";

import type { Client, State } from "./types";
import { Field, Modal, MoneyInput, clone } from "./ui";
import { AccountPicker } from "./ui/AccountPicker";
import { HelpTooltip } from "./ui/HelpTooltip";
export function ClientManager({
  state,
  onSave,
  onRefresh,
  onNotice,
}: {
  state: State;
  onSave: (s: State) => Promise<void>;
  onRefresh: (committed?: State) => Promise<void>;
  onNotice: NoticeSink;
}) {
  const { busy: savingView, run: runSave } = useAsyncTask(onNotice);
  const [section,setSection]=useState<"clients"|"messages">("clients");
  const [messageSection,setMessageSection]=useState<"general"|"provisional">("general");
  const [originalEdit, setOriginalEdit] = useState<Client>();
  const [excelOpen, setExcelOpen] = useState(false);
  const [messageDirty, setMessageDirty] = useState(false);
  // Keep the product-notice search stable while its editor swaps during tab changes.
  const [noticeSearch, setNoticeSearch] = useState("");
  const [search, setSearch] = useState(""),
    [edit, setEdit] = useState<Client>(),
    [exception, setException] = useState(""),
    [price, setPrice] = useState<number | null>(null);
  const beginEdit = (value: Client) => {
    const next = clone(value);
    setEdit(next);
    setOriginalEdit(clone(next));
    setException("");
    setPrice(null);
  };
  const closeEdit = async () => {
    if (!edit || savingView) return;
    if (originalEdit && !sameValue(edit, originalEdit)) {
      const leave = await requestPageLeave((message) => onNotice(message, "error"));
      if (!leave.proceed) return;
    }
    setEdit(undefined);
    setOriginalEdit(undefined);
  };
  const switchSection = async (next: "clients" | "messages") => {
    if (section === next) return;
    if (section === "messages" && messageDirty) {
      const leave = await requestPageLeave((message) => onNotice(message, "error"));
      if (!leave.proceed) return;
    }
    setMessageDirty(false);
    setSection(next);
  };
  const switchMessageSection = async (next: "general" | "provisional") => {
    if (messageSection === next) return;
    if (messageDirty) {
      const leave = await requestPageLeave((message) => onNotice(message, "error"));
      if (!leave.proceed) return;
    }
    setMessageDirty(false);
    setMessageSection(next);
  };
  const rows = search
    ? clientCandidates(search, state.clients)
    : state.clients.filter((c) => !c.deletedAt);
  const save = async (): Promise<boolean> => {
    if (!edit) return true;
    const result = await runSave(async () => {
      if (!edit.name.trim()) throw Error("거래처명을 입력하세요.");
      if (!edit.address?.trim()) throw Error("거래처 주소를 입력하세요.");
      if (!(edit.phone?.trim() || edit.mobile?.trim()))
        throw Error("거래처 전화번호 또는 휴대폰 번호를 입력하세요.");
      if (edit.preferredAccountId && !state.settings.accounts.some((a) => a.id === edit.preferredAccountId))
        throw Error("설정에 등록된 입금 계좌를 선택하세요.");
      const next = clone(state),
        index = next.clients.findIndex((c) => c.id === edit.id);
      if (index >= 0) next.clients[index] = edit;
      else next.clients.push(edit);
      await onSave(next);
      setEdit(undefined);
      setOriginalEdit(undefined);
      onNotice("거래처를 저장했습니다.", "success");
    });
    return result.ok;
  };
  usePageLeaveGuard({
    label: "거래처",
    hasChanges: () => !!edit && !!originalEdit && !sameValue(edit, originalEdit),
    busy: () => savingView,
    save,
    discard: () => { setEdit(undefined); setOriginalEdit(undefined); },
  });
  return (
    <div className="fixed-manager">
      <nav className="product-subnav" aria-label="거래처 관리 메뉴">
        <button type="button" aria-current={section==="clients"?"page":undefined} onClick={()=>void switchSection("clients")}>거래처 목록</button>
        <button type="button" aria-current={section==="messages"?"page":undefined} onClick={()=>void switchSection("messages")}>자동 메시지 편집</button>
      </nav>
      {section==="messages" ? (
        <div className="management-scroll">
          <nav className="product-subnav" aria-label="자동 메시지 편집 종류">
            <button type="button" aria-current={messageSection==="general"?"page":undefined}
              onClick={()=>void switchMessageSection("general")}>상황별 공통 안내</button>
            <button type="button" aria-current={messageSection==="provisional"?"page":undefined}
              onClick={()=>void switchMessageSection("provisional")}>잠정 상품 선택 안내</button>
          </nav>
          {messageSection==="general"
            ? <AutomaticMessageTemplateManager state={state} onRefresh={onRefresh} onNotice={onNotice} onDirtyChange={setMessageDirty}/>
            : <ProvisionalProductNoticeManager state={state} onRefresh={onRefresh} onNotice={onNotice} onDirtyChange={setMessageDirty} query={noticeSearch} onQueryChange={setNoticeSearch}/>}
        </div>
      ) : (<>
      <div className="management-search">
        <input
          aria-label="거래처 관리 검색"
          placeholder="상호 / 주소 / 전화번호 / 별칭 검색"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      <div className="management-scroll">
        <div className="manager-bar">
          <h2>거래처 관리</h2>
          <div className="actions">
            <button type="button" aria-expanded={excelOpen} onClick={() => setExcelOpen((open) => !open)}>Excel 관리</button>
          <button
            className="primary"
            onClick={() =>
              beginEdit({
                id: uid(),
                name: "",
                displayName: "",
                address: "",
                phone: "",
                tier: "wholesale",
                payment: "PREPAID",
                shippingFeeExcluded: false,
                active: true,
                contact: "",
                identifiers: "",
                overrides: {},
              })
            }
          >
            ＋ 거래처 등록
          </button>
          </div>
        </div>
        {excelOpen && (
          <section className="card client-excel-panel">
            <ClientWorkbookTools onSave={onSave} onRefresh={onRefresh} onNotice={onNotice} />
          </section>
        )}
        <section className="card">
          <table className="client-table">
            <thead>
              <tr>
                <th>거래처</th>
                <th>발송인 정보</th>
                <th>거래 조건</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr
                  key={c.id}
                  tabIndex={0}
                  onClick={() => beginEdit(c)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") beginEdit(c);
                  }}
                >
                  <td>
                    <b>{c.name}</b>
                    {c.displayName && c.displayName !== c.name && (
                      <small className="client-list-meta">{c.displayName}</small>
                    )}
                  </td>
                  <td>
                    <span>{c.address}</span>
                    <small className="client-list-meta">{[c.phone, c.mobile].filter(Boolean).join(" / ") || "연락처 미등록"}</small>
                  </td>
                  <td>
                    <TierBadge client={c} />
                    <small className="client-list-meta">
                      {[
                        c.payment === "POSTPAID" ? "후불" : "선입금",
                        c.defaultApplyVat ? "부가세 포함" : "부가세 별도",
                        c.shippingFeeExcluded ? "운임 청구 제외" : "",
                        !c.active ? "거래 중지" : "",
                      ].filter(Boolean).join(" / ")}
                    </small>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!rows.length && <p className="empty">검색 결과가 없습니다.</p>}
        </section>
        {edit && (
          <Modal
            draft={edit}
            busy={savingView}
            title={state.clients.some((c) => c.id === edit.id) ? "거래처 상세 관리" : "거래처 등록"}
            className="client-editor-modal"
            onClose={() => void closeEdit()}
          >
            <div className="client-editor-body">
              <section className="client-editor-section">
                <h3>거래처 식별</h3>
                <div className="client-editor-grid">
                  <Field label="거래처명" help={{ purpose: "거래처를 검색하고 주문을 관리할 때 사용할 이름을 정합니다.", when: "새 거래처를 등록하거나 기존 거래처의 이름을 변경할 때 사용합니다.", steps: ["실제 거래처 상호를 입력합니다.", "다른 필수 정보를 입력한 후 거래처를 저장합니다."], result: "접수 화면과 거래처 목록에 이 이름으로 표시됩니다." }}>
              <input
                value={edit.name}
                aria-invalid={!edit.name.trim()}
                onChange={(e) => setEdit({ ...edit, name: e.target.value })}
              />
                  </Field>
                  <Field label="송장 표시 상호" help={{ purpose: "택배를 보낼 때 운송장에 표시할 보내는 사람의 상호를 정합니다.", when: "거래처의 실제 상호와 운송장에 인쇄할 상호가 다를 때 사용합니다.", steps: ["운송장에 표시할 상호를 입력합니다.", "거래처 정보를 저장합니다."], result: "대리발송 운송장을 만들 때 이 상호를 사용합니다.", caution: "비워두면 거래처명을 사용합니다." }}>
              <input
                value={edit.displayName ?? ""}
                onChange={(e) => setEdit({ ...edit, displayName: e.target.value })}
              />
                  </Field>

                  <div className="client-editor-wide">
                  <Field label="검색 태그" help={{ purpose: "거래처를 다른 이름이나 약칭으로도 쉽게 찾을 수 있도록 합니다.", when: "거래처 이름 외에 자주 사용하는 호칭이 있을 때 사용합니다.", steps: ["검색에 사용할 이름이나 약칭을 쉼표로 구분하여 입력합니다.", "거래처를 저장합니다.", "거래처 검색창에서 등록한 단어로 검색합니다."], result: "검색할 때 거래처를 더 쉽게 찾을 수 있습니다." }}>
              <input
                value={[edit.shortNames, edit.identifiers].filter(Boolean).join(", ")}
                onChange={(e) => setEdit({ ...edit, shortNames: e.target.value, identifiers: "" })}
              />
                  </Field>
                  </div>
                </div>
              </section>
              <section className="client-editor-section">
                <h3>발송인 정보</h3>
                <div className="client-editor-grid">
                  <div className="client-editor-wide">
                  <Field label="거래처 주소" help={{ purpose: "대리발송 택배 운송장에 사용할 거래처의 보내는 사람 주소를 저장합니다.", steps: ["거래처의 발송인 주소를 정확하게 입력합니다.", "연락처와 함께 거래처를 저장합니다."], result: "해당 거래처가 보내는 사람인 주문에서 주소를 사용할 수 있습니다.", caution: "주소를 입력하지 않으면 거래처를 저장할 수 없습니다." }}>
              <input
                value={edit.address ?? ""}
                aria-invalid={!edit.address?.trim()}
                onChange={(e) => setEdit({ ...edit, address: e.target.value })}
              />
                  </Field>
                  </div>
                  <Field label="전화번호">
              <input
                value={edit.phone ?? ""}
                aria-invalid={!edit.phone?.trim() && !edit.mobile?.trim()}
                onChange={(e) => setEdit({ ...edit, phone: e.target.value })}
              />
                  </Field>
                  <Field label="휴대폰번호">
              <input
                value={edit.mobile ?? ""}
                aria-invalid={!edit.phone?.trim() && !edit.mobile?.trim()}
                onChange={(e) => setEdit({ ...edit, mobile: e.target.value })}
              />
                  </Field>

                </div>
              </section>
              <section className="client-editor-section">
                <h3>거래 조건</h3>
                <div className="client-editor-grid">

                    <Field label="가격 등급" help={{ purpose: "거래처에 적용할 상품 가격 종류를 정합니다.", steps: ["도매, 반도매, 소매, 특수 중 하나를 선택합니다.", "거래처 정보를 저장합니다."], result: "이 거래처의 새 주문에서 해당 가격 기준을 사용합니다.", caution: "특수 등급에서는 상품별 별도 가격을 지정할 수 있습니다." }}>
                <select
                  value={edit.tier}
                  onChange={(e) => setEdit({ ...edit, tier: e.target.value as Client["tier"] })}
                >
                  <option value="wholesale">도매</option>
                  <option value="semi">반도매</option>
                  <option value="retail">소매</option>
                  <option value="special">특수</option>
                </select>
              </Field>
                    <Field label="결제 방식" help={{ purpose: "거래처가 상품 대금을 언제 내는지 정합니다.", steps: ["주문 전에 입금하는 거래처는 선입금을 선택합니다.", "물품 발송 후 입금하는 거래처는 후불을 선택합니다.", "거래처를 저장합니다."], result: "해당 거래처의 주문 처리 순서와 안내 내용에 반영됩니다." }}>
                <select
                  value={edit.payment}
                  onChange={(e) =>
                    setEdit({
                      ...edit,
                      payment: e.target.value as Client["payment"],
                    })
                  }
                >
                  <option value="PREPAID">선입금</option>
                  <option value="POSTPAID">후불</option>
                </select>
              </Field>
            
                  <div className="client-editor-wide client-editor-account">
            <div className="account-recommendations">
              <AccountPicker
                label="주 사용 입금계좌"
                help={{ purpose: "거래처에 입금 안내를 보낼 때 우선 사용할 계좌를 미리 지정합니다.", when: "거래처마다 안내할 계좌가 다를 때 사용합니다.", steps: ["설정에 등록된 계좌 중 하나를 선택합니다.", "거래처 정보를 저장합니다."], result: "이 거래처의 입금 안내 문구를 만들 때 선택한 계좌를 먼저 사용합니다.", caution: "미지정 시 상품에 따른 기본 계좌를 사용하며, 주문에서 계좌를 직접 선택하면 그 계좌가 우선합니다." }}
                emptyLabel="미지정 (상품군 추천 계좌 사용)"
                accounts={state.settings.accounts}
                value={edit.preferredAccountId ?? ""}
                onChange={(value) => setEdit({ ...edit, preferredAccountId: value })}
              />
              </div>
                  </div>
                </div>
                <div className="client-editor-flags">
            <div className="client-editor-flag"><label className="check">
              <input
                type="checkbox"
                checked={edit.shippingFeeExcluded}
                onChange={(e) => setEdit({ ...edit, shippingFeeExcluded: e.target.checked })}
              />{" "}
              배송비 청구 제외
            </label>
            <HelpTooltip title="배송비 청구 제외" purpose="이 거래처에 배송비를 따로 청구하지 않도록 설정합니다." when="배송비를 받지 않기로 약속한 거래처에 사용합니다." steps={["체크박스를 선택합니다.", "거래처 정보를 저장합니다."]} result="새 주문의 거래처 기본 조건에 배송비 청구 제외가 반영됩니다." /></div>
            <div className="client-editor-flag"><label className="check">
              <input
                type="checkbox"
                checked={edit.defaultApplyVat ?? false}
                onChange={(e) => setEdit({ ...edit, defaultApplyVat: e.target.checked })}
              />{" "}
              부가세 포함
            </label>
            <HelpTooltip title="부가세 포함" purpose="거래처에 안내하는 금액에 부가세를 포함할지 정합니다." steps={["부가세 포함 거래처라면 선택합니다.", "부가세 별도 거래처라면 선택을 해제합니다.", "거래처 정보를 저장합니다."]} result="이후 주문에 해당 거래처의 기본 부가세 조건이 반영됩니다." /></div>

                </div>
            {edit.tier === "special" && (
              <section className="special-prices">
                <h3>특수 / 예외 품목 단가 <HelpTooltip title="특수 단가" purpose="특정 거래처에만 상품 가격을 다르게 적용할 수 있습니다." when="기본 도매가와 다른 가격으로 판매하기로 약속한 상품이 있을 때 사용합니다." steps={["상품을 선택합니다.", "해당 거래처에 적용할 가격을 입력합니다.", "예외 추가를 누르고 거래처 정보를 저장합니다."]} result="등록한 상품에만 정해진 특수 가격이 적용됩니다." caution="등록하지 않은 상품은 기존 도매가를 사용합니다." /></h3>
                
                {Object.entries(edit.overrides).map(([id, n]) => (
                  <div className="exception-row" key={id}>
                    <span>
                      {registeredProducts(state.products).find((p) =>
                        p.variants.some((v) => v.id === id),
                      )?.name ?? "과거 품목"}{" "}
 / {" "}
                      {colorLabel(
                        state.products.flatMap((p) => p.variants).find((v) => v.id === id)?.color ??
                          "",
                      )}
                    </span>
                    <MoneyInput
                      value={n}
                      onChange={(v) => {
                        if (v !== null)
                          setEdit({
                            ...edit,
                            overrides: { ...edit.overrides, [id]: v },
                          });
                      }}
                    />
                    <button
                      onClick={() => {
                        const overrides = { ...edit.overrides };
                        delete overrides[id];
                        setEdit({ ...edit, overrides });
                      }}
                    >
                      예외 해제
                    </button>
                  </div>
                ))}
                <div className="form-row">
                  <select
                    aria-label="특수 예외 품목"
                    value={exception}
                    onChange={(e) => setException(e.target.value)}
                  >
                    <option value="">예외 품목 / 색상 선택</option>
                    {registeredProducts(state.products).flatMap((p) =>
                      p.variants.map((v) => (
                        <option key={v.id} value={v.id}>
                          {p.name} / {colorLabel(v.color)}
                        </option>
                      )),
                    )}
                  </select>
                  <MoneyInput label="특수 단가" value={price} onChange={setPrice} />
                  <button
                    disabled={!exception || price === null}
                    onClick={() => {
                      if (exception && price !== null) {
                        setEdit({
                          ...edit,
                          overrides: { ...edit.overrides, [exception]: price },
                        });
                        setException("");
                        setPrice(null);
                      }
                    }}
                  >
                    예외 추가
                  </button>
                </div>
              </section>
            )}

              </section>
              {state.clients.some((c) => c.id === edit.id) && (
                <section className="client-editor-section client-editor-history">
            <details>
              <summary>상품 별칭 / 변경 이력</summary>
              {state.aliases
                .filter((a) => a.clientId === edit.id)
                .map((a) => (
                  <p key={a.id}>
                    {a.text} → {state.products.find((p) => p.id === a.productId)?.name}
                  </p>
                ))}
              {edit.history
                ?.slice()
                .reverse()
                .map((h, i) => (
                  <p className="muted" key={i}>
                    {h.at} / {h.field} / {JSON.stringify(h.before)} → {JSON.stringify(h.after)}
                  </p>
                ))}
            </details>

                </section>
              )}
            </div>
            <footer className="client-editor-footer">
              <div className="client-editor-danger">
              {state.clients.some((c) => c.id === edit.id) && <button
                className="danger"
                disabled={!state.clients.some((x) => x.id === edit.id)}
                onClick={async () => {
                  if (
                    !(await confirmAction(
                      "거래처를 삭제할까요? 기존 주문의 송하인과 금액은 그대로 보존합니다.",
                    ))
                  )
                    return;
                  try {
                    const next = clone(state);
                    next.clients.find((c) => c.id === edit.id)!.deletedAt =
                      new Date().toISOString();
                    await onSave(next);
                    setEdit(undefined);
                    onNotice("거래처를 삭제하고 기존 주문 기록을 보존했습니다.");
                  } catch (e) {
                    onNotice(String(e), "error");
                  }
                }}
              >
                거래처 삭제
              </button>}
              </div>
              <div className="client-editor-footer-actions">
                <button type="button" disabled={savingView} onClick={() => void closeEdit()}>취소</button>
              <button className="primary" disabled={savingView} onClick={() => void save()}>
                {savingView ? "저장 중…" : state.clients.some((c) => c.id === edit.id) ? "변경사항 저장" : "거래처 등록"}
              </button>
              </div>
            </footer>
          </Modal>
        )}
      </div>
      </>)}
    </div>
  );
}
