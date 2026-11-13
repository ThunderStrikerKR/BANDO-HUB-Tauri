import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import { createPortal, flushSync } from "react-dom";
import { HubPanels, defaultPanels } from "./HubPanels";
import { askSaveChanges } from "./dialogs";
import { requestPageLeave } from "./shared/page-leave";
import { LinkContext } from "./LinkedText";
import { MessageWorkspace } from "./MessageWorkspace";
import { OrderDesk } from "./OrderDesk";
import { WorkflowBoard, type WorkflowSelection } from "./WorkflowBoard";
import { newReception } from "./orders/reception";
import { nativeReconcileWorkflow } from "./orders/native-rules";
import { useNativeWorkflowReconcile } from "./orders/useNativeWorkflowReconcile";
import { retainUnsavedOrderEdits } from "./order-edit-snapshots";
import type { Order } from "./types";
import { groupShipments, reconcileWorkflow } from "./workflow";
import { activeShipments, validSelection } from "./workspace-selection";
type Props = ComponentProps<typeof OrderDesk> & {
  externalKakao: boolean;
  onNew: () => void;
  onRememberSelection: (s: WorkflowSelection) => void;
  onResetDock: () => void;
  onRegisterOrderLeaveGuard?: (guard?: () => Promise<{ proceed: boolean; handledDraft: boolean }>) => void;
};
const ManualClassification = lazy(() =>
  import("./orders/ManualClassification").then((module) => ({
    default: module.ManualClassification,
  })),
);
export function HubWorkspace(props: Props) {
  const [manual, setManual] = useState(false);
  const [discardRevision, setDiscardRevision] = useState(0);
  const deletedSelection = useRef<WorkflowSelection | undefined>(undefined);
  const leaveGuardRef = useRef<() => Promise<{ proceed: boolean; handledDraft: boolean }>>(
    async () => ({ proceed: true, handledDraft: false }),
  );
  const { state, draft } = props;
  const [receptionId, setReceptionId] = useState(draft.id);
  useEffect(() => {
    setReceptionId(draft.id);
    if (!state.orders.some((o) => o.id === draft.id)) commitSelection(undefined);
  }, [draft.id]);
  const [source, setSource] = useState<HTMLElement | null>(null),
    [messages, setMessages] = useState<HTMLElement | null>(null),
    [details, setDetails] = useState<HTMLElement | null>(null),
    [selected, commitSelection] = useState<WorkflowSelection | undefined>(props.workflowSelection),
    [edits, setEdits] = useState<Record<string, Order>>({}),
    [active, setActive] = useState(""),
    [stageHover, setStageHover] = useState<{ groupId: string; step: number }>();
  const applySelection = (next: WorkflowSelection | undefined) => {
    if (next) {
      setReceptionId(next.orderId);
      if (
        next.orderId !== draft.id &&
        receptionId === draft.id &&
        draft.raw.trim() &&
        !state.orders.some((o) => o.id === draft.id)
      )
        setEdits((old) => ({ ...old, [draft.id]: structuredClone(draft) }));
    }
    if (
      next?.shipmentId === selected?.shipmentId &&
      next?.orderId === selected?.orderId &&
      next?.groupId === selected?.groupId
    )
      return;
    // After the user has chosen what happens to edits, change data ownership immediately.
    flushSync(() => commitSelection(next));
  };
  const setSelected = (
    value:
      | WorkflowSelection
      | undefined
      | ((previous: WorkflowSelection | undefined) => WorkflowSelection | undefined),
  ) => {
    const next = typeof value === "function" ? value(selected) : value;
    if (next?.shipmentId === selected?.shipmentId && next?.orderId === selected?.orderId && next?.groupId === selected?.groupId) return;
    void (async () => {
      // In-place shipment changes can unmount an actual-freight editor too.
      const fields = await requestPageLeave((message) => props.onNotice(message, "error"));
      if (!fields.proceed) return;
      if (selected?.orderId && next?.orderId && selected.orderId !== next.orderId) {
        const leave = await leaveGuardRef.current();
        if (!leave.proceed) return;
      }
      applySelection(next);
    })().catch((error) => props.onNotice(String(error), "error"));
  };
  useEffect(() => {
    if (!selected?.shipmentId) return;
    const timer = setTimeout(
      () =>
        document
          .querySelector('[data-shipment-id="' + CSS.escape(selected.shipmentId!) + '"]')
          ?.scrollIntoView({ block: "nearest", inline: "nearest" }),
      20,
    );
    return () => clearTimeout(timer);
  }, [selected?.shipmentId]);
  // The old synchronous TypeScript reconciliation must not be the live
  // workflow board's authority. Rust evaluates each employee draft overlay,
  // returning only temporary preview state with no SQLite writes.
  const independentEdits = useMemo(
    () => Object.values(edits).filter((order) => order.id !== draft.id && order.clientId),
    [edits, draft.id],
  );
  const nativeBase = useNativeWorkflowReconcile(state, independentEdits);
  const base = nativeBase.state;
  const nativePreview = useNativeWorkflowReconcile(base, draft.clientId ? [draft] : []);
  const preview = nativePreview.state;
  const previewReady = nativeBase.ready && nativePreview.ready;
  useEffect(() => {
    // Selection and active shipment identity must never be rewritten from a
    // pending, non-authoritative render of the previous draft.
    if (!previewReady) return;
    const fresh = receptionId === draft.id && !state.orders.some((o) => o.id === draft.id);
    const next = fresh
      ? draft.recipients.length
        ? validSelection(
            preview,
            selected?.orderId === draft.id
              ? selected
              : { orderId: draft.id, groupId: "group:" + draft.id },
          )
        : undefined
      : validSelection(preview, selected);
    if (JSON.stringify(next) !== JSON.stringify(selected)) {
      commitSelection(next);
      if (next) setReceptionId(next.orderId);
    }
  }, [selected, preview, receptionId, draft, previewReady]);
  useEffect(() => {
    if (selected) props.onRememberSelection(selected);
  }, [selected, props.onRememberSelection]);
  const detail = selected
    ? selected.orderId === draft.id
      ? draft
      : (edits[selected.orderId] ??
        state.orders.find((o) => o.id === selected.orderId && !o.deletedAt))
    : undefined;
  const onSave = async (next: typeof state) => {
    const removed =
      next.workflow?.groups.filter(
        (g) => g.deletedAt && !state.workflow?.groups.find((old) => old.id === g.id)?.deletedAt,
      ) ?? [];
    const restored =
      next.workflow?.groups.filter(
        (g) => !g.deletedAt && state.workflow?.groups.find((old) => old.id === g.id)?.deletedAt,
      ) ?? [];
    const removedCurrent = removed.some((g) => g.id === selected?.groupId);
    if (removedCurrent) deletedSelection.current = selected;
    await props.onWorkflowSave(next);
    // A workflow save for another order must not discard this order's unsaved edits.
    setEdits((previous) => retainUnsavedOrderEdits(previous, next.orders));
    if (removed.length || restored.length) {
      props.onNotice("");
      const target = validSelection(
        next,
        restored.some((g) => g.id === deletedSelection.current?.groupId)
          ? deletedSelection.current
          : removedCurrent
            ? undefined
            : selected,
      );
      commitSelection(target);
      setActive("");
      setStageHover(undefined);
      if (target) {
        setReceptionId(target.orderId);
        const order = next.orders.find((o) => o.id === target.orderId);
        if (order) props.onChange(structuredClone(order));
      } else {
        const empty = newReception();
        setReceptionId(empty.id);
        props.onChange(empty);
      }
    }
  };
  leaveGuardRef.current = async () => {
    const orderId = selected?.orderId ?? receptionId;
    const persisted = state.orders.find((order) => order.id === orderId);
    const pending = orderId === draft.id ? draft : edits[orderId];
    if (!persisted || !pending || JSON.stringify(pending) === JSON.stringify(persisted))
      return { proceed: true, handledDraft: false };
    const choice = await askSaveChanges(
      "수정한 주문 정보가 저장되지 않았습니다. 저장하고 이동할까요?",
    );
    if (choice === "cancel") return { proceed: false, handledDraft: false };
    if (choice === "save") {
      try {
        await onSave(await nativeReconcileWorkflow(state, pending));
      } catch (error) {
        props.onNotice(error instanceof Error ? error.message : String(error), "error");
        return { proceed: false, handledDraft: false };
      }
    } else {
      if (orderId === draft.id) props.onChange(structuredClone(persisted));
      setEdits((previous) => {
        if (!(orderId in previous)) return previous;
        const next = { ...previous };
        delete next[orderId];
        return next;
      });
      setDiscardRevision((value) => value + 1);
    }
    return { proceed: true, handledDraft: orderId === draft.id };
  };
  useEffect(() => {
    props.onRegisterOrderLeaveGuard?.(() => leaveGuardRef.current());
    return () => props.onRegisterOrderLeaveGuard?.(undefined);
  }, [props.onRegisterOrderLeaveGuard]);
  const changeDetail: Props["onChange"] = (value) => {
    const current = detail ?? draft;
    if (
      state.orders.some((o) => o.id === current.id) &&
      !activeShipments(preview).some((s) => s.orderId === current.id)
    )
      return;
    const next = typeof value === "function" ? value(current) : value;
    if (JSON.stringify(next) === JSON.stringify(current)) return;
    if (current.id === draft.id) props.onChange(next);
    else setEdits((previous) => ({ ...previous, [next.id]: next }));
  };
  const [vertical, setVertical] = useState<number>(),
    verticalDrag = useRef<{ y: number; height: number; start: number } | undefined>(undefined);
  useEffect(() => setVertical(undefined), [state.settings.receptionVerticalRatio]);
  const verticalRatio = vertical ?? state.settings.receptionVerticalRatio ?? 0.5;
  const linkedRecipient = preview.orders
    .flatMap((o) => o.recipients.map((r) => ({ order: o, recipient: r })))
    .find(
      ({ recipient: r }) =>
        active.startsWith(r.id + ":") || r.items.some((i) => active.startsWith(i.id + ":")),
    );
  const linkController = {
    active,
    recipientId: linkedRecipient?.recipient.id,
    setActive: (key: string) => {
      setActive(key);
      if (!key) return;
      const target = activeShipments(preview).find((s) =>
        preview.orders
          .find((o) => o.id === s.orderId)
          ?.recipients.some(
            (r) =>
              r.id === s.recipientId &&
              (key.startsWith(r.id + ":") || r.items.some((i) => key.startsWith(i.id + ":"))),
          ),
      );
      if (target)
        setSelected((previous) =>
          previous?.shipmentId === target.id
            ? previous
            : {
                orderId: target.orderId,
                groupId: target.groupId,
                shipmentId: target.id,
              },
        );
    },
  };
  const receptionOrder =
    receptionId === draft.id
      ? draft
      : (edits[receptionId] ??
        state.orders.find((o) => o.id === receptionId && !o.deletedAt) ??
        draft);
  useEffect(() => setManual(false), [receptionOrder.id, receptionOrder.raw]);
  const changeReception: Props["onChange"] = (value) => {
    if (
      state.orders.some((o) => o.id === receptionOrder.id) &&
      !activeShipments(preview).some((s) => s.orderId === receptionOrder.id)
    )
      return;
    if (receptionOrder.id === draft.id) props.onChange(value);
    else {
      const next = typeof value === "function" ? value(receptionOrder) : value;
      setEdits((old) => ({ ...old, [next.id]: next }));
    }
  };
  const messageOrder = receptionOrder,
    messageState = messageOrder.clientId ? reconcileWorkflow(base, messageOrder) : base,
    messageGroup =
      selected?.orderId === messageOrder.id &&
      selected?.groupId &&
      groupShipments(messageState, selected.groupId).length > 0
        ? selected.groupId
        : messageState.workflow?.groups.find((g) =>
            groupShipments(messageState, g.id).some((s) => s.orderId === messageOrder.id),
          )?.id;
  return (
    <div
      className="hub-live-workspace"
      data-hover-stage={stageHover?.step}
      data-hover-selected={stageHover?.groupId === selected?.groupId ? "true" : "false"}
    >
      <HubPanels
        externalKakao={props.externalKakao}
        ratios={state.settings.panelRatios ?? defaultPanels}
        onSave={(ratios) =>
          void props
            .onSaveState({
              ...state,
              settings: { ...state.settings, panelRatios: ratios },
            })
            .catch((e) => props.onNotice(String(e)))
        }
        onReset={() => {
          setVertical(undefined);
          void props
            .onSaveState({
              ...state,
              settings: {
                ...state.settings,
                panelRatios: defaultPanels,
                receptionVerticalRatio: 0.5,
              },
            })
            .catch((e) => props.onNotice(String(e)));
          props.onResetDock();
        }}
      >
        {[
          <section className="desk-pane hub-kakao-placeholder">
            <h2>카카오톡</h2>
            <p>
              상단의 카카오톡 함께 보기를 누르면
              <br />
              기본 메신저와 대화창을 왼쪽에 배치합니다.
            </p>
          </section>,
          <div
            className="hub-reception-stack"
            style={{
              gridTemplateRows: `minmax(275px,${verticalRatio}fr) 6px minmax(160px,${1 - verticalRatio}fr)`,
            }}
          >
            <div ref={setSource} className="hub-portal-target" />
            <div
              className="hub-split horizontal"
              role="separator"
              aria-label="원문과 메시지 높이 조절"
              aria-orientation="horizontal"
              tabIndex={0}
              title="드래그 높이 조절 / 두 번 클릭 5:5"
              onDoubleClick={() => {
                setVertical(undefined);
                void props.onSaveState({
                  ...state,
                  settings: {
                    ...state.settings,
                    panelRatios: defaultPanels,
                    receptionVerticalRatio: 0.5,
                  },
                });
                props.onResetDock();
              }}
              onPointerDown={(e) => {
                verticalDrag.current = {
                  y: e.clientY,
                  height: e.currentTarget.parentElement!.getBoundingClientRect().height,
                  start: verticalRatio,
                };
                e.currentTarget.setPointerCapture(e.pointerId);
              }}
              onPointerMove={(e) => {
                const d = verticalDrag.current;
                if (d)
                  setVertical(
                    Math.max(0.25, Math.min(0.75, d.start + (e.clientY - d.y) / d.height)),
                  );
              }}
              onPointerUp={() => {
                if (!verticalDrag.current) return;
                const start = verticalDrag.current.start;
                verticalDrag.current = undefined;
                if (vertical === undefined || vertical === start) return;
                void props
                  .onSaveState({
                    ...state,
                    settings: {
                      ...state.settings,
                      receptionVerticalRatio: verticalRatio,
                    },
                  })
                  .catch((e) => props.onNotice(String(e)));
              }}
              onPointerCancel={() => {
                verticalDrag.current = undefined;
                setVertical(undefined);
              }}
            />
            <div ref={setMessages} className="hub-portal-target" />
          </div>,
          <div ref={setDetails} className="hub-portal-target" />,
          <section className="desk-pane hub-management">
            <header className="pane-heading">
              <h2>처리 중인 주문</h2>
              <button
                disabled={!selected}
                onClick={() => selected && props.onSelectWorkflow(selected)}
              >
                선택 원문 보기
              </button>
              <button className="primary" onClick={props.onNew}>
                ＋ 새 주문
              </button>
            </header>
            <WorkflowBoard
              state={preview}
              previewReady={previewReady}
              previewError={nativeBase.error || nativePreview.error}
              persistedState={base}
              selection={selected}
              activeKey={active}
              onSelect={setSelected}
              onSave={onSave}
              onNotice={props.onNotice}
              onStageHover={setStageHover}
              stageHover={stageHover}
            />
          </section>,
        ]}
      </HubPanels>
      {messages &&
        createPortal(
          <LinkContext.Provider value={linkController}>
            <MessageWorkspace
              state={messageState}
              order={messageOrder}
              gid={nativeBase.ready ? messageGroup : undefined}
              onOrder={(o) => {
                changeReception(o);
              }}
              onSave={onSave}
              onSelect={(id) => {
                const s = messageState.workflow?.shipments.find((s) => s.id === id);
                if (s)
                  setSelected({
                    orderId: s.orderId,
                    groupId: s.groupId,
                    shipmentId: s.id,
                  });
              }}
              onNotice={props.onNotice}
            />
          </LinkContext.Provider>,
          messages,
        )}
      <div className="hub-order-engine">
        <OrderDesk
          {...props}
          key={receptionOrder.id + ":reception:" + discardRevision}
          state={base}
          persistedOrders={state.orders}
          draft={receptionOrder}
          onChange={changeReception}
          viewMode="reception"
          onManual={() => setManual(true)}
          portalTargets={{ source, messages }}
          linkController={linkController}
          onWorkflowSave={onSave}
        />
        <OrderDesk
          {...props}
          key={(detail?.id ?? draft.id) + ":" + (selected?.groupId ?? "empty") + ":" + discardRevision}
          state={base}
          persistedOrders={state.orders}
          draft={detail ?? draft}
          viewMode="details"
          onManual={() => setManual(true)}
          portalTargets={{ details }}
          linkController={linkController}
          workflowSelection={selected}
          onSelectWorkflow={setSelected}
          onChange={changeDetail}
          onWorkflowSave={onSave}
          onSave={async () => onSave(await nativeReconcileWorkflow(base, detail ?? draft))}
        />
      </div>
      {manual && (
        <Suspense fallback={null}>
          <ManualClassification
            key={receptionOrder.id + ":" + receptionOrder.raw}
            state={state}
            order={receptionOrder}
            onNotice={props.onNotice}
            onClose={() => setManual(false)}
            onApply={(next) => {
              if (state.orders.some((o) => o.id === next.id) || receptionOrder.raw !== next.raw)
                throw Error("접수 상태가 변경되었습니다. 다시 확인하세요.");
              changeReception(next);
              setActive("");
              commitSelection(undefined);
            }}
          />
        </Suspense>
      )}
    </div>
  );
}
