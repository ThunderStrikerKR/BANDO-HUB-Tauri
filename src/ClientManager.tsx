import { useState } from "react";
import { confirmAction } from "./dialogs";
import { clientCandidates, uid } from "./domain";
import { TierBadge } from "./ManagementUI";
import { ClientWorkbookTools } from "./ClientWorkbookTools";
import { colorLabel, registeredProducts } from "./product-models";
import type { NoticeSink } from "./shared/notices";
import { useAsyncTask } from "./shared/useAsyncTask";
import type { Client, State } from "./types";
import { Field, Modal, MoneyInput, clone } from "./ui";
import { AccountPicker } from "./ui/AccountPicker";
export function ClientManager({
  state,
  onSave,
  onRefresh,
  onNotice,
}: {
  state: State;
  onSave: (s: State) => Promise<void>;
  onRefresh: () => Promise<void>;
  onNotice: NoticeSink;
}) {
  const { busy: savingView, run: runSave } = useAsyncTask(onNotice);
  const [search, setSearch] = useState(""),
    [edit, setEdit] = useState<Client>(),
    [exception, setException] = useState(""),
    [price, setPrice] = useState<number | null>(null);
  const rows = search
    ? clientCandidates(search, state.clients)
    : state.clients.filter((c) => !c.deletedAt);
  const save = async () => {
    if (!edit) return;
    await runSave(async () => {
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
      onNotice("거래처를 저장했습니다.", "success");
    });
  };
  return (
    <div className="fixed-manager">
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
          <button
            className="primary"
            onClick={() =>
              setEdit({
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
        <section className="card">
          <BulkTools kind="clients" onRefresh={onRefresh} onError={onNotice} />
          <table className="client-table">
            <thead>
              <tr>
                <th>상호</th>
                <th>주소</th>
                <th>전화번호</th>
                <th>가격등급</th>
                <th>특이사항</th>
                <th>별칭</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr
                  key={c.id}
                  tabIndex={0}
                  onClick={() => setEdit(clone(c))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") setEdit(clone(c));
                  }}
                >
                  <td>
                    <b>{c.name}</b>
                  </td>
                  <td>{c.address}</td>
                  <td>{c.phone || c.mobile}</td>
                  <td>
                    <TierBadge client={c} />
                  </td>
                  <td>
                    {[
                      c.defaultApplyVat ? "부가세 포함" : "",
                      c.payment === "POSTPAID" ? "후불 거래" : "",
                      c.shippingFeeExcluded ? "운임 청구 제외" : "",
                      !c.active ? "거래 중지" : "",
                    ]
                      .filter(Boolean)
                      .join(" / ")}
                  </td>
                  <td>{[c.shortNames, c.identifiers].filter(Boolean).join(" / ")}</td>
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
            title="거래처 상세 관리"
            onClose={() => {
              if (!savingView) setEdit(undefined);
            }}
          >
            <Field label="거래처명 (관리용)">
              <p className="muted">거래처 검색과 내부 주문 관리에 사용하는 공식 이름입니다.</p>
              <input
                value={edit.name}
                onChange={(e) => setEdit({ ...edit, name: e.target.value })}
              />
            </Field>
            <Field label="송장 표시 상호 (선택)">
              <p className="muted">택배 운송장의 송하인에 표시합니다. 비우면 거래처명을 사용합니다.</p>
              <input
                value={edit.displayName ?? ""}
                onChange={(e) => setEdit({ ...edit, displayName: e.target.value })}
              />
            </Field>
            <Field label="거래처 주소 *">
              <input
                value={edit.address ?? ""}
                onChange={(e) => setEdit({ ...edit, address: e.target.value })}
              />
            </Field>
            <Field label="거래처 전화번호 또는 휴대폰 *">
              <p className="muted">전화번호 또는 휴대폰 번호 중 하나는 반드시 입력하세요.</p>
              <input
                value={edit.phone ?? ""}
                onChange={(e) => setEdit({ ...edit, phone: e.target.value })}
              />
            </Field>
            <Field label="거래처 휴대폰 번호">
              <input
                value={edit.mobile ?? ""}
                onChange={(e) => setEdit({ ...edit, mobile: e.target.value })}
              />
            </Field>
            <Field label="거래처 별칭 (선택)">
              <p className="muted">거래처 검색과 발주서 거래처 인식에 사용할 다른 이름입니다.</p>
              <input
                value={edit.shortNames ?? ""}
                onChange={(e) => setEdit({ ...edit, shortNames: e.target.value })}
              />
            </Field>
            <Field label="검색 식별자">
              <input
                value={edit.identifiers}
                onChange={(e) => setEdit({ ...edit, identifiers: e.target.value })}
              />
            </Field>
            <div className="account-recommendations">
              <AccountPicker
                label="주 사용 입금계좌 (선택)"
                emptyLabel="미지정 (상품군 추천 계좌 사용)"
                accounts={state.settings.accounts}
                value={edit.preferredAccountId ?? ""}
                onChange={(value) => setEdit({ ...edit, preferredAccountId: value })}
              />
              <p className="muted">
                거래처별 안내 문구에 가장 먼저 사용할 계좌입니다. 미선택 시 반도스탠드 / 반도몰 추천 계좌가 적용됩니다.
                주문에서 직접 지정한 계좌가 있다면 그 계좌가 우선합니다.
              </p>
            </div>
            <div className="form-row">
              <Field label="가격 등급">
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
              <Field label="결제 방식">
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
            </div>
            <label className="check">
              <input
                type="checkbox"
                checked={edit.shippingFeeExcluded}
                onChange={(e) => setEdit({ ...edit, shippingFeeExcluded: e.target.checked })}
              />{" "}
              배송비 청구 제외
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={edit.defaultApplyVat ?? false}
                onChange={(e) => setEdit({ ...edit, defaultApplyVat: e.target.checked })}
              />{" "}
              부가세 기본 적용
            </label>
            {edit.tier === "special" && (
              <section className="special-prices">
                <h3>특수 / 예외 품목 단가</h3>
                <p className="muted">
                  기본 도매가를 적용하고 직접 지정한 품목만 특수 단가를 적용합니다.
                </p>
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
            <div className="row-end">
              <button
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
              </button>
              <button className="primary" disabled={savingView} onClick={() => void save()}>
                {savingView ? "저장 중…" : "거래처 저장"}
              </button>
            </div>
          </Modal>
        )}
      </div>
    </div>
  );
}
