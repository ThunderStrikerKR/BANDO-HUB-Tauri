import { HelpTooltip } from "./ui/HelpTooltip";
import { ManagementSearch } from "./ui/ManagementSearch";
import { EmptyState } from "./ui/PageHeading";
import { ManagementTable } from "./ui/ManagementTable";
import { ShippingFeeRanges } from "./ShippingFeeRanges";
import { useEffect, useRef, useState } from "react";
import { businessCoreCall } from "./tauri-bridge";
import { confirmAction } from "./dialogs";
import { registeredProducts, sortProducts } from "./product-models";
import type { NoticeSink } from "./shared/notices";
import { useAsyncTask } from "./shared/useAsyncTask";
import { sameFreightEditor } from "./shared/meaningful-changes";
import { requestEditorLeave, usePageLeaveGuard } from "./shared/page-leave";

import type { ShippingRule, State } from "./types";
import { Field, Modal, MoneyInput, clone } from "./ui";
export function ProductFreightPanel({
  state,
  onSave,
  onNotice,
}: {
  state: State;
  onSave: (state: State) => Promise<void>;
  onNotice: NoticeSink;
}) {
  const { busy, run: runSave } = useAsyncTask(onNotice);
  const stateRef = useRef(state);
  stateRef.current = state;
  type ProductFreightView = {
    group: { id: string; name: string } | null;
    rule: ShippingRule | null;
    editableRule: ShippingRule | null;
  };
  const [nativeView, setNativeView] = useState<{
    state: State; views: Record<string, ProductFreightView>;
  }>();
  useEffect(() => {
    let active = true;
    void businessCoreCall<{ views: Record<string, ProductFreightView> }>(
      "rules", "apply_shipping_action", { action: "product_freight_view", state },
    ).then(({ views }) => {
      if (active) setNativeView({ state, views });
    }).catch((error) => {
      if (active) onNotice("Rust 상품별 운임 조회 실패: " +
        (error instanceof Error ? error.message : String(error)), "error");
    });
    return () => { active = false; };
  }, [state, onNotice]);
  const productViews = nativeView?.state === state ? nativeView.views : undefined;
  const [search, setSearch] = useState(""),
    [onlyMissing, setOnlyMissing] = useState(false),
    [selected, setSelected] = useState<string[]>([]),
    [template, setTemplate] = useState(""),
    [editing, setEditing] = useState<{
      productId: string;
      groupId?: string;
      rule: ShippingRule;
      name: string;
    }>();
  const [initialRule, setInitialRule] = useState<ShippingRule>();
  const rows = sortProducts(
    registeredProducts(state.products).filter(
      (p) => p.catalog !== "DEMO" && !p.variants.some((v) => v.source === "DEMO"),
    ),
  ).filter(
    (p) =>
      (p.name + " " + p.subtitle)
        .toLowerCase()
        .replace(/\s/g, "")
        .includes(search.toLowerCase().replace(/\s/g, "")) &&
      (!onlyMissing || (productViews !== undefined && !productViews[p.id]?.rule)),
  );
  const save = async (next: State, message: string) =>
    (
      await runSave(async () => {
        await onSave(next);
        onNotice(message, "success");
      })
    ).ok;
  const writeRule = async (): Promise<boolean> => {
    if (!editing || !editingDirty) return true;
    // Rust save_product_rule/save_group_rule exclusively validates bundle limits.
    try {
      const { shipping } = await businessCoreCall<{ shipping: NonNullable<State["shipping"]> }>(
        "rules", "apply_shipping_action", {
          action: editing.groupId ? "save_group_rule" : "save_product_rule",
          shipping: state.shipping, groupId: editing.groupId,
          productId: editing.productId, rule: editing.rule,
          versionId: crypto.randomUUID(), now: new Date().toISOString(),
        },
      );
      const ok = await save(
        { ...state, shipping },
        "최대 묶음 수량과 운임을 저장했습니다. 이전 기준은 이력으로 보존합니다.",
      );
      if (ok) { setEditing(undefined); setInitialRule(undefined); }
      return ok;
    } catch (error) {
      onNotice(error instanceof Error ? error.message : String(error), "error");
      return false;
    }
  };
  const copyGroupRule = async (groupId: string, productIds: string[]): Promise<void> => {
    if (!state.shipping || !productIds.length) return;
    try {
      const versionIds = Object.fromEntries(productIds.map((id) => [id, crypto.randomUUID()]));
      const { shipping } = await businessCoreCall<{ shipping: NonNullable<State["shipping"]> }>(
        "rules", "apply_shipping_action", {
          action: "copy_group_rule",
          shipping: state.shipping, groupId, productIds,
          versionIds, now: new Date().toISOString(),
        },
      );
      await save({ ...state, shipping }, "선택 상품에 확인된 공통 운임 기준을 복사했습니다.");
    } catch (error) {
      onNotice(error instanceof Error ? error.message : String(error), "error");
    }
  };
  const editingDirty = !!editing && !!initialRule && !sameFreightEditor(editing.rule, initialRule);
  usePageLeaveGuard({
    label: "상품별 운임",
    hasChanges: () => editingDirty,
    busy: () => busy,
    save: writeRule,
    discard: () => {setEditing(undefined);setInitialRule(undefined);},
  });
  const closeEditing = async () => {
    if (!editing || busy) return;
    if (editingDirty) {
      const leave = await requestEditorLeave({
        label: "상품별 운임",
        hasChanges: () => editingDirty,
        save: writeRule,
        discard: () => { setEditing(undefined); setInitialRule(undefined); },
      }, (message) => onNotice(message, "error"));
      if (!leave.proceed) return;
    }
    setEditing(undefined);
    setInitialRule(undefined);
  };
  return (
    <>
      <section className="shipping-card shipping-product-list">
        <div className="shipping-tools management-search-toolbar">
          <ManagementSearch label="상품별 운임 검색"
            placeholder="모델명 / 상품명 검색"
            value={search} onChange={setSearch}/>
          <label className="check">
            <input
              type="checkbox"
              checked={onlyMissing}
              onChange={(e) => setOnlyMissing(e.target.checked)}
            />{" "}
            개별 기준 / 그룹 미지정만
          </label>
        </div>
        <div className="shipping-bulk">
          <label>
            <input
              type="checkbox"
              aria-label="운임 상품 전체 선택"
              checked={!!rows.length && rows.every((p) => selected.includes(p.id))}
              onChange={(e) => setSelected(e.target.checked ? rows.map((p) => p.id) : [])}
            />{" "}
            {selected.length}개 선택
          </label>
          <select
            aria-label="복사할 공통 운임 기준"
            value={template}
            onChange={(e) => setTemplate(e.target.value)}
          >
            <option value="">확인된 공통 기준 선택</option>
            {state.shipping?.groups
              .filter((g) => !g.deletedAt)
              .map((g) => (
                <option value={g.id} key={g.id}>
                  {g.name}
                </option>
              ))}
          </select>
          <button
            disabled={!template || !selected.length || busy}
            onClick={async () => {
              const group = state.shipping!.groups.find((g) => g.id === template)!;
              if (
                !(await confirmAction(
                  "선택 상품의 개별 운임표에 " +
                    group.name +
                    " 기준을 복사할까요? 동급 그룹 묶음은 별도로 지정합니다.",
                ))
              )
                return;
              void copyGroupRule(template, selected);

            }}
          >
            상품별 기준으로 복사
          </button>
          <HelpTooltip title="상품별 운임" purpose="이 상품을 포장해 보낼 때의 배송비를 등록합니다." when="상품별 기본 배송비와 합포장 수량을 확인했을 때 사용합니다." steps={["배송비를 수정할 상품을 찾습니다.", "설정 버튼을 누릅니다.", "확인된 합포장 수량과 배송비를 입력합니다.", "기본 운임 저장을 눌러 적용합니다."]} result="새 주문에서 해당 상품의 운임 기준을 참고할 수 있습니다." caution="확인되지 않은 운임은 임의로 입력하지 않습니다." />
        </div>
        <div className={"shipping-table-scroll" + (!rows.length ? " shipping-list-empty" : "")}>
          <ManagementTable>
            <thead>
              <tr>
                <th />
                <th>상품명</th>
                <th>동급 배송그룹</th>
                <th>최대 묶음 수량</th>
                <th>운임 등록 상태</th>
                <th>합포장</th>
                <th>최근 수정</th>
                <th>설정</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => {
                const productView = productViews?.[p.id];
                const rule = productView?.rule ?? null;
                const group = productView?.group ?? null;
                return (
                  <tr key={p.id}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={"운임 선택 " + p.name}
                        checked={selected.includes(p.id)}
                        onChange={(e) =>
                          setSelected(
                            e.target.checked
                              ? [...selected, p.id]
                              : selected.filter((id) => id !== p.id),
                          )
                        }
                      />
                    </td>
                    <td className="shipping-product-name" title={p.name}>
                      <strong>{p.name}</strong>
                    </td>
                    <td>{!productView ? "확인 중" : group ? group.name : "미소속"}</td>
                    <td>{!productView ? "확인 중" : rule?.maxConfirmed && rule.maxBundle ? rule.maxBundle + "개" : "확인 필요"}</td>
                    <td>
                      {!productView ? "확인 중" : rule && (typeof rule.perItem === "number" ||
                        Object.values(rule.fees).some((amount) => typeof amount === "number"))
                        ? "등록"
                        : "미등록"}
                    </td>
                    <td>
                      {!productView ? "확인 중" : !rule?.maxConfirmed || !rule.maxBundle
                        ? "확인 필요" : rule.maxBundle === 1 ? "개별 포장" : "합포장 가능"}
                    </td>
                    <td>{rule?.at ? new Date(rule.at).toLocaleDateString("ko-KR") : "-"}</td>
                    <td>
                      <button
                        disabled={!productView || busy}
                        onClick={() => void (async () => {
                          if (!productView) return;
                          try {
                            const initial = productView.editableRule ??
                              (await businessCoreCall<{ rule: ShippingRule }>(
                                "rules", "apply_shipping_action", {
                                  action: "default_product_rule",
                                  versionId: crypto.randomUUID(),
                                  now: new Date().toISOString(),
                                },
                              )).rule;
                            if (stateRef.current !== state) return;
                            setInitialRule(clone(initial));
                            setEditing({
                              productId: p.id, groupId: group?.id,
                              name: group ? group.name + " / 공통 기준" : p.name,
                              rule: initial,
                            });
                          } catch (error) {
                            onNotice("Rust 운임 편집 조회 실패: " +
                              (error instanceof Error ? error.message : String(error)), "error");
                          }
                        })()}
                      >
                        {group ? "그룹 기준 편집" : "기본 운임 설정"}
                      </button>
                      {productView && rule && (
                        <button
                          onClick={async () => {
                            if (
                              !(await confirmAction(
                                "이 상품의 새 운임 기준을 시작하고 이전 자동 추천을 중단할까요?",
                              ))
                            )
                              return;
                            if (stateRef.current !== state) return;
                            try {
                              const { state: updated } = await businessCoreCall<{ state: State }>(
                                "rules", "apply_shipping_action", {
                                  action: "reset_product_freight_rule", state,
                                  productId: p.id, versionId: crypto.randomUUID(),
                                  now: new Date().toISOString(),
                                },
                              );
                              if (stateRef.current !== state) return;
                              await save(
                                updated,
                                "새 운임 기준을 시작했습니다. 확인된 운임을 다시 입력하세요.",
                              );
                            } catch (error) {
                              onNotice("Rust 운임 기준 변경 실패: " +
                                (error instanceof Error ? error.message : String(error)), "error");
                            }
                          }}
                        >
                          기준 변경
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </ManagementTable>
          {!rows.length && <EmptyState compact title={search || onlyMissing ? "조건에 맞는 상품이 없습니다." : "등록된 상품이 없습니다."} />}
        </div>

      </section>
      {editing && (
        <Modal
          draft={editing}
          dirty={editingDirty}
          busy={busy}
          title={editing.name + " 운임 설정"}
          onClose={() => void closeEditing()}
        >
          {editing.groupId && (
            <p className="warnings">
              이 기준을 변경하면 같은 동급 그룹에 지정한 모든 모델에 적용됩니다.
            </p>
          )}
          <div className="form-row">
            <Field label="최대 묶음 수량">
              <select
                value={editing.rule.maxBundle ?? ""}
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    rule: {
                      ...editing.rule,
                      maxBundle: e.target.value ? Number(e.target.value) : null,
                    },
                  })
                }
              >
                <option value="">확인 필요</option>
                {[1, 2, 3, 4, 5, 6].map((n) => (
                  <option value={n} key={n}>
                    {n}개
                  </option>
                ))}
              </select>
            </Field>
          </div>
          {!editing.rule.maxBundle && <p className="muted">최대 묶음 수량을 먼저 선택하세요.</p>}
          <ShippingFeeRanges key={editing.productId + ":" + (editing.groupId ?? "")}
            rule={editing.rule}
            onChange={(rule) => setEditing({ ...editing, rule })} />
          <Field label="직원 참고 메모">
            <input
              placeholder="포장할 때 직원이 참고할 사항 (선택)"
              value={editing.rule.notes}
              onChange={(e) =>
                setEditing({
                  ...editing,
                  rule: { ...editing.rule, notes: e.target.value },
                })
              }
            />
          </Field>
          <HelpTooltip title="최대 합포장 수량 초과" purpose="한 상자에 넣을 수 있는 최대 수량을 넘을 때 배송비를 어떻게 처리하는지 알려줍니다." when="주문 수량이 등록한 합포장 수량보다 많을 때 확인합니다." steps={["실제로 포장 가능한 조합을 확인합니다.", "확인된 조합의 운임을 따로 등록합니다.", "등록된 운임을 사용합니다."]} result="확인된 조합 운임을 다음 주문에서도 참고할 수 있습니다." caution="확인되지 않은 배송비는 자동으로 추측해 계산하지 않습니다." />
          <div className="actions">
            <button type="button" disabled={busy} onClick={() => void closeEditing()}>닫기</button>
            <button type="button" className="primary" disabled={busy || !editingDirty}
              onClick={() => void writeRule()}>
              기본 운임 저장
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
