import { useMemo, useState } from "react";
import { confirmAction, promptText } from "./dialogs";
import { money, won } from "./domain";
import { businessCoreCall } from "./tauri-bridge";
import { internalModel } from "./matching";
import { colorLabel, registeredProducts, sortProducts } from "./product-models";
import { ProductFreightPanel } from "./ProductFreightPanel";
import { ShippingFeeRanges } from "./ShippingFeeRanges";
import type { NoticeSink } from "./shared/notices";
import { useAsyncTask } from "./shared/useAsyncTask";
import { sameFreightEditor } from "./shared/meaningful-changes";
import { requestEditorLeave, requestPageLeave, usePageLeaveGuard } from "./shared/page-leave";

import {
  combinationCurrent,
  combinationVersions,
  editableShippingRule,
  initialShipping,
} from "./shipping";
import type { ShippingRule, ShippingState, State } from "./types";
import { HelpTooltip } from "./ui/HelpTooltip";
import { Field, Modal } from "./ui";
import { EmptyState, PageHeading } from "./ui/PageHeading";
import { ManagementTable } from "./ui/ManagementTable";
import { ManagementSearch } from "./ui/ManagementSearch";
import { Button } from "./ui/Button";
export function ShippingManager({
  state,
  onSave,
  onNotice,
}: {
  state: State;
  onSave: (s: State) => Promise<void>;
  onNotice: NoticeSink;
}) {
  const { busy, run: runSave } = useAsyncTask(onNotice);
  const [deleting, setDeleting] = useState("");
  const shipping = state.shipping ?? initialShipping();
  const [tab, setTab] = useState<"products" | "assign" | "rates" | "history">("products"),
    [query, setQuery] = useState(""),
    [filter, setFilter] = useState("all"),
    [selected, setSelected] = useState<string[]>([]),
    [group, setGroup] = useState(""),
    [pending, setPending] = useState<Record<string, string>>({}),
    [editing, setEditing] = useState<{
      id: string;
      rule: ShippingRule;
    }>(),
    [newName, setNewName] = useState("");
  const [initialEditing, setInitialEditing] = useState<ShippingRule>();
  const products = useMemo(
    () =>
      sortProducts(
        registeredProducts(state.products).filter(
          (p) => p.catalog !== "DEMO" && !p.variants.some((v) => v.source === "DEMO"),
        ),
      ),
    [state.products],
  );
  const rows = products.filter(
    (p) =>
      (p.name + " " + p.subtitle + " " + p.category)
        .toLowerCase()
        .includes(query.toLowerCase()) &&
      (filter === "all" ||
        (filter === "none" && !p.shippingGroupId) ||
        p.shippingGroupId === filter),
  );
  const unassigned = products.filter((p) => !p.shippingGroupId).length;
  const save = async (next: State, message: string) =>
    (
      await runSave(async () => {
        await onSave(next);
        onNotice(message, "success");
      })
    ).ok;
  const applyBasis = async (groupId?: string): Promise<boolean> => {
    try {
      const groupVersions = Object.fromEntries(
        shipping.groups.filter((g) => !groupId || g.id === groupId)
          .map((g) => [g.id, crypto.randomUUID()]),
      );
      const productVersions = groupId ? {} : Object.fromEntries(
        Object.keys(shipping.productRules ?? {}).map((id) => [id, crypto.randomUUID()]),
      );
      const { shipping: updated } = await businessCoreCall<{ shipping: ShippingState }>(
        "rules", "apply_shipping_action", {
          action: "change_basis", shipping, groupId,
          now: new Date().toISOString(), groupVersions, productVersions,
        },
      );
      return await save(
        { ...state, shipping: updated },
        groupId ? "그룹 운임 기준을 변경했습니다."
          : "전체 운임 기준을 변경했습니다. 새 운임을 등록하세요.",
      );
    } catch (error) {
      onNotice(error instanceof Error ? error.message : String(error), "error");
      return false;
    }
  };
  const removeGroup = async (groupId: string, detach: boolean): Promise<void> => {
    try {
      const { state: updated } = await businessCoreCall<{ state: State }>(
        "rules", "apply_shipping_action", {
          action: "delete_group", state, groupId, detach,
          now: new Date().toISOString(),
        },
      );
      if (await save(updated, "그룹을 삭제하고 과거 운임 기록을 보존했습니다."))
        setDeleting("");
    } catch (error) {
      onNotice(error instanceof Error ? error.message : String(error), "error");
    }
  };
  const applyBulk = () => {
    if (!selected.length) return;
    setPending((prev) => ({
      ...prev,
      ...Object.fromEntries(selected.map((id) => [id, group])),
    }));
  };
  const changes = Object.entries(pending).filter(
    ([id, g]) => products.find((p) => p.id === id)?.shippingGroupId !== (g || undefined),
  );
  const savePending = async (): Promise<boolean> => {
    if (!changes.length) return true;
    try {
      const assignments = Object.fromEntries(changes);
      const versionIds = Object.fromEntries(
        changes.filter(([, value]) => !value)
          .map(([id]) => [id, crypto.randomUUID()]),
      );
      const result = await businessCoreCall<{ state: State }>(
        "rules", "apply_shipping_action", {
          action: "assign_products",
          state: { ...state, shipping },
          assignments, versionIds, now: new Date().toISOString(),
        },
      );
      const ok = await save(result.state, "배송 그룹 지정을 저장했습니다.");
      if (ok) { setPending({}); setSelected([]); }
      return ok;
    } catch (error) {
      onNotice(error instanceof Error ? error.message : String(error), "error");
      return false;
    }
  };
  const editingDirty = !!editing && !!initialEditing && !sameFreightEditor(editing.rule, initialEditing);
  const saveEditedRule = async (): Promise<boolean> => {
    if (!editing || !editingDirty) return true;
    try {
      const { shipping: updated } = await businessCoreCall<{ shipping: ShippingState }>(
        "rules", "apply_shipping_action", {
          action: "save_group_rule",
          shipping, groupId: editing.id, rule: editing.rule,
          versionId: crypto.randomUUID(), now: new Date().toISOString(),
        },
      );
      const ok = await save(
        { ...state, shipping: updated },
        "운임표를 저장했습니다. 변경 전 기준은 이력으로 보존됩니다.",
      );
      if (ok) { setEditing(undefined); setInitialEditing(undefined); }
      return ok;
    } catch (error) {
      onNotice(error instanceof Error ? error.message : String(error), "error");
      return false;
    }
  };
  usePageLeaveGuard({
    label: "운임 관리",
    hasChanges: () => changes.length > 0 || editingDirty || newName.trim().length > 0,
    busy: () => busy,
    save: async () => {
      if (newName.trim().length > 0) {
        onNotice("새 배송 그룹을 등록하려면 배송 그룹 추가를 눌러 주세요. 등록 전의 이름은 자동 저장하지 않습니다.", "error");
        return false;
      }
      if (editingDirty) return saveEditedRule();
      return savePending();
    },
    discard: () => { setPending({});setSelected([]);setEditing(undefined);setInitialEditing(undefined);setNewName(""); },
  });
  const chooseTab = async (next: typeof tab) => {
    if (next === tab) return;
    const leave = await requestPageLeave((message) => onNotice(message, "error"));
    if (!leave.proceed) return;
    setTab(next);
  };
  const closeEditing = async () => {
    if (!editing || busy) return;
    if (editingDirty) {
      const leave = await requestEditorLeave({
        label: "동급 그룹 운임",
        hasChanges: () => editingDirty,
        save: saveEditedRule,
        discard: () => { setEditing(undefined); setInitialEditing(undefined); },
      }, (message) => onNotice(message, "error"));
      if (!leave.proceed) return;
    }
    setEditing(undefined);
    setInitialEditing(undefined);
  };
  return (
    <div className="shipping-manager">
      <PageHeading
        title="운임 관리"
        actions={<div className="shipping-heading-help">
          <HelpTooltip
            title="운임 관리"
            purpose="상품을 포장해 보낼 때 필요한 배송비와 합포장 기준을 관리합니다."
            when="상품의 배송비가 달라졌거나 같은 상자로 보낼 수 있는 상품을 정할 때 사용합니다."
            steps={["상품별 기본 운임에서 확인된 배송비를 등록합니다.", "같은 포장 기준을 쓸 상품은 배송 그룹 지정에서 묶습니다.", "동급 그룹 운임표에서 그룹별 배송비를 확인하거나 수정합니다.", "필요한 경우 조합 및 기준 이력을 확인합니다."]}
            result="주문 접수 시 등록된 운임 기준을 참고할 수 있습니다."
            caution="실제 확인하지 않은 운임은 임의로 입력하지 않습니다."
          />
          <span className="shipping-version">운임 기준 {shipping.epoch}</span>
        </div>}
      />
      <div className="shipping-tabs management-tabbar" role="group" aria-label="배송 관리">
        <button
          aria-pressed={tab === "products"}
          className={tab === "products" ? "chosen" : ""}
          onClick={() => void chooseTab("products")}
        >
          상품별 기본 운임
        </button>
        <button
          aria-pressed={tab === "assign"}
          className={tab === "assign" ? "chosen" : ""}
          onClick={() => void chooseTab("assign")}
        >
          동급 배송 그룹 지정
        </button>
        <button
          aria-pressed={tab === "rates"}
          className={tab === "rates" ? "chosen" : ""}
          onClick={() => void chooseTab("rates")}
        >
          동급 그룹 운임표
        </button>
        <button
          aria-pressed={tab === "history"}
          className={tab === "history" ? "chosen" : ""}
          onClick={() => void chooseTab("history")}
        >
          조합 / 기준 이력
        </button>
      </div>
      <div className="shipping-stats">
        <article>
          <span>등록 상품</span>
          <b>
            {products.length}
            <small>개</small>
          </b>
        </article>
        <article>
          <span>그룹 지정 완료</span>
          <b>
            {products.length - unassigned}
            <small>개</small>
          </b>
        </article>
        <article className="pending-stat">
          <span>그룹 미지정</span>
          <b>
            {unassigned}
            <small>개</small>
          </b>
        </article>
        <article>
          <span>배송 그룹</span>
          <b>
            {shipping.groups.filter((g) => !g.deletedAt).length}
            <small>개</small>
          </b>
        </article>
      </div>
      {tab === "products" && (
        <ProductFreightPanel state={{ ...state, shipping }} onSave={onSave} onNotice={onNotice} />
      )}
      {tab === "assign" && (
        <section className="shipping-card shipping-assignment-list">
          <div className="shipping-tools management-search-toolbar">
            <ManagementSearch label="배송 그룹 상품 검색"
              placeholder="모델명 / 상품명 / 카테고리 검색"
              value={query} onChange={setQuery}/>
            <select
              aria-label="배송 그룹 필터"
              value={filter}
              onChange={(e) => {
                setFilter(e.target.value);
                setSelected([]);
              }}
            >
              <option value="all">전체 상품</option>
              <option value="none">그룹 미지정만</option>
              {shipping.groups
                .filter((g) => !g.deletedAt)
                .map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
            </select>
          </div>
          <div className="shipping-bulk">
            <label>
              <input
                type="checkbox"
                aria-label="보이는 상품 전체 선택"
                checked={!!rows.length && rows.every((p) => selected.includes(p.id))}
                onChange={(e) => setSelected(e.target.checked ? rows.map((p) => p.id) : [])}
              />{" "}
              <b>{selected.length}개 선택</b>
            </label>
            <span className="bulk-divider" />
            <select
              aria-label="일괄 지정할 배송 그룹"
              value={group}
              onChange={(e) => setGroup(e.target.value)}
            >
              <option value="">미지정으로 변경</option>
              {shipping.groups
                .filter((g) => !g.deletedAt)
                .map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
            </select>
            <button disabled={!selected.length} onClick={applyBulk}>
              선택 상품에 적용
            </button>
            <HelpTooltip title="배송 그룹 일괄 지정" purpose="선택한 여러 상품을 같은 배송 그룹으로 한꺼번에 지정합니다." when="같은 포장 기준을 사용하는 상품들을 정리할 때 사용합니다." steps={["변경할 상품을 체크합니다.", "적용할 배송 그룹을 선택합니다.", "선택 상품에 적용을 누릅니다.", "아래에서 변경 내용을 확인하고 그룹 지정 저장을 누릅니다."]} result="저장한 상품의 배송 그룹이 변경됩니다." caution="실제 포장 조건이 확인된 상품만 같은 그룹으로 묶습니다." />
          </div>
          <div className={"shipping-table-scroll" + (!rows.length ? " shipping-list-empty" : "")}>
            <ManagementTable>
              <thead>
                <tr>
                  <th />
                  <th>상품명 / 상품설명</th>
                  <th>카테고리</th>
                  <th>색상 / 옵션</th>
                  <th>배송 그룹</th>
                  <th>지정 상태</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => {
                  const value = pending[p.id] ?? p.shippingGroupId ?? "";
                  const changed =
                    pending[p.id] !== undefined && pending[p.id] !== p.shippingGroupId;
                  return (
                    <tr className={changed ? "changed-row" : ""} key={p.id}>
                      <td>
                        <input
                          type="checkbox"
                          aria-label={"선택 " + p.name}
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
                      <td>
                        <span className="shipping-product-inline" title={[internalModel(p.name), p.subtitle].filter(Boolean).join(" / ")}>
                          <strong>{internalModel(p.name)}</strong>
                          {p.subtitle?.trim() && p.subtitle !== p.name && (
                            <span className="shipping-product-description">{p.subtitle}</span>
                          )}
                        </span>
                      </td>
                      <td>
                        <span className="category-label">{p.category || "분류 미지정"}</span>
                      </td>
                      <td>
                        {[...new Set(p.variants.map((v) => colorLabel(v.color)))].join(" / ")}
                      </td>
                      <td>
                        <select
                          aria-label={p.name + " 배송 그룹"}
                          value={value}
                          onChange={(e) => setPending({ ...pending, [p.id]: e.target.value })}
                        >
                          <option value="">그룹 선택</option>
                          {shipping.groups
                            .filter((g) => !g.deletedAt)
                            .map((g) => (
                              <option key={g.id} value={g.id}>
                                {g.name}
                              </option>
                            ))}
                        </select>
                      </td>
                      <td>
                        {changed ? (
                          <span className="assignment-badge changed">변경 예정</span>
                        ) : value ? (
                          <span className="assignment-badge assigned">지정 완료</span>
                        ) : (
                          <span className="assignment-badge unassigned">미지정</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </ManagementTable>
            {!rows.length && <EmptyState compact title="검색 조건에 맞는 상품이 없습니다." />}
          </div>
          <footer className="shipping-savebar">
            <span>
              {changes.length ? (
                <>
                  <b>{changes.length}개 상품</b>의 배송 그룹을 변경합니다.
                </>
              ) : (
                "등록된 상품을 임의로 분류하지 않습니다. 직원이 확인한 그룹을 지정해 주세요."
              )}
            </span>
            <div>
              {changes.length > 0 && <button disabled={busy} onClick={() => setPending({})}>
                미저장 변경 초기화
              </button>}
              <button
                className="primary"
                disabled={!changes.length || busy}
                onClick={() => {
                  void savePending();
                }}
              >
                그룹 지정 저장 {changes.length > 0 && ` / ${changes.length}개`}
              </button>
            </div>
          </footer>
        </section>
      )}
      {tab === "rates" && (
        <section className="shipping-card shipping-rates">
          <div className="section-title">
            <h3 className="shipping-rates-title">그룹 운임표 <HelpTooltip title="배송 그룹 운임표" purpose="같은 배송 기준으로 묶은 상품에 적용할 운임을 등록합니다." when="같은 포장 조건의 상품이 여러 개 있을 때 배송비를 확인하거나 수정할 때 사용합니다." steps={["배송 그룹을 확인합니다.", "운임 수정 버튼을 누릅니다.", "최대 합포장 수량과 확인된 운임을 입력합니다.", "저장 버튼을 눌러 적용합니다."]} result="해당 그룹의 상품들이 새 운임 기준을 참고할 수 있습니다." caution="기존 운임 기준을 종료할 때에는 운임 기준 관리에서 따로 처리합니다." /></h3>
            <details className="shipping-basis-settings">
              <summary>운임 기준 관리</summary>
              <div className="shipping-basis-actions">
                <HelpTooltip title="전체 운임 기준 변경" purpose="지금까지 사용하던 운임 기준을 종료하고 새로운 운임을 등록할 수 있도록 합니다." when="기존 배송비 기준을 더 이상 사용하지 않을 때만 사용합니다." steps={["새 운임 기준을 적용해야 하는지 확인합니다.", "전체 운임 기준 변경 버튼을 누릅니다.", "확인창에서 변경 범위를 확인하고 승인합니다.", "새로운 배송비를 확인한 뒤 다시 등록합니다."]} result="이전 운임의 자동 추천이 중단되고 새 기준을 등록할 수 있습니다." caution="기존 운임 기준 전체에 영향을 주므로 일반적인 운임 수정에는 사용하지 않습니다." />
            <button className="danger" type="button"
              onClick={async () => {
                if (
                  await confirmAction(
                    "전체 운임 기준을 변경하면 이전 운임의 자동 추천을 중단합니다. 새 운임은 다시 확인하여 등록해야 합니다. 계속할까요?",
                  )
                )
                  void applyBasis();
              }}
            >
              전체 운임 기준 변경
            </button>
              </div>
            </details>
          </div>
          <div className="new-group">
            <Field label="새 배송 그룹명">
              <input
                aria-label="새 배송 그룹명"
                placeholder="새 배송 그룹명"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
              />
            </Field>
            <Button
              disabled={busy || !newName.trim()}
              onClick={async () => {
                if (shipping.groups.some((g) => g.name === newName.trim())) {
                  onNotice("같은 배송 그룹이 있습니다.");
                  return;
                }
                const next: ShippingState = structuredClone(shipping);
                next.groups.push({
                  id: crypto.randomUUID(),
                  name: newName.trim(),
                  current: {
                    version: crypto.randomUUID(),
                    at: new Date().toISOString(),
                    fees: {},
                    maxBundle: null,
                    maxConfirmed: false,
                    perItem: null,
                    notes: "운임 확인 필요",
                  },
                  history: [],
                });
                if (await save({ ...state, shipping: next }, "새 배송 그룹을 등록했습니다."))
                  setNewName("");
              }}
            >
              배송 그룹 추가
            </Button>
          </div>
          <ManagementTable>
            <thead>
              <tr>
                <th>배송 그룹</th>
                <th>최대 묶음 수량</th>
                <th>운임 등록 상태</th>
                <th>직원 참고 메모</th>
                <th>최근 수정</th>
                <th>관리</th>
              </tr>
            </thead>
            <tbody>
              {shipping.groups
                .filter((g) => !g.deletedAt)
                .map((g) => (
                  <tr key={g.id}>
                    <td><b>{g.name}</b></td>
                    <td>{g.current.maxConfirmed && g.current.maxBundle
                      ? g.current.maxBundle + "개" : "확인 필요"}</td>
                    <td>
                      {typeof g.current.perItem === "number" ||
                        Object.values(g.current.fees).some((fee) => typeof fee === "number")
                        ? "등록" : "미등록"}
                    </td>
                    <td className="shipping-group-notes" title={g.current.notes}>
                      {g.current.notes || "-"}
                    </td>
                    <td>{g.current.at ? new Date(g.current.at).toLocaleDateString("ko-KR") : "-"}</td>
                    <td>
                      <div className="shipping-group-actions">
                      <Button size="compact"
                        onClick={async () => {
                          const name = await promptText("배송 그룹명", g.name);
                          if (!name?.trim()) return;
                          const next = structuredClone(shipping);
                          next.groups.find((x) => x.id === g.id)!.name = name.trim();
                          void save({ ...state, shipping: next }, "배송 그룹명을 변경했습니다.");
                        }}
                      >이름 수정</Button>
                      <Button size="compact"
                        onClick={() => {
                          const initial = editableShippingRule(g.current);
                          setInitialEditing(structuredClone(initial));
                          setEditing({ id: g.id, rule: initial });
                        }}
                      >
                        운임 수정
                      </Button>
                      <Button size="compact" variant="danger" onClick={() => setDeleting(g.id)}>
                        삭제
                      </Button>
                      <Button size="compact"
                        onClick={async () => {
                          if (
                            await confirmAction(
                              g.name + " 기준을 변경하고 이전 운임 추천을 중단할까요?",
                            )
                          )
                            void applyBasis(g.id);
                        }}
                      >
                        기준 변경
                      </Button>
                      </div>
                    </td>
                  </tr>
                ))}
            </tbody>
          </ManagementTable>
        </section>
      )}
      {tab === "history" && (
        <section className="shipping-card shipping-rates">
          <h3>확인된 배송 조합</h3>
          <ManagementTable>
            <thead>
              <tr>
                <th>조합</th>
                <th>청구 운임</th>
                <th>실제 운임</th>
                <th>기준</th>
                <th>수정</th>
              </tr>
            </thead>
            <tbody>
              {shipping.combinations
                .slice()
                .reverse()
                .map((c) => (
                  <tr key={c.id}>
                    <td>
                      {c.description}
                      <small>
                        {new Date(c.at).toLocaleString("ko-KR")}
                        {c.verifiedAt
                          ? ` / 실배송 검증 ${c.sampleCount ?? 1}회`
                          : " / 직원 등록 기준"}
                      </small>
                    </td>
                    <td>{won(c.charge)}</td>
                    <td>{won(c.actual)}</td>
                    <td>
                      {combinationCurrent(c, { ...state, shipping }) ? "현재 유효" : "과거 이력"}
                    </td>
                    <td>
                      <button
                        onClick={async () => {
                          const text = await promptText(
                            "새로 확인된 청구 운임 (원)",
                            String(c.charge),
                          );
                          if (text === null) return;
                          const n = Number(text);
                          if (!text.trim() || !money.safeParse(n).success) {
                            onNotice("올바른 운임을 입력하세요.");
                            return;
                          }
                          const next = structuredClone(shipping),
                            old = next.combinations.find((x) => x.id === c.id)!;
                          old.active = false;
                          next.combinations.push({
                            ...old,
                            verifiedAt: undefined,
                            shipmentId: undefined,
                            sampleCount: 0,
                            observedCharge: undefined,
                            id: crypto.randomUUID(),
                            charge: n,
                            epoch: next.epoch,
                            versions: combinationVersions(old.key, state),
                            at: new Date().toISOString(),
                            active: true,
                          });
                          void save(
                            { ...state, shipping: next },
                            "새 예외 운임을 저장하고 이전 값을 이력으로 보존했습니다.",
                          );
                        }}
                      >
                        예외 운임 변경
                      </button>
                    </td>
                  </tr>
                ))}
            </tbody>
          </ManagementTable>
          {!shipping.combinations.length && (
            <EmptyState compact title="실제 배송 완료 후 검증한 운임 조합이 여기에 표시됩니다." />
          )}
          <h3>이전 그룹 운임 기준</h3>
          {shipping.groups
            .filter((g) => !g.deletedAt)
            .map((g) => (
              <details key={g.id}>
                <summary>
                  {g.name} / {g.history.length}개 기준
                </summary>
                {g.history.map((r) => (
                  <p key={r.version}>
                    {r.at} / {JSON.stringify(r.fees)} / 개당 {won(r.perItem)}
                  </p>
                ))}
              </details>
            ))}
        </section>
      )}
      {deleting && (
        <Modal draft={editing} busy={busy} title="배송 그룹 삭제" onClose={() => setDeleting("")}>
          <p>{shipping.groups.find((g) => g.id === deleting)?.name}</p>
          {products.filter((p) => p.shippingGroupId === deleting).length > 0 ? (
            <>
              <p className="warnings">
                사용 중인 상품이 있습니다. 상품을 다른 그룹으로 옮기거나 미지정으로 변경한 후
                삭제해야 합니다.
              </p>
              <ul>
                {products
                  .filter((p) => p.shippingGroupId === deleting)
                  .map((p) => (
                    <li key={p.id}>
                      {internalModel(p.name)} / {colorLabel(p.variants[0].color)}
                    </li>
                  ))}
              </ul>
            </>
          ) : (
            <p>연결된 현재 상품이 없습니다. 과거 운임과 주문 기록은 보존합니다.</p>
          )}
          <button
            className="danger"
            onClick={async () => {
              const linked = products.some((p) => p.shippingGroupId === deleting);
              if (
                await confirmAction(
                  linked
                    ? "표시된 상품을 미지정으로 변경하고 이 그룹을 삭제할까요?"
                    : "이 그룹을 삭제할까요?",
                )
              )
                void removeGroup(deleting, linked);
            }}
          >
            {products.some((p) => p.shippingGroupId === deleting)
              ? "상품 연결을 미지정으로 변경하고 삭제"
              : "그룹 삭제"}
          </button>
        </Modal>
      )}
      {editing && (
        <Modal
          title="배송 그룹 운임 수정"
          dirty={editingDirty}
          onClose={() => {
            if (!busy) void closeEditing();
          }}
        >
          <h3 className="shipping-rates-title">
            {shipping.groups.find((g) => g.id === editing.id)?.name} 운임
            <HelpTooltip title="배송 그룹 운임 수정" purpose="선택한 배송 그룹에 적용할 배송비를 등록하거나 수정합니다." steps={["최대 묶음 수량을 선택합니다.", "운임 구간 추가로 확인한 수량만 등록합니다.", "저장 버튼을 눌러 운임을 반영합니다."]} result="그룹에 등록된 상품들이 수정된 운임 기준을 참고할 수 있습니다." caution="확인하지 않은 운임은 빈칸으로 둡니다. 기존 기준을 아예 바꾸려면 기준 변경 작업을 먼저 합니다." />
          </h3>
          <div className="form-row">
            <label>
              최대 합포장 수량
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
                <option value="">미확정</option>
                {[1, 2, 3, 4, 5, 6].map((n) => (
                  <option key={n}>{n}</option>
                ))}
              </select>
            </label>
          </div>
          {!editing.rule.maxBundle && <p className="muted">최대 묶음 수량을 먼저 선택하세요.</p>}
          <ShippingFeeRanges key={editing.id} rule={editing.rule}
            onChange={(rule) => setEditing({ ...editing, rule })} />
          <label>
            직원 참고 메모
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
          </label>
          <div className="actions">
            <button type="button" disabled={busy} onClick={() => void closeEditing()}>닫기</button>
            <button type="button" className="primary" disabled={busy || !editingDirty}
              onClick={() => void saveEditedRule()}>
              확인한 운임 저장
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
