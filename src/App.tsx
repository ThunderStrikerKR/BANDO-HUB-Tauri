import { replyNeedsReview } from "./factory-replies";
import { FactoryNotifications } from "./FactoryNotifications";
import { lazy, Suspense, useState } from "react";
import { AppHeader } from "./app/AppHeader";
import { AppNotice } from "./app/AppNotice";
import { DailySettlement } from "./app/DailySettlement";
import { OrderHistory } from "./app/OrderHistory";
import { useAppModel } from "./app/useAppModel";
import { HubShell } from "./HubShell";
import { HubWorkspace } from "./HubWorkspace";
import { NoticeContext } from "./shared/NoticeContext";
import { EmptyState } from "./ui/PageHeading";
import { ScreenBoundary } from "./ui/ScreenBoundary";
const SettingsView = lazy(() =>
  import("./app/SettingsView").then((module) => ({
    default: module.SettingsView,
  })),
);
const ClientManager = lazy(() =>
  import("./ClientManager").then((module) => ({
    default: module.ClientManager,
  })),
);
const ProductManager = lazy(() =>
  import("./ProductManager").then((module) => ({
    default: module.ProductManager,
  })),
);
const ShippingManager = lazy(() =>
  import("./ShippingManager").then((module) => ({
    default: module.ShippingManager,
  })),
);
const WorkflowQueue = lazy(() =>
  import("./WorkflowQueue").then((module) => ({
    default: module.WorkflowQueue,
  })),
);
export function App() {
  const [notifications, setNotifications] = useState(false);
  const model = useAppModel(),
    { state, draft, tab } = model;
  if (!state || !draft)
    return (
      <main className="loading">
        <h1>반도허브</h1>
        <p>{model.notice?.message ?? "업무 화면 준비 중…"}</p>
      </main>
    );
  return (
    <NoticeContext.Provider value={model.setNotice}>
      <div className="app-v03" aria-busy={model.busy}>
        <AppHeader
          onNotifications={() => setNotifications(true)}
          notificationCount={
            state.factoryReplies?.filter((r) => replyNeedsReview(state, r)).length ?? 0
          }
          page={tab}
          dock={model.dock}
          busy={model.dockBusy}
          onNavigate={model.navigate}
          onDock={() => void model.run(model.docking)}
          onWindow={(action) => void model.run(() => model.windowAction(action))}
        />
        {notifications && (
          <FactoryNotifications
            state={state}
            onSave={model.commit}
            onRefresh={model.refresh}
            onClose={() => setNotifications(false)}
            onOpen={(id) => {
              const order = state.orders.find((o) => o.id === id);
              if (order) void model.open(order);
            }}
          />
        )}
        <AppNotice notice={model.notice} onDismiss={model.dismissNotice} />
        <HubShell
          ratios={state.settings.panelRatios ?? [20, 30, 30, 20]}
          dock={model.dock}
          busy={model.dockBusy}
          onConnect={() => void model.run(model.docking)}
          onSave={(ratios) =>
            void model.run(() =>
              model.commit({
                ...state,
                settings: { ...state.settings, panelRatios: ratios },
              }),
            )
          }
          onReset={() =>
            void model.run(() =>
              model.commit({
                ...state,
                settings: {
                  ...state.settings,
                  panelRatios: [20, 30, 30, 20],
                  receptionVerticalRatio: 0.5,
                },
              }),
            )
          }
        >
          <main
            className={
              tab === "접수"
                ? "desk-container"
                : "management-container" +
                  (["상품", "거래처"].includes(tab) ? " management-fixed" : "")
            }
          >
            <div className="hub-desk-host" hidden={tab !== "접수"}>
              <ScreenBoundary onRetry={model.refresh} onError={model.setNotice}>
                <HubWorkspace
                  onNew={() => void model.run(model.newOrder)}
                  onSettings={() => void model.navigate("설정")}
                  onRawEditDirty={model.setRawEditDirty}
                  onRememberSelection={model.setWorkflowSelection}
                  externalKakao={true}
                  onResetDock={() => {}}
                  workflowSelection={model.workflowSelection}
                  onSelectWorkflow={model.onSelectWorkflow}
                  onWorkflowSave={model.onWorkflowSave}
                  state={state}
                  draft={draft}
                  onChange={(value) =>
                    model.setDraft((previous) =>
                      previous ? (typeof value === "function" ? value(previous) : value) : previous,
                    )
                  }
                  onSave={model.saveOrder}
                  onSaveState={model.commit}
                  onNotice={model.setNotice}
                  onManageProducts={() => model.navigate("상품")}
                />
              </ScreenBoundary>
            </div>
            <Suspense fallback={<EmptyState title="화면 준비 중…" />}>
              <ScreenBoundary key={tab} onRetry={model.refresh} onError={model.setNotice}>
                {tab === "상품" && (
                  <ProductManager
                    state={state}
                    onSave={model.commit}
                    onRefresh={model.refresh}
                    onNotice={model.setNotice}
                  />
                )}{" "}
                {tab === "거래처" && (
                  <ClientManager
                    state={state}
                    onSave={model.commit}
                    onRefresh={model.refresh}
                    onNotice={model.setNotice}
                  />
                )}{" "}
                {tab === "운임" && (
                  <ShippingManager state={state} onSave={model.commit} onNotice={model.setNotice} />
                )}{" "}
                {tab === "주문내역" && (
                  <OrderHistory
                    state={state}
                    query={model.query}
                    onQuery={model.setQuery}
                    date={model.historyDate}
                    onDate={model.setHistoryDate}
                    onOpen={model.open}
                    onNotice={model.setNotice}
                  />
                )}{" "}
                {tab === "결산" && (
                  <DailySettlement date={model.settlementDate} onDate={model.setSettlementDate} />
                )}{" "}
                {tab === "공장목록" && (
                  <WorkflowQueue
                    onSettings={() => void model.navigate("설정")}
                    state={state}
                    onSave={model.commit}
                    onRefresh={model.refresh}
                    onOpen={(id) => {
                      const order = state.orders.find((order) => order.id === id);
                      if (order) void model.open(order);
                    }}
                    onNotice={model.setNotice}
                  />
                )}{" "}
                {tab === "설정" && (
                  <SettingsView
                    state={state}
                    onSaveSettings={model.saveSettings}
                    onNotice={model.setNotice}
                    onRestored={model.afterRestore}
                    onReceive={model.receive}
                  />
                )}
              </ScreenBoundary>
            </Suspense>
          </main>
        </HubShell>
      </div>
    </NoticeContext.Provider>
  );
}
