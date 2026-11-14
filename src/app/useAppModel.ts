import { useCallback, useEffect, useRef, useState } from "react";
import { confirmAction, askSaveChanges } from "../dialogs";
import { orderClient } from "../domain";
import { businessCoreCall } from "../tauri-bridge";
import { newReception } from "../orders/reception";
import { useHasPendingChanges } from "../shared/pending-changes";
import { requestPageLeave } from "../shared/page-leave";
import { useAsyncTask } from "../shared/useAsyncTask";
import { useNotice } from "../shared/useNotice";
import type { DockStatus, DockWindow, InboxEntry, Order, StartupStatus, State } from "../types";
import { clone } from "../ui";
import type { WorkflowSelection } from "../WorkflowBoard";
import { onlyDeletedGroups } from "../workspace-selection";
import type { PageId } from "./navigation";
import { seoulDate } from "./seoul-date";
export type OrderLeaveResult = { proceed: boolean; handledDraft: boolean };
export function useAppModel() {
  const { notice, notify: setNotice, dismiss: dismissNotice } = useNotice();
  const [historyDate, setHistoryDate] = useState(() => seoulDate(new Date().toISOString())),
    [settlementDate, setSettlementDate] = useState(() => seoulDate(new Date().toISOString()));
  const hasPendingChanges = useHasPendingChanges();
  const [rawEditDirty, setRawEditDirty] = useState(false);
  const orderLeaveGuard = useRef<(() => Promise<OrderLeaveResult>) | undefined>(undefined);
  const registerOrderLeaveGuard = useCallback((guard?: () => Promise<OrderLeaveResult>) => {
    orderLeaveGuard.current = guard;
  }, []);
  const confirmOrderLeave = async (): Promise<OrderLeaveResult> =>
    orderLeaveGuard.current ? orderLeaveGuard.current() : { proceed: true, handledDraft: false };
  const [state, setState] = useState<State>(),
    [draft, setDraft] = useState<Order>(),
    [tab, setTab] = useState<PageId>("접수"),
    [busy, setBusy] = useState(false),
    [query, setQuery] = useState(""),
    [dock, setDock] = useState<DockStatus>({ active: false, ratio: 0.8 }),
    [dockBusy, setDockBusy] = useState(false),
    [dockCandidates, setDockCandidates] = useState<DockWindow[]>([]),
    [workflowSelection, setWorkflowSelection] = useState<WorkflowSelection>();
  const [startup, setStartup] = useState<StartupStatus>({
    phase: "OPENING", attempts: 1, isTest: false,
  });
  const [startupBusy, setStartupBusy] = useState(false);
  const { run } = useAsyncTask(setNotice);
  useEffect(() => {
    let cancelled = false;
    const launch = async () => {
      const api = window.bando;
      if (!api) {
        if (!cancelled) setStartup({
          phase: "ERROR", attempts: 1, isTest: false,
          error: "PC 프로그램 연결을 확인할 수 없습니다.",
        });
        return;
      }
      try {
        const status: StartupStatus = api.startupStatus
          ? await api.startupStatus()
          : { phase: "READY", attempts: 1, isTest: !!api.isTestWorkspace };
        if (cancelled) return;
        setStartup(status);
        if (status.phase !== "READY") return;
        const loaded = await api.load();
        if (cancelled) return;
        setState(loaded);
        setDraft(newReception());
        void api.dockStatus().then((value) => {
          if (!cancelled) setDock(value);
        }).catch((error) => {
          if (!cancelled) setNotice(String(error), "error");
        });
      } catch (error) {
        if (!cancelled) setStartup((previous) => ({
          ...previous, phase: "ERROR", error: String(error),
        }));
      }
    };
    void launch();
    return () => { cancelled = true; };
  }, []);

  const retryStartup = async () => {
    if (startupBusy || !window.bando) return;
    const api = window.bando;
    setStartupBusy(true);
    setStartup((previous) => ({ ...previous, phase: "RETRYING", error: null }));
    try {
      // If only the frontend hydration failed while the native database is
      // already READY, retry reading it instead of reopening SQLite.
      const native = await api.startupStatus?.().catch(() => undefined);
      const next = native?.phase === "READY" ? native : await api.retryStartup();
      setStartup(next);
      if (next.phase === "READY") {
        const loaded = await api.load();
        setState(loaded);
        setDraft(newReception());
        const dock = await api.dockStatus().catch(() => undefined);
        if (dock) setDock(dock);
      }
    } catch (error) {
      // Re-read the authoritative native error rather than hiding it behind a
      // generic IPC rejection. Never reset data or restore a backup here.
      const native = await api.startupStatus?.().catch(() => undefined);
      setStartup(native?.phase === "ERROR" ? native : {
        phase: "ERROR", attempts: startup.attempts, isTest: startup.isTest,
        error: String(error),
      });
    } finally {
      setStartupBusy(false);
    }
  };

  useEffect(() => {
    document.documentElement.style.setProperty(
      "--ui-scale",
      String((state?.settings.uiScale ?? 100) / 100),
    );
  }, [state?.settings.uiScale]);
  useEffect(
    () =>
      window.bando?.onLayoutReset?.(() => {
        void window
          .bando!.load()
          .then(async (next) => {
            next.settings.panelRatios = [20, 30, 30, 20];
            next.settings.receptionVerticalRatio = 0.5;
            const committed = await window.bando!.save(next);
            await refresh(committed);
          })
          .catch((e) => setNotice(String(e), "error"));
      }),
    [],
  );
  useEffect(() => {
    if (dock.notice) setNotice(dock.notice);
  }, [dock.notice]);
  useEffect(() => {
    if (!dock.active) return;
    const timer = setInterval(
      () =>
        void window
          .bando!.dockStatus()
          .then(setDock)
          .catch((e) => setNotice(String(e), "error")),
      300,
    );
    return () => clearInterval(timer);
  }, [dock.active]);
  useEffect(() => {
    if (!window.bando || startup.phase !== "READY") return;
    const timer = setInterval(() => {
      void window
        .bando!.load()
        .then((next) => setState((old) => (!old || (next.revision ?? 0) > (old.revision ?? 0) ? next : old)))
        .catch(() => {});
    }, 4000);
    return () => clearInterval(timer);
  }, [startup.phase]);
  const commitGuard = useRef(false);
  const lastCommitted = useRef<State | undefined>(undefined);
  // Native write commands return an authoritative snapshot after the transaction.
  const refresh = async (committed?: State) => {
    const result = committed ?? await window.bando!.load();
    setState((previous) =>
      !previous || (result.revision ?? 0) >= (previous.revision ?? 0) ? result : previous,
    );
  };
  const commit = async (next: State) => {
    if (commitGuard.current) throw Error("다른 변경을 저장 중입니다. 잠시 후 다시 시도하세요.");
    commitGuard.current = true;
    setBusy(true);
    try {
      const prepared = next.orders.find(
        (o) => o.id === draft?.id && o.receptionVersion === 1 && !o.confirmedAt,
      );
      // Rust owns the authoritative draft/linked-workflow sanitization. A failed
      // native validation must abort before the sole SQLite write below.
      const { state: persistent } = await businessCoreCall<{ state: State }>(
        "rules", "apply_reception_action", {
          action: "persisted_reception_state", before: state!, state: next,
        },
      );
      if (JSON.stringify(persistent) === JSON.stringify(state)) {
        lastCommitted.current = state;
        if (prepared) setDraft(clone(prepared));
        return;
      }
      // A successful native response proves the write committed.
      // No post-commit state_load is required to update the visible state.
      const committed = await window.bando!.save(persistent);
      lastCommitted.current = committed;
      await refresh(committed);
      if (prepared) setDraft(clone(prepared));
    } finally {
      commitGuard.current = false;
      setBusy(false);
    }
  };
  const saveSettings = async (changes: Record<string, unknown>, expected: Record<string, unknown>) => {
    const api = window.bando;
    if (!api?.patchSettings) throw Error("설정 개별 저장을 지원하지 않는 버전입니다.");
    const updated = await api.patchSettings(changes, expected);
    setState(updated);
  };
  const dirty =
    rawEditDirty ||
    hasPendingChanges ||
    (!!draft &&
      (state?.orders.some((o) => o.id === draft.id)
        ? JSON.stringify(draft) !== JSON.stringify(state.orders.find((o) => o.id === draft.id))
        : !!(draft.raw || draft.clientId || draft.recipients.length)));
  const latestSaveInputs = useRef({ state, draft });
  latestSaveInputs.current = { state, draft };
  const saveOrder = async (mode: "save" | "notify" | "pay" | "queue" | "wait") => {
    if (!state || !draft) return;
    if (
      draft.receptionVersion === 1 &&
      !draft.confirmedAt &&
      !state.orders.some((o) => o.id === draft.id)
    )
      throw Error("최종 검수 후 주문 확인 완료로 정식 접수하세요.");
    const c = orderClient(draft, state);
    if (!c) throw Error("거래처를 선택하세요.");
    // The native Rust rules engine owns amounts, approvals, status and queue
    // membership. A result for an older draft/revision must not be committed.
    const sourceState = state;
    const sourceDraft = draft;
    let preparedDraft = sourceDraft;
    // A user may press Save before the pending native tariff calculation
    // finishes. Never persist an interim empty freight/version marker.
    if (sourceDraft.shippingMode === "AUTO" &&
        sourceDraft.shippingVersion === "" && sourceDraft.shippingFee === null) {
      const freight = await businessCoreCall<{ total: number | null; version: string }>(
        "rules", "calculate_shipping", { order: sourceDraft, state: sourceState },
      );
      if (latestSaveInputs.current.state !== sourceState ||
          latestSaveInputs.current.draft !== sourceDraft)
        throw Error("운임 계산 중 주문이 변경되었습니다. 확인 후 다시 저장하세요.");
      preparedDraft = {
        ...sourceDraft,
        shippingFee: c.shippingFeeExcluded ? 0 : freight.total,
        shippingVersion: freight.version,
      };
    }
    const result = await businessCoreCall<{ state: State; order: Order }>(
      "rules", "save_order", {
        state: sourceState, order: preparedDraft, client: c,
        mode, now: new Date().toISOString(),
      },
    );
    const current = latestSaveInputs.current;
    if (current.state !== sourceState || current.draft !== sourceDraft)
      throw Error("주문 정보가 변경되었습니다. 최신 내용을 확인한 뒤 다시 저장하세요.");
    await commit(result.state);
    // A newer draft may have opened while the native SQLite transaction
    // completed. A successful save must not replace that newer draft.
    setDraft((currentDraft) => currentDraft === sourceDraft ? result.order : currentDraft);
    setNotice(mode === "queue" ? "공장 목록에 추가했습니다." : "주문을 저장했습니다.");
  };
  // A new reception cannot be saved until the employee confirms the order.
  const confirmReceptionDraftLeave = async (): Promise<boolean> => {
    if (!draft || !dirty) return true;
    const choice = await askSaveChanges("접수 화면에 저장하지 않은 변경사항이 있습니다. 어떻게 할까요?");
    if (choice === "cancel") return false;
    if (choice === "save") {
      if (!state?.orders.some((order) => order.id === draft.id)) {
        setNotice("신규 발주서는 주문 확인 완료 후 저장할 수 있습니다. 확인을 마치거나 저장 안 함을 선택하세요.", "error");
        return false;
      }
      try {
        await saveOrder("save");
      } catch (error) {
        setNotice(error instanceof Error ? error.message : String(error), "error");
        return false;
      }
    } else {
      const persisted = state?.orders.find((order) => order.id === draft.id);
      setDraft(persisted ? clone(persisted) : newReception());
      setRawEditDirty(false);
    }
    return true;
  };
  const open = async (o?: Order) => {
    if (o && onlyDeletedGroups(state!, o.id)) {
      setNotice("이 주문의 묶음은 삭제되었습니다. 최초 원문은 설정의 감사 기록에서 확인하세요.");
      return false;
    }
    const leave = await confirmOrderLeave();
    if (!leave.proceed) return false;
    if (tab !== "접수") {
      const pageLeave = await requestPageLeave((message) => setNotice(message, "error"));
      if (!pageLeave.proceed) return false;
      if (hasPendingChanges && !pageLeave.handled) {
        setNotice("현재 화면에서 변경사항을 저장하거나 취소한 뒤 주문을 열어 주세요.", "error");
        return false;
      }
    } else if (!leave.handledDraft && !(await confirmReceptionDraftLeave())) return false;
    setWorkflowSelection(undefined);
    setDraft(o ? clone(o) : newReception());
    setTab("접수");
    return true;
  };
  // Connecting, choosing one of two layouts, and disconnecting are
  // independent actions. No third viewing mode or implicit stop on cycling.
  const docking = async () => {
    if (dockBusy || dock.active) return;
    setDockBusy(true);
    try {
      const windows = await window.bando!.dockWindows();
      // Electron v0.8.10 connects in one click: prefer an existing
      // conversation over the messenger, then track every other window.
      const selected = windows.find((window) => window.kind === "CHAT")
        ?? windows.find((window) => window.kind === "MAIN")
        ?? windows[0];
      if (!selected) throw Error("실행 중인 카카오톡 창이 없습니다.");
      setDock(await window.bando!.dockStart(selected.handle, 0.8));
      setDockCandidates([]);
    } finally { setDockBusy(false); }
  };
  const setDockMode = async (mode: "OVERLAP" | "STACK") => {
    if (dockBusy || !dock.active || dock.mode === mode) return;
    setDockBusy(true);
    try { setDock(await window.bando!.dockMode(mode)); }
    finally { setDockBusy(false); }
  };
  const stopDock = async () => {
    if (dockBusy || !dock.active) return;
    setDockBusy(true);
    try { setDock(await window.bando!.dockStop()); setDockCandidates([]); }
    finally { setDockBusy(false); }
  };
  const selectDock = async (handle: string) => {
    if (dockBusy) return;
    setDockBusy(true);
    try {
      setDock(await window.bando!.dockSelect(handle));
      setDockCandidates([]);
    } finally {
      setDockBusy(false);
    }
  };
  const onWorkflowSave = async (next: State) => {
    if (!state || !draft) return;
    const pending = next.orders.find((o) => o.id === draft.id);
    if (
      pending?.receptionVersion === 1 &&
      !pending.confirmedAt &&
      !state.orders.some((o) => o.id === pending.id)
    ) {
      await commit(next);
      return;
    }
    const newEvents = next.workflow?.events.slice(state.workflow?.events.length ?? 0) ?? [];
    const includesDraft =
      JSON.stringify(next.orders.find((o) => o.id === draft.id)) === JSON.stringify(draft) ||
      newEvents.some((e) =>
        e.shipmentIds.some((id) =>
          next.workflow?.shipments.some((s) => s.id === id && s.orderId === draft.id),
        ),
      );
    await commit(next);
    if (next.orders.find((o) => o.id === draft.id)?.deletedAt) {
      setDraft(newReception());
      setWorkflowSelection(undefined);
      return;
    }
    if (!includesDraft) return;
    const loaded = lastCommitted.current!;
    const current = loaded.orders.find((o) => o.id === draft.id);
    if (current) {
      const all =
        loaded.workflow?.shipments.filter((s) => s.orderId === current.id && !s.legacyArchived) ??
        [];
      const active = all.filter(
        (s) =>
          !s.transferred && !loaded.workflow?.groups.find((g) => g.id === s.groupId)?.deletedAt,
      );
      if (all.length && !active.length) {
        setDraft(newReception());
        setWorkflowSelection(undefined);
      } else {
        setDraft(clone(current));
        if (active.length && !active.some((s) => s.id === workflowSelection?.shipmentId))
          setWorkflowSelection({
            orderId: current.id,
            groupId: active[0].groupId,
            shipmentId: active[0].id,
          });
      }
    }
  };
  const onSelectWorkflow = async (selection: WorkflowSelection) => {
    if (!state || !draft) return;
    if (selection.orderId !== draft.id) {
      const order = state.orders.find((o) => o.id === selection.orderId);
      if (!order || (await open(order)) === false) return;
    }
    setWorkflowSelection(selection);
  };
  const navigate = async (page: PageId) => {
    if (page === tab) return;
    if (tab === "접수") {
      const leave = await confirmOrderLeave();
      if (!leave.proceed) return;
      if (hasPendingChanges && !leave.handledDraft) {
        setNotice("저장하지 않은 편집창이 있습니다. 편집창에서 저장하거나 취소한 뒤 이동하세요.", "error");
        return;
      }
      if (!leave.handledDraft && !(await confirmReceptionDraftLeave())) return;
    } else {
      const leave = await requestPageLeave((message) => setNotice(message, "error"));
      if (!leave.proceed) return;
      if (hasPendingChanges && !leave.handled) {
        setNotice("저장하지 않은 편집 내용이 있습니다. 현재 화면에서 저장하거나 취소한 뒤 이동하세요.", "error");
        return;
      }
    }
    setTab(page);
    setQuery("");
  };
  const newOrder = async () => {
    await open();
  };
  const receive = async (entry: InboxEntry) => {
    const leave = await confirmOrderLeave();
    if (!leave.proceed) return;
    if (tab !== "접수") {
      const pageLeave = await requestPageLeave((message) => setNotice(message, "error"));
      if (!pageLeave.proceed) return;
      if (hasPendingChanges && !pageLeave.handled) {
        setNotice("편집 중인 내용을 저장하거나 취소한 뒤 수신 주문을 열어 주세요.", "error");
        return;
      }
    } else if (!leave.handledDraft && !(await confirmReceptionDraftLeave())) return;
    const order = newReception();
    order.raw = entry.text;
    order.photos = entry.photo ? [entry.photo] : [];
    order.channel = "휴대폰";
    setDraft(order);
    setTab("접수");
  };
  const windowAction = async (action: "minimize" | "maximize" | "close") => {
    if (action === "close") {
      if (tab === "접수") {
        const leave = await confirmOrderLeave();
        if (!leave.proceed) return;
        return window.bando!.requestClose(dirty && !leave.handledDraft);
      }
      const leave = await requestPageLeave((message) => setNotice(message, "error"));
      if (!leave.proceed) return;
      if (hasPendingChanges && !leave.handled) {
        setNotice("편집 중인 내용을 저장하거나 취소한 뒤 종료하세요.", "error");
        return;
      }
      return window.bando!.requestClose(false);
    }
    await window.bando!.windowControl(action);
    setDock(await window.bando!.dockStatus());
  };
  const afterRestore = async () => {
    await refresh();
    setDraft(newReception());
  };
  return {
    state,
    draft,
    startup,
    startupBusy,
    retryStartup,
    tab,
    navigate,
    notice,
    setNotice,
    dismissNotice,
    busy,
    query,
    setQuery,
    historyDate,
    setHistoryDate,
    settlementDate,
    setSettlementDate,
    dock,
    dockBusy,
    dockCandidates,
    setDockCandidates,
    selectDock,
    workflowSelection,
    setWorkflowSelection,
    setRawEditDirty,
    registerOrderLeaveGuard,
    setDraft,
    refresh,
    commit,
    saveSettings,
    dirty,
    saveOrder,
    open,
    docking,
    setDockMode,
    stopDock,
    run,
    onWorkflowSave,
    onSelectWorkflow,
    newOrder,
    receive,
    windowAction,
    afterRestore,
  };
}
