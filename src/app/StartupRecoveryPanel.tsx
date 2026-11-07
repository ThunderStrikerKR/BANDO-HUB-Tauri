import type { StartupStatus } from "../types";

export function StartupRecoveryPanel({
  startup, retrying, onRetry,
}: {
  startup: StartupStatus;
  retrying: boolean;
  onRetry: () => Promise<void>;
}) {
  return (
    <main className="startup-recovery" role="alert" aria-live="assertive">
      <section className="startup-recovery-card">
        <div className="startup-recovery-overline">
          BANDO HUB v0.0.4 / {startup.isTest ? "격리 TEST" : "업무 데이터"}
        </div>
        <h1>반도허브를 시작하지 못했습니다.</h1>
        <p>
          기존 업무 데이터베이스를 정상적으로 열거나 검증하지 못했습니다.
          데이터 파일은 자동으로 삭제하거나 초기화하지 않았고,
          백업 파일도 임의로 복원하지 않았습니다.
        </p>
        <div className="startup-recovery-detail">
          <strong>확인된 오류</strong>
          <p>{startup.error || "초기화 오류의 상세 정보를 확인하지 못했습니다."}</p>
        </div>
        <p className="startup-recovery-help">
          파일이 다른 프로그램에서 사용 중이거나 저장소 접근 권한에 문제가 있다면
          원인을 해결한 뒤 다시 시도할 수 있습니다.
          데이터 손상이나 형식 오류가 계속되면 재시도를 멈추고
          보관 중인 백업을 별도로 확인해야 합니다.
        </p>
        <div className="startup-recovery-actions">
          <button type="button" disabled={retrying}
            onClick={() => void onRetry()}>
            {retrying ? "데이터베이스 다시 확인 중…" : "안전하게 다시 시도"}
          </button>
          <small>초기화 시도 {startup.attempts}회 / 자동 초기화 및 자동 복원 없음</small>
        </div>
      </section>
    </main>
  );
}
