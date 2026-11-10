import { HelpTooltip } from "./ui/HelpTooltip";
import { ManagementSearch } from "./ui/ManagementSearch";
import { ShippingFeeRanges } from "./ShippingFeeRanges";
import { useState } from "react";
import { confirmAction } from "./dialogs";
import { registeredProducts, sortProducts } from "./product-models";
import type { NoticeSink } from "./shared/notices";
import { useAsyncTask } from "./shared/useAsyncTask";
import { sameValue } from "./shared/draft";
import { requestPageLeave, usePageLeaveGuard } from "./shared/page-leave";

import {
  editableShippingRule,
  effectiveShippingRule,
  emptyProductRule,
} from "./shipping";
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
      (!onlyMissing || !effectiveShippingRule(state, p.id).rule),
  );
  const save = async (next: State, message: string) =>
    (
      await runSave(async () => {
        await onSave(next);
        onNotice(message, "success");
      })
    ).ok;
  const writeRule = async (): Promise<boolean> => {
    if (!editing) return true;
    const next = clone(state),
      shipping = next.shipping!;
    if (Object.entries(editing.rule.fees).some(([count, amount]) =>
      typeof amount === "number" && editing.rule.maxBundle !== null &&
      Number(count) > editing.rule.maxBundle)) {
      onNotice("최대 묶음 수량을 초과하는 운임 구간을 삭제하거나 수량을 다시 설정하세요.", "error");
      return false;
    }
    const value = {
      ...editing.rule,
      maxConfirmed: editing.rule.maxBundle !== null,
      version: crypto.randomUUID(),
      at: new Date().toISOString(),
    };
    delete value.validFrom;
    delete value.validUntil;
    delete value.basis;
    delete value.packable;
    if (editing.groupId) {
      const group = shipping.groups.find((g) => g.id === editing.groupId)!;
      group.history.push(group.current);
      group.current = value;
    } else {
      shipping.productRules ??= {};
      shipping.productHistory ??= {};
      const previous = shipping.productRules[editing.productId];
      if (previous)
        shipping.productHistory[editing.productId] = [
          ...(shipping.productHistory[editing.productId] ?? []),
          previous,
        ];
      shipping.productRules[editing.productId] = value;
    }
    const ok = await save(next, "최대 묶음 수량과 운임을 저장했습니다. 이전 기준은 이력으로 보존합니다.");
    if (ok) { setEditing(undefined);setInitialRule(undefined); }
    return ok;
  };
  const editingDirty = !!editing && !!initialRule && !sameValue(editing.rule, initialRule);
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
      const leave = await requestPageLeave((message) => onNotice(message, "error"));
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
              const next = clone(state);
              next.shipping!.productRules ??= {};
              next.shipping!.productHistory ??= {};
              for (const id of selected) {
                const old = next.shipping!.productRules![id];
                if (old)
                  next.shipping!.productHistory![id] = [
                    ...(next.shipping!.productHistory![id] ?? []),
                    old,
                  ];
                next.shipping!.productRules![id] = {
                  ...clone(group.current),
                  version: crypto.randomUUID(),
                  at: new Date().toISOString(),
                };
              }
              void save(next, "선택 상품에 확인된 공통 운임 기준을 복사했습니다.");
            }}
          >
            상품별 기준으로 복사
          </button>
          <HelpTooltip title="상품별 운임" purpose="이 상품을 포장해 보낼 때의 배송비를 등록합니다." when="상품별 기본 배송비와 합포장 수량을 확인했을 때 사용합니다." steps={["배송비를 수정할 상품을 찾습니다.", "설정 버튼을 누릅니다.", "확인된 합포장 수량과 배송비를 입력합니다.", "기본 운임 저장을 눌러 적용합니다."]} result="새 주문에서 해당 상품의 운임 기준을 참고할 수 있습니다." caution="확인되지 않은 운임은 임의로 입력하지 않습니다." />
        </div>
        <div className="shipping-table-scroll">
          <table className="management-data-table">
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
                const { rule, group } = effectiveShippingRule(state, p.id);
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
                    <td>{group ? group.name : "미소속"}</td>
                    <td>{rule?.maxConfirmed && rule.maxBundle ? rule.maxBundle + "개" : "확인 필요"}</td>
                    <td>
                      {rule && (typeof rule.perItem === "number" ||
                        Object.values(rule.fees).some((amount) => typeof amount === "number"))
                        ? "등록"
                        : "미등록"}
                    </td>
                    <td>
                      {!rule?.maxConfirmed || !rule.maxBundle
                        ? "확인 필요" : rule.maxBundle === 1 ? "개별 포장" : "합포장 가능"}
                    </td>
                    <td>{rule?.at ? new Date(rule.at).toLocaleDateString("ko-KR") : "-"}</td>
                    <td>
                      <button
                        onClick={() =>
                          (setInitialRule(editableShippingRule(rule ?? emptyProductRule())), setEditing({
                            productId: p.id,
                            groupId: group?.id,
                            name: group ? group.name + " / 공통 기준" : p.name,
                            rule: editableShippingRule(rule ?? emptyProductRule()),
                          }))
                        }
                      >
                        {group ? "그룹 기준 편집" : "기본 운임 설정"}
                      </button>
                      {rule && (
                        <button
                          onClick={async () => {
                            if (
                              !(await confirmAction(
                                "이 상품의 새 운임 기준을 시작하고 이전 자동 추천을 중단할까요?",
                              ))
                            )
                              return;
                            const next = clone(state);
                            if (group) {
                              const g = next.shipping!.groups.find((g) => g.id === group.id)!;
                              g.history.push(g.current);
                              g.current = emptyProductRule();
                            } else {
                              next.shipping!.productHistory ??= {};
                              next.shipping!.productHistory[p.id] = [
                                ...(next.shipping!.productHistory[p.id] ?? []),
                                rule,
                              ];
                              next.shipping!.productRules![p.id] = emptyProductRule();
                            }
                            void save(
                              next,
                              "새 운임 기준을 시작했습니다. 확인된 운임을 다시 입력하세요.",
                            );
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
          </table>
        </div>
        <footer className="shipping-savebar shipping-explanation-footer">
          <HelpTooltip
            title="합포장 운임 계산"
            purpose="같은 곳으로 보내는 여러 상품의 배송비를 합포장 기준에 맞춰 계산합니다."
            when="같은 수취인에게 여러 상품을 한 번에 보낼 때 사용합니다."
            steps={["상품별 기본 운임과 배송 그룹을 확인합니다.", "같은 그룹으로 묶을 수 있는 상품의 수량을 확인합니다.", "필요한 배송비를 확인하고 주문에 적용합니다."]}
            result="같은 모델이나 동급 배송 그룹에 속하는 상품의 수량을 함께 계산할 수 있습니다."
            caution="수취인이나 출고지가 다른 상품은 별도로 계산합니다."
          />
        </footer>
      </section>
      {editing && (
        <Modal
          draft={editing}
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
          <button className="primary" disabled={busy} onClick={() => void writeRule()}>
            기본 운임 저장
          </button>
        </Modal>
      )}
    </>
  );
}
