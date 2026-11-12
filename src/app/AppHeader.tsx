import type { DockStatus } from "../types";
import { navigation, type PageId } from "./navigation";
export function AppHeader({
  page,
  dock,
  busy,
  onNavigate,
  onDock,
  onDockMode,
  onDockStop,
  onWindow,
  onNotifications,
  notificationCount = 0,
}: {
  page: PageId;
  dock: DockStatus;
  busy: boolean;
  onNavigate: (page: PageId) => void;
  onDock: () => void;
  onDockMode: (mode: "OVERLAP" | "STACK") => void;
  onDockStop: () => void;
  onNotifications?: () => void;
  notificationCount?: number;
  onWindow: (action: "minimize" | "maximize" | "close") => void;
}) {
  return (
    <header
      data-tauri-drag-region
      className="app-header"
      onDoubleClick={(event) => {
        if (event.target === event.currentTarget) onWindow("maximize");
      }}
    >
      <button className="wordmark hub-brand" onClick={() => onNavigate("접수")}>
        <img src="./branding/bando-symbol.svg" alt="반도 로고" />
        <span>BANDO HUB{window.bando?.isTestWorkspace ? " / 테스트" : ""}</span>
      </button>
      <nav data-tauri-drag-region aria-label="업무 메뉴">
        {navigation.map((item) => (
          <button
            className={page === item.id ? "current" : ""}
            aria-current={page === item.id ? "page" : undefined}
            key={item.id}
            onClick={() => onNavigate(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>
      <div className="header-actions">
        {onNotifications && (
          <button onClick={onNotifications}>
            회신 알림{notificationCount ? ` (${notificationCount})` : ""}
          </button>
        )}
        {!dock.active ? (
          <button disabled={busy} onClick={onDock} title="카카오톡 기본창과 대화창 연결">
            {busy ? "연결 중…" : "카카오톡 함께 보기"}
          </button>
        ) : (
          <div className="kakao-view-modes" role="group" aria-label="카카오톡 보기 방식">
            <button disabled={busy} aria-pressed={dock.mode === "OVERLAP"}
              className={dock.mode === "OVERLAP" ? "current" : undefined}
              onClick={() => onDockMode("OVERLAP")}>겹쳐 보기</button>
            <button disabled={busy} aria-pressed={dock.mode === "STACK"}
              className={dock.mode === "STACK" ? "current" : undefined}
              onClick={() => onDockMode("STACK")}>나누어 보기</button>
            <button disabled={busy} onClick={onDockStop}
              title="카카오톡 연결 해제 및 모든 창 원래 위치 복원"
              aria-label="카카오톡 연결 해제">연결 해제</button>
          </div>
        )}
      </div>
      <div className="window-controls">
        {(["minimize", "maximize", "close"] as const).map((action, index) => (
          <button
            key={action}
            aria-label={["창 최소화", "창 최대화 또는 복원", "프로그램 닫기"][index]}
            onClick={() => onWindow(action)}
          >
            {index === 0 ? (
              <svg viewBox="0 0 12 12" aria-hidden="true">
                <path d="M1 8.5h10" />
              </svg>
            ) : index === 1 ? (
              <svg viewBox="0 0 12 12" aria-hidden="true">
                <rect x="1.5" y="1.5" width="9" height="9" />
              </svg>
            ) : (
              <svg viewBox="0 0 12 12" aria-hidden="true">
                <path d="m1.5 1.5 9 9m0-9-9 9" />
              </svg>
            )}
          </button>
        ))}
      </div>
    </header>
  );
}
