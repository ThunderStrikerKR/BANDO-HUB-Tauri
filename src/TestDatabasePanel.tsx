import { useEffect, useState } from "react";
import { confirmAction } from "./dialogs";
import type { Api, State } from "./types";
export function TestDatabasePanel({ state, onReset }: { state: State; onReset: () => Promise<void> }) {
  const [preview, setPreview] =
      useState<Awaited<ReturnType<NonNullable<Api["testDatabasePreview"]>>>>(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    void window.bando
      ?.testDatabasePreview?.()
      .then(setPreview)
      .catch((e) => setError(String(e)));
  }, []);
  if (!preview?.enabled)
    return (
      <details className="card">
        <summary>개발자 모드</summary>
        <p>상품, 가격, 운임, 설정을 복사한 별도 SQLite와 Excel 보관함으로 테스트 앱을 실행합니다.
          실제 거래처, 주문, 입금 및 감사 이력은 복사하지 않습니다.</p>
        <p className="muted">별도 창의 TEST 표시로 정식 업무 환경과 구분합니다.</p>
        <button
          disabled={busy || !window.bando?.openTestWorkspace}
          onClick={async () => {
            setBusy(true);
            setError("");
            try {
              await window.bando!.openTestWorkspace!();
            } catch (e) {
              setError(String(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          격리 테스트 작업공간 열기
        </button>
        {error && <p className="form-error">{error}</p>}
      </details>
    );
  const scope = `시험 주문 ${preview.orders}건 / 배송 ${preview.shipments}건 / 거래처 ${preview.clients}개 / 입금 ${preview.payments}건 / 공장 회신 ${preview.replies}건 / Excel 작성 이력 ${preview.exports}건`;
  return (
    <section className="card">
      <h2>개발자 모드 / 테스트 기록 관리</h2>
      <p>현재 테스트 데이터: {scope}. 기준 상품 {state.products.length}개는 유지합니다.</p>
      <p className="muted">
        시험 주문, 거래처, 별칭, 송장, 회신, 입금, 감사 기록 및 발주서 시험 이력을 초기화합니다.
        상품, 가격, 운임, 설정 및 이미 작성한 Excel 파일은 유지하고 DB를 먼저 백업합니다.
      </p>
      <button
        className="danger"
        disabled={busy}
        onClick={async () => {
          if (
            !(await confirmAction(
              `격리 테스트 기록을 초기화할까요? ${scope}. 복구 백업을 먼저 만듭니다.`,
            ))
          )
            return;
          setBusy(true);
          setError("");
          try {
            const result = await window.bando!.resetTestDatabase!(preview.revision);
            await onReset();
            window.alert("테스트 DB를 초기화하고 백업했습니다: " + result.backup);
          } catch (e) {
            setError(String(e));
          } finally {
            setBusy(false);
            await window.bando
              ?.testDatabasePreview?.()
              .then(setPreview)
              .catch(() => {});
          }
        }}
      >
        백업 후 테스트 데이터 초기화
      </button>
      <p className="form-error">{error}</p>
    </section>
  );
}
