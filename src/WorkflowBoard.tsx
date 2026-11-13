import { paymentWasCopied } from "./automatic-message";
import { useEffect, useRef, useState } from "react";
import { confirmAction } from "./dialogs";
import { won } from "./domain";
import { deleteGroup, restoreGroup } from "./group-trash";
import { internalModel } from "./matching";
import type { NoticeSink } from "./shared/notices";
import type { State } from "./types";
import { Field, Modal } from "./ui";
import { blocking, orderIssues } from "./validation";
import {
  advanceGroup,
  confirmGroupPayment,
  detachShipment,
  groupShipments,
  groupStep,
  groupTotals,
  paymentBalance,
  processGroup,
  regroupShipment,
  shipmentContext,
  shipmentFreightCode,
  shipmentTotals,
  shipmentVat,
  undoGroup,
  workflowIssues,
} from "./workflow";
export interface WorkflowSelection {
  orderId: string;
  groupId: string;
  shipmentId?: string;
}
export const stepNames = ["주문 확인", "운임 적용", "계좌 안내", "입금 확인"];
export function SignalLights({ step, notice = false }: { step: number; notice?: boolean }) {
  const current = step;
  return (
    <span
      className="workflow-signals"
      aria-label={`4단계 중 ${step}단계 완료${notice ? " / 재안내 필요" : ""}`}
    >
      {stepNames.map((name, index) => (
        <span
          key={name}
          title={name}
          aria-label={`${name}: ${notice && current === 2 && index === 2 ? "재안내 필요" : index < current ? "완료" : index === current ? "진행 중" : "대기"}`}
          className={
            "signal " + (index < current ? "done" : index === current ? "current" : "pending")
          }
        />
      ))}
    </span>
  );
}
export function WorkflowBoard({
  state,
  persistedState,
  selection,
  activeKey,
  onSelect,
  onSave,
  onNotice,
  onStageHover,
  stageHover,
}: {
  onStageHover?: (v: { groupId: string; step: number } | undefined) => void;
  stageHover?: { groupId: string; step: number };
  state: State;
  persistedState?: State;
  activeKey?: string;
  selection?: WorkflowSelection;
  onSelect: (s: WorkflowSelection) => void;
  onSave: (s: State) => Promise<void>;
  onNotice: NoticeSink;
}) {
  const [undoDelete, setUndoDelete] = useState<{ gid: string; at: string }>();
  useEffect(() => {
    if (!undoDelete) return;
    const end = (e: Event) => {
      if (e.target instanceof Element && e.target.closest(".delete-undo")) return;
      setUndoDelete(undefined);
    };
    for (const type of ["pointerdown", "keydown", "paste"])
      document.addEventListener(type, end, true);
    return () => {
      for (const type of ["pointerdown", "keydown", "paste"])
        document.removeEventListener(type, end, true);
    };
  }, [undoDelete]);
  const previousSelection = useRef(selection?.shipmentId),
    [leaving, setLeaving] = useState<string>();
  useEffect(() => {
    if (previousSelection.current === selection?.shipmentId) return;
    setLeaving(previousSelection.current);
    previousSelection.current = selection?.shipmentId;
    const timer = setTimeout(() => setLeaving(undefined), 330);
    return () => clearTimeout(timer);
  }, [selection?.shipmentId]);
  const boardRef = useRef<HTMLDivElement>(null),
    hoveredGroup = useRef<string | undefined>(undefined);
  useEffect(() => {
    const id = hoveredGroup.current;
    if (!id) return;
    const step = groupStep(state, id);
    onStageHover?.(step < 4 ? { groupId: id, step: step + 1 } : undefined);
  }, [state.workflow, onStageHover]);
  const [collapsed, setCollapsed] = useState<string[]>([]),
    [busy, setBusy] = useState(false),
    [manage, setManage] = useState<string>();
  const actionState = (groupId: string) =>
    persistedState &&
    persistedState.workflow?.groups.some((g) => g.id === groupId) &&
    groupShipments(state, groupId)[0]?.orderId !== selection?.orderId
      ? persistedState
      : state;
  const inFlight = useRef(false),
    [deadlines, setDeadlines] = useState<Record<string, number>>({}),
    [clock, setClock] = useState(Date.now);
  const stageDeadlines = { ...deadlines };
  for (const e of state.workflow?.events ?? [])
    if (
      e.groupId &&
      [
        "주문 확인 완료",
        "운임 적용",
        "계좌 안내 완료",
        "입금 확인 완료",
        "후불 출고 승인",
      ].includes(e.action)
    )
      stageDeadlines[e.groupId] = Math.max(stageDeadlines[e.groupId] ?? 0, Date.parse(e.at) + 2000);
  const latestDeadline = Math.max(0, ...Object.values(stageDeadlines));
  useEffect(() => {
    setClock(Date.now());
    if (latestDeadline <= Date.now()) return;
    const timer = setInterval(() => {
      setClock(Date.now());
      if (Date.now() >= latestDeadline) clearInterval(timer);
    }, 100);
    return () => clearInterval(timer);
  }, [latestDeadline]);
  const run = async (fn: () => State, stageGroupId?: string) => {
    if (inFlight.current || (stageGroupId && (stageDeadlines[stageGroupId] ?? 0) > Date.now()))
      return;
    inFlight.current = true;
    setBusy(true);
    try {
      await onSave(fn());
      if (stageGroupId) {
        const at = Date.now();
        setDeadlines((previous) => ({
          ...previous,
          [stageGroupId]: at + 2000,
        }));
        setClock(at);
      }
    } catch (e) {
      const issue = stageGroupId
        ? workflowIssues(state, stageGroupId).find((issue) =>
            blocking(issue, Math.min(4, groupStep(state, stageGroupId) + 1)),
          )
        : undefined;
      if (stageGroupId && issue) {
        const shipments = groupShipments(state, stageGroupId),
          target = shipments.find((ship) => ship.recipientId === issue.recipientId) ?? shipments[0];
        onSelect({
          orderId: target.orderId,
          groupId: stageGroupId,
          shipmentId: target.id,
        });
        document.querySelector(".staff-checks")?.scrollIntoView({ block: "nearest" });
      } else onNotice(e instanceof Error ? e.message : String(e), "error");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const groups = (state.workflow?.groups ?? [])
    .filter((g) => {
      const ss = groupShipments(state, g.id);
      return ss.length && ss.some((s) => !s.transferred);
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return (
    <div ref={boardRef} className="workflow-board" aria-label="진행 중인 배송 묶음">
      <div className="workflow-board-heading">
        <b>발주서 묶음</b>
        <small>배송 건별 정보 / 묶음별 진행</small>
      </div>
      {!groups.length && (
        <p className="muted">거래처와 발주 원문을 입력하면 수취인별 배송 건이 생성됩니다.</p>
      )}
      {groups.map((g) => {
        const ss = groupShipments(state, g.id),
          step = groupStep(state, g.id),
          first = shipmentContext(state, ss[0]),
          open = !collapsed.includes(g.id),
          selected = selection?.groupId === g.id;
        const label =
          g.needsNotice && step >= 2
            ? "계좌 재안내 완료"
            : step === 4
              ? "처리완료"
              : [
                  "주문 확인 완료",
                  "운임 적용",
                  "계좌 안내 완료",
                  first.client.payment === "POSTPAID" ? "후불 출고 승인" : "입금 확인 완료",
                ][step];
        const remaining = Math.max(
            0,
            Math.ceil(((stageDeadlines[g.id] ?? 0) - Math.max(clock, Date.now())) / 1000),
          ),
          buttonLabel = label + (remaining ? ` (${remaining})` : "");
        return (
          <article
            className={
              "workflow-group" +
              (selected ? " selected" : "") +
              (stageHover?.groupId === g.id && stageHover.step === 4
                ? " workflow-payment-hover"
                : "")
            }
            key={g.id}
            data-group-id={g.id}
          >
            <header>
              <button
                className="flow-toggle"
                aria-label={open ? "묶음 접기" : "묶음 펼치기"}
                aria-expanded={open}
                onClick={() =>
                  setCollapsed(open ? [...collapsed, g.id] : collapsed.filter((id) => id !== g.id))
                }
              >
                {open ? "▾" : "▸"}
              </button>
              <span className="flow-group-name">
                <b>{first.client.displayName || first.client.name}</b>
              </span>
              <button
                disabled={first.order.receptionVersion === 1 && !first.order.confirmedAt}
                onClick={() => setManage(g.id)}
              >
                묶음 관리
              </button>
              <button
                className="trash-button"
                disabled={first.order.receptionVersion === 1 && !first.order.confirmedAt}
                aria-label={"주문 묶음 삭제 " + first.client.name}
                onClick={async () => {
                  if (
                    busy ||
                    !(await confirmAction(
                      first.client.name +
                        " / 배송 " +
                        ss.length +
                        "건 묶음을 삭제할까요? 접수 원문 / 감사 기록은 보존됩니다.",
                    ))
                  )
                    return;
                  setBusy(true);
                  try {
                    const next = deleteGroup(state, g.id);
                    await onSave(next);
                    setUndoDelete({
                      gid: g.id,
                      at: next.workflow!.groups.find((x) => x.id === g.id)!.deletedAt!,
                    });
                  } catch (e) {
                    onNotice(e instanceof Error ? e.message : String(e), "error");
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  aria-hidden="true"
                >
                  <path d="M3 4h10M6 2h4M4 4l1 10h6l1-10M7 6v6M9 6v6" />
                </svg>
              </button>
            </header>
            {first.order.orderType !== "RETAIL" && (
              <div className="workflow-progress">
                <SignalLights step={step} notice={g.needsNotice} />
                {step === 3 && (
                  <b className="waiting-payment">{won(groupTotals(state, g.id).total)}</b>
                )}
                <button
                  className="primary"
                  disabled={busy || remaining > 0 || ss.some((s) => s.transferred)}
                  aria-label={buttonLabel}
                  onMouseEnter={() => {
                    hoveredGroup.current = g.id;
                    onStageHover?.(step < 4 ? { groupId: g.id, step: step + 1 } : undefined);
                  }}
                  onMouseLeave={() => {
                    hoveredGroup.current = undefined;
                    onStageHover?.(undefined);
                  }}
                  onClick={async () => {
                    if (
                      (step === 2 || (g.needsNotice && step >= 2)) &&
                      !paymentWasCopied(actionState(g.id), g.id) &&
                      !(await confirmAction(
                        "계좌 안내 메시지를 복사한 기록이 없습니다. 다른 방법으로 안내하셨나요?",
                        { cancel: "돌아가기", accept: "전달 완료로 처리" },
                      ))
                    )
                      return;
                    void run(
                      () =>
                        step === 4 && !g.needsNotice
                          ? processGroup(actionState(g.id), g.id)
                          : step === 3 && !g.needsNotice
                            ? confirmGroupPayment(actionState(g.id), g.id)
                            : advanceGroup(actionState(g.id), g.id),
                      g.id,
                    );
                  }}
                >
                  {buttonLabel}
                </button>
                <button
                  className="workflow-undo"
                  disabled={busy || step === 0 || ss.some((s) => s.transferred)}
                  title="이전 단계 취소"
                  aria-label="이전 단계 취소"
                  onClick={() => void run(() => undoGroup(actionState(g.id), g.id))}
                >
                  ↶
                </button>
              </div>
            )}
            <div className="flow-fixed-summary">
              <div className="flow-summary-line">
                <span>배송 {ss.length}건</span>
                <span>
                  총 운임{" "}
                  {ss.every((s) => shipmentTotals(state, s).shipping !== null)
                    ? won(ss.reduce((sum, s) => sum + shipmentTotals(state, s).shipping!, 0))
                    : "확인 필요"}
                </span>
              </div>
              <div className="flow-summary-line">
                <span>입금 예정 {won(groupTotals(state, g.id).total)}</span>
                <span>
                  {ss.every((s) => {
                    const { order, recipient } = shipmentContext(state, s);
                    return shipmentVat(order, recipient);
                  })
                    ? "부가세 포함"
                    : ss.some((s) => {
                      const { order, recipient } = shipmentContext(state, s);
                      return shipmentVat(order, recipient);
                    })
                      ? "부가세 포함/별도"
                      : "부가세 별도"}
                </span>
              </div>
            </div>
            {(g.needsNotice || ss.some((s) => s.rechecks?.some((c) => !c.resolvedAt))) && (
              <div className="flow-recheck">
                <b>정정 후 재확인</b>
                {ss.flatMap(
                  (s) =>
                    s.rechecks
                      ?.filter((c) => !c.resolvedAt)
                      .slice(-1)
                      .map((c, n) => (
                        <small key={s.id + n}>
                          {shipmentContext(state, s).recipient.name} / {c.reason} / 이전{" "}
                          {c.fromStage}단계 이력 보존
                        </small>
                      )) ?? [],
                )}
                {g.needsNotice && (
                  <span>
                    금액 재안내 필요 / 이전 {won(g.notices.at(-1)?.total ?? null)} → 현재{" "}
                    {won(groupTotals(state, g.id).total)} / 차액{" "}
                    {groupTotals(state, g.id).total !== null && g.notices.length
                      ? won(groupTotals(state, g.id).total! - g.notices.at(-1)!.total)
                      : "확인 필요"}
                  </span>
                )}
              </div>
            )}
            {open && (
              <div className="workflow-shipment-list">
                <div className="workflow-list-head">
                  <span>수취인</span>
                  <span>상품</span>
                  <span>운임</span>
                </div>
                {ss.map((s) => {
                  const { recipient } = shipmentContext(state, s);
                  return (
                    <button
                      key={s.id}
                      className={
                        "workflow-shipment" +
                        (s.id === selection?.shipmentId ? " chosen" : "") +
                        (s.id === leaving ? " query-leaving" : "") +
                        (activeKey &&
                        (activeKey.startsWith(recipient.id + ":") ||
                          recipient.items.some((i) => activeKey.startsWith(i.id + ":")))
                          ? " linked-active"
                          : "")
                      }
                      data-shipment-id={s.id}
                      aria-label={"배송 건 " + recipient.name}
                      onClick={() =>
                        onSelect({
                          orderId: s.orderId,
                          groupId: g.id,
                          shipmentId: s.id,
                        })
                      }
                    >
                      <span className="shipment-recipient" title={recipient.name}>
                        {recipient.name || "수취인 확인"}
                      </span>
                      <span className="shipment-products">
                        {recipient.items.map((i) => (
                          <span
                            className={
                              "product-chip" +
                              (orderIssues(first.order).some(
                                (issue) => issue.itemId === i.id && issue.severity === "ACTION",
                              )
                                ? " product-chip-error"
                                : "")
                            }
                            key={i.id}
                            title={i.name}
                          >
                            {internalModel(i.name)} × {i.quantity ?? "?"}
                          </span>
                        ))}
                      </span>
                      <span className="shipment-freight">
                        {shipmentFreightCode(shipmentContext(state, s).order, recipient) === "020"
                          ? "착불"
                          : shipmentTotals(state, s).shipping === null
                            ? "확인 필요"
                            : won(shipmentTotals(state, s).shipping)}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </article>
        );
      })}
      {undoDelete && (
        <div className="delete-undo" role="status">
          주문 묶음을 삭제했습니다.{" "}
          <button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                if (
                  state.workflow?.groups.find((g) => g.id === undoDelete.gid)?.deletedAt !==
                  undoDelete.at
                )
                  throw Error("직전 삭제 상태가 변경되었습니다.");
                await onSave(restoreGroup(state, undoDelete.gid));
                setUndoDelete(undefined);
              } catch (e) {
                onNotice(e instanceof Error ? e.message : String(e), "error");
              } finally {
                setBusy(false);
              }
            }}
          >
            실행 취소
          </button>
        </div>
      )}
      {manage && (
        <GroupManagement
          state={actionState(manage)}
          groupId={manage}
          onClose={() => setManage(undefined)}
          onSave={async (s) => {
            await onSave(s);
            setManage(undefined);
          }}
          onNotice={onNotice}
        />
      )}
    </div>
  );
}

function GroupManagement({
  state,
  groupId,
  onClose,
  onSave,
  onNotice,
}: {
  state: State;
  groupId: string;
  onClose: () => void;
  onSave: (s: State) => Promise<void>;
  onNotice: NoticeSink;
}) {
  const ss = groupShipments(state, groupId),
    g = state.workflow!.groups.find((g) => g.id === groupId)!,
    [target, setTarget] = useState(""),
    [ack, setAck] = useState(false),
    [busy, setBusy] = useState(false);
  const targets = state.workflow!.groups.filter(
    (t) =>
      t.id !== g.id &&
      t.sourceId === g.sourceId &&
      t.dealerId === g.dealerId &&
      groupShipments(state, t.id).some((s) => !s.transferred),
  );
  const run = async (fn: () => State) => {
    setBusy(true);
    try {
      await onSave(fn());
    } catch (e) {
      onNotice(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="배송 건 묶음 관리" onClose={onClose}>
      <p>
        발주{" "}
        {String(state.workflow!.sources.find((s) => s.id === g.sourceId)!.number).padStart(3, "0")}{" "}
 / 현재 {ss.length}건 / {won(groupTotals(state, groupId).total)}
      </p>
      {ss.map((s) => (
        <div className="flow-manage-row" key={s.id}>
          <span>
            {shipmentContext(state, s).recipient.name} / {s.step}/4 완료 / 입금{" "}
            {won(paymentBalance(state, s).paid)}
          </span>
          <button
            disabled={busy || ss.length < 2 || s.transferred}
            onClick={() => void run(() => detachShipment(state, s.id))}
          >
            이 배송 건 분리
          </button>
        </div>
      ))}
      {targets.length > 0 && (
        <>
          <Field label="다시 묶을 대상">
            <select value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="">같은 최초 발주서의 묶음 선택</option>
              {targets.map((t) => (
                <option key={t.id} value={t.id}>
                  {groupShipments(state, t.id)
                    .map((s) => shipmentContext(state, s).recipient.name)
                    .join(", ")}{" "}
 / {groupStep(state, t.id)}/4 / {won(groupTotals(state, t.id).total)}
                </option>
              ))}
            </select>
          </Field>
          <label className="check">
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> 기존
            안내액 / 입금 배분 / 변경 합계를 확인했습니다. 합친 뒤 필요하면 다시 안내합니다.
          </label>
          {ss.map((s) => (
            <button
              key={s.id}
              disabled={busy || !target || s.transferred}
              onClick={() => void run(() => regroupShipment(state, s.id, target, ack))}
            >
              {shipmentContext(state, s).recipient.name} 다시 묶기
            </button>
          ))}
        </>
      )}
      <p className="muted">
        배송 건 ID / 완료 이력 / 입금 배분은 그대로 보존됩니다. 단계나 계좌가 다른 묶음, 엑셀 이관 건은
        합치지 않습니다.
      </p>
    </Modal>
  );
}
