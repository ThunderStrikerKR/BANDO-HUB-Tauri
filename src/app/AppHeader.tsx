import type { DockStatus } from "../types";
import { navigation, type PageId } from "./navigation";
export function AppHeader({
  page,
  dock,
  busy,
  onNavigate,
  onDock,
  onWindow,
  onNotifications,
  notificationCount = 0,
}: {
  page: PageId;
  dock: DockStatus;
  busy: boolean;
  onNavigate: (page: PageId) => void;
  onDock: () => void;
  onNotifications?: () => void;
  notificationCount?: number;
  onWindow: (action: "minimize" | "maximize" | "close") => void;
}) {
  return (
    <header
      className="app-header"
      onDoubleClick={(event) => {
        if (event.target === event.currentTarget) onWindow("maximize");
      }}
    >
      <button className="wordmark hub-brand" onClick={() => onNavigate("접수")}>
        <img src="./branding/bando-symbol.svg" alt="반도 로고" />
        <span>BANDO HUB{window.bando?.isTestWorkspace ? " / 테스트" : ""}</span>
      </button>
      <nav aria-label="업무 메뉴">
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
        <button
          disabled={busy || window.bando?.isTestWorkspace}
          onClick={onDock}
          title={
            window.bando?.isTestWorkspace ? "Tauri v0.0.2에서 카카오톡 창 도킹은 아직 지원하지 않습니다." : dock.mode === "OVERLAP"
              ? "다음: 나누어 보기"
              : dock.mode === "STACK"
                ? "다음: 카카오톡 원래 위치"
                : "카카오톡을 왼쪽에 겹쳐 배치"
          }
        >
          {busy
            ? "배치 중…"
            : dock.mode === "OVERLAP"
              ? "카카오톡 / 겹쳐 보기"
              : dock.mode === "STACK"
                ? "카카오톡 / 나누어 보기"
                : "카카오톡 함께 보기"}
        </button>
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
