import { useEffect, useState } from "react";
import { BackupRestoreDrill } from "./developer/BackupRestoreDrill";
import { confirmAction } from "./dialogs";
import { HelpTooltip } from "./ui/HelpTooltip";
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
  }, [state.revision]);
  if (!preview?.enabled)
    return (
      <details className="card">
        <summary>개발자 모드</summary>
        <HelpTooltip title="개발자 모드" purpose="실제 업무 자료를 바꾸지 않고 새 기능과 오류 상황을 시험하는 별도 프로그램 창을 엽니다." when="발주서 오류, 팝업 동작 또는 새 기능을 시험할 때 사용합니다." steps={["격리 테스트 작업공간 열기를 누릅니다.", "새로 열린 TEST 표시 창에서 시험용 거래처나 주문을 만듭니다.", "검사를 마친 뒤 테스트 창을 닫습니다."]} result="상품과 가격 등의 기준은 복사하지만 실제 거래처, 주문, 입금 및 감사 기록은 복사하지 않는 시험 공간을 사용할 수 있습니다." caution="반드시 TEST 표시를 확인하고 시험 작업을 진행합니다." />
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
      <h2 className="settings-help-heading">개발자 모드 / 테스트 기록 관리 <HelpTooltip title="테스트 기록 초기화" purpose="시험하면서 만들어진 주문과 거래처, 입금 등의 기록을 정리합니다." when="이전 시험 기록을 지우고 새 시험을 시작할 때 사용합니다." steps={["화면에 표시된 테스트 기록 건수를 확인합니다.", "백업 후 테스트 데이터 초기화를 누릅니다.", "확인창에서 초기화할 내용을 확인하고 승인합니다."]} result="테스트 기록은 초기화되지만 상품, 가격, 운임과 설정은 유지됩니다." caution="초기화 전에 복구용 백업을 먼저 만듭니다. 실제 업무 데이터는 변경하지 않습니다." /></h2>
      <p>현재 테스트 데이터: {scope}. 기준 상품 {state.products.length}개는 유지합니다.</p>

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
      <BackupRestoreDrill onRestored={onReset} />
    </section>
  );
}
