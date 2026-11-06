import { useEffect, useRef, useState } from "react";
import { confirmAction } from "../dialogs";
import { canQueue, orderClient, reviewIssues, totals } from "../domain";
import { newReception, persistedReceptionState } from "../orders/reception";
import { useHasPendingChanges } from "../shared/pending-changes";
import { useAsyncTask } from "../shared/useAsyncTask";
import { useNotice } from "../shared/useNotice";
import type { DockStatus, InboxEntry, Order, State } from "../types";
import { clone } from "../ui";
import type { WorkflowSelection } from "../WorkflowBoard";
import { onlyDeletedGroups } from "../workspace-selection";
import type { PageId } from "./navigation";
export function useAppModel() {
  const { notice, notify: setNotice, dismiss: dismissNotice } = useNotice();
  const [historyDate, setHistoryDate] = useState(() =>
      new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" }),
    ),
    [settlementDate, setSettlementDate] = useState(() => new Date().toLocaleDateString("en-CA"));
  const hasPendingChanges = useHasPendingChanges();
  const [rawEditDirty, setRawEditDirty] = useState(false);
  const [state, setState] = useState<State>(),
    [draft, setDraft] = useState<Order>(),
    [tab, setTab] = useState<PageId>("접수"),
    [busy, setBusy] = useState(false),
    [query, setQuery] = useState(""),
    [dock, setDock] = useState<DockStatus>({ active: false, ratio: 0.8 }),
    [dockBusy, setDockBusy] = useState(false),
    [workflowSelection, setWorkflowSelection] = useState<WorkflowSelection>();
  const { run } = useAsyncTask(setNotice);
  useEffect(() => {
    if (!window.bando) {
      setNotice("PC 프로그램으로 실행하세요.");
      return;
    }
    void window.bando
      .load()
      .then((s) => {
        setState(s);
        setDraft(newReception());
      })
      .catch((e) => setNotice(String(e), "error"));
    void window.bando
      .dockStatus()
      .then(setDock)
      .catch((e) => setNotice(String(e), "error"));
  }, []);
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
            await window.bando!.save(next);
            setState(await window.bando!.load());
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
      900,
    );
    return () => clearInterval(timer);
  }, [dock.active]);
  useEffect(() => {
    if (!window.bando) return;
    const timer = setInterval(() => {
      void window
        .bando!.load()
        .then((next) => setState((old) => (old && next.revision !== old.revision ? next : old)))
        .catch(() => {});
    }, 4000);
    return () => clearInterval(timer);
  }, []);
  const commitGuard = useRef(false);
  const refresh = async () => {
    setState(await window.bando!.load());
  };
  const commit = async (next: State) => {
    if (commitGuard.current) throw Error("다른 변경을 저장 중입니다. 잠시 후 다시 시도하세요.");
    commitGuard.current = true;
    setBusy(true);
    try {
      const prepared = next.orders.find(
        (o) => o.id === draft?.id && o.receptionVersion === 1 && !o.confirmedAt,
      );
      const persistent = persistedReceptionState(state!, next);
      if (JSON.stringify(persistent) === JSON.stringify(state)) {
        if (prepared) setDraft(clone(prepared));
        return;
      }
      await window.bando!.save(persistent);
      setState(await window.bando!.load());
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
    if (draft.status === "EXPORTED") throw Error("공장 전달 완료 주문은 변경할 수 없습니다.");
    const o = clone(draft),
      next = clone(state);
    o.clientSnapshot = clone(c);
    o.updatedAt = new Date().toISOString();
    o.vatAmount = totals(o, c).vat;
    const complete = !reviewIssues(o).length && totals(o, c).total !== null;
    if (mode === "notify") {
      if (!complete) throw Error("상품 / 배송 정보 / 금액을 먼저 확인하세요.");
      o.notified = true;
      o.status = "NOTIFIED";
    } else if (mode === "pay") {
      if (!o.notified || !complete) throw Error("주문 검토와 안내 완료를 먼저 처리하세요.");
      if (c.payment === "PREPAID") o.paid = true;
      else o.postpaidApproved = true;
      o.status = "APPROVED";
    } else if (mode === "wait") {
      if (!o.notified || c.payment !== "PREPAID")
        throw Error("선입금 주문의 안내 완료 후 입금 대기를 처리하세요.");
      o.status = "WAITING";
    } else if (mode === "queue") {
      const missing = canQueue(o, c, state.settings);
      if (missing.length) throw Error(missing.join("\n"));
      o.status = "QUEUED";
      next.queue = [...new Set([...next.queue, o.id])];
    } else if (!o.notified && !o.paid && !o.postpaidApproved)
      o.status = complete ? "STATEMENT" : "REVIEW";
    if (mode !== "queue" && o.status !== "QUEUED")
      next.queue = next.queue.filter((id) => id !== o.id);
    o.pricesLocked = complete;
    const i = next.orders.findIndex((x) => x.id === o.id);
    if (i < 0) next.orders.unshift(o);
    else next.orders[i] = o;
    await commit(next);
    setDraft(o);
    setNotice(mode === "queue" ? "공장 목록에 추가했습니다." : "주문을 저장했습니다.");
  };
  const open = async (o?: Order) => {
    if (o && onlyDeletedGroups(state!, o.id)) {
      setNotice("이 주문의 묶음은 삭제되었습니다. 최초 원문은 설정의 감사 기록에서 확인하세요.");
      return false;
    }
    if (dirty && !(await confirmAction("저장하지 않은 변경사항이 있습니다. 다른 주문을 열까요?")))
      return false;
    setWorkflowSelection(undefined);
    setDraft(o ? clone(o) : newReception());
    setTab("접수");
    return true;
  };
  const docking = async () => {
    if (dockBusy) return;
    setDockBusy(true);
    try {
      setDock(await window.bando!.dockCycle());
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
    const loaded = await window.bando!.load();
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
    if (
      page !== tab &&
      hasPendingChanges &&
      !(await confirmAction("저장하지 않은 입력이 있습니다. 다른 화면으로 이동할까요?"))
    )
      return;
    setTab(page);
    setQuery("");
  };
  const newOrder = async () => {
    await open();
  };
  const receive = async (entry: InboxEntry) => {
    if (dirty && !(await confirmAction("현재 입력을 수신 주문으로 바꿀까요?"))) return;
    const order = newReception();
    order.raw = entry.text;
    order.photos = entry.photo ? [entry.photo] : [];
    order.channel = "휴대폰";
    setDraft(order);
    setTab("접수");
  };
  const windowAction = async (action: "minimize" | "maximize" | "close") => {
    if (action === "close") return window.bando!.requestClose(dirty);
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
    workflowSelection,
    setWorkflowSelection,
    setRawEditDirty,
    setDraft,
    refresh,
    commit,
    saveSettings,
    dirty,
    saveOrder,
    open,
    docking,
    run,
    onWorkflowSave,
    onSelectWorkflow,
    newOrder,
    receive,
    windowAction,
    afterRestore,
  };
}
