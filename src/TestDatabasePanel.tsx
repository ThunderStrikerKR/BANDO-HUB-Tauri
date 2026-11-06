import { useEffect, useState } from "react";
import { confirmAction } from "./dialogs";
import type { Api } from "./types";
export function TestDatabasePanel({ onReset }: { onReset: () => Promise<void> }) {
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
        <p>별도 테스트 작업공간에서 시험 주문과 Excel 작성 이력을 관리합니다.</p>
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
      <p>
        초기화 범위는 {scope}입니다. 관련 원문 / 별칭 / 송장도 함께 초기화합니다. 기준
        상품 / 가격 / 운임 / 설정과 이미 작성한 Excel 파일은 보관합니다.
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
            await window.bando!.resetTestDatabase!(preview.revision);
            await onReset();
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
