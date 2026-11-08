import { useState } from "react";
import { confirmAction } from "../dialogs";
import type { State } from "../types";
import {
  buildDrillMutation, comparableState, verifyDrillMutation, verifyDrillRestore,
  type DrillCheck, type DrillMutation,
} from "./backup-restore-drill";

type Archive = Awaited<ReturnType<NonNullable<typeof window.bando>["receiptArchive"]>>;
type BackupPoint = { filename: string; before: State; archive: Archive };
type Changed = { sample: DrillMutation; revision: number };
type Phase = "IDLE" | "BACKED" | "CHANGED" | "VERIFIED";

const nameOnly = (path: string) => path.split(/[\\/]/).pop() || path;

export function BackupRestoreDrill({ onRestored }: { onRestored: () => Promise<void> }) {
  const [phase, setPhase] = useState<Phase>("IDLE");
  const [baseline, setBaseline] = useState<BackupPoint>();
  const [changed, setChanged] = useState<Changed>();
  const [checks, setChecks] = useState<DrillCheck[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [backups, setBackups] = useState<string[]>([]);

  // A compromised UI cannot switch to the production DB: test-only actions
  // must be gated both here and by native workspace process isolation.
  const api = () => {
    if (!window.bando?.isTestWorkspace) {
      throw Error("이 검증은 별도 TEST 작업공간에서만 실행할 수 있습니다.");
    }
    return window.bando;
  };
  const task = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };

  const createBackup = () => void task(async () => {
    const native = api();
    const before = await native.load();
    const archive = await native.receiptArchive();
    const filename = await native.backup();
    const available = await native.backups();
    const now = await native.load();
    if (!available.includes(filename)) throw Error("생성한 백업이 실제 백업 목록에 없습니다.");
    if (before.revision !== now.revision || comparableState(before) !== comparableState(now)) {
      throw Error("백업 중 TEST DB 내용이 변경됐습니다. 새 백업을 생성하세요.");
    }
    setBackups(available);
    setBaseline({ filename, before, archive });
    setChanged(undefined);
    setChecks([]);
    setPhase("BACKED");
  });
  const makeChanges = async () => {
    if (!baseline) return;
    if (!(await confirmAction(
      "격리 TEST DB에만 가상 거래처, 별칭, 확정 주문 및 소매가 변경을 저장합니다. " +
      "실제 발송이나 Excel 출력은 수행하지 않습니다. 검증 후 백업으로 복원할까요?",
      { cancel: "취소", accept: "TEST 데이터 생성" },
    ))) return;
    void task(async () => {
      const native = api();
      const current = await native.load();
      if (current.revision !== baseline.before.revision ||
          comparableState(current) !== comparableState(baseline.before)) {
        throw Error("백업 이후 데이터가 변경됐습니다. 새 백업을 생성하세요.");
      }
      const token = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
      const sample = buildDrillMutation(current, token, new Date().toISOString());
      await native.save(sample.next); // Actual state_save and Rust reception boundary.
      const after = await native.load();
      const audit = await native.receiptArchive();
      const result = verifyDrillMutation(after, sample);
      result.push({
        label: "가상 주문 접수 감사 기록",
        passed: audit.some((entry) => entry.id === "receipt:" + sample.orderId),
        detail: "Rust 감사 기록에 TEST 가상 접수 원문 1건 저장",
      });
      setChanged({ sample, revision: after.revision ?? -1 });
      setPhase("CHANGED");
      setChecks(result);
      await onRestored(); // Show the synthetic order in the live TEST order/history views.
      if (result.some((check) => !check.passed)) {
        setError("가상 데이터 확인에 실패했습니다. 백업으로 복원하여 원래 상태를 회복하세요.");
      }
    });
  };
  const restoreAndCompare = async () => {
    if (!baseline || !changed) return;
    if (!(await confirmAction(
      "TEST 작업공간에서 " + nameOnly(baseline.filename) +
      " 백업으로 전체 DB를 복원합니다. 시험 데이터는 사라지고 복원 직전 안전 백업이 남습니다. 계속할까요?",
      { cancel: "취소", accept: "TEST DB 복원" },
    ))) return;
    void task(async () => {
      const native = api();
      const live = await native.load();
      if (live.revision !== changed.revision) {
        throw Error("검증 중 다른 작업이 TEST DB를 수정했습니다. 기존 백업을 백업 관리 화면에서 확인하세요.");
      }
      const beforeFiles = await native.backups();
      await native.restore(baseline.filename); // Real backup_restore IPC, not a simulated reset.
      const recovered = await native.load();
      const archive = await native.receiptArchive();
      const afterFiles = await native.backups();
      const result = verifyDrillRestore(
        baseline.before, recovered, baseline.archive, archive,
        changed.sample, changed.revision,
      );
      result.push({
        label: "복원 직전 안전 백업",
        passed: afterFiles.some((name) =>
          nameOnly(name).startsWith("pre-restore-") && !beforeFiles.includes(name)),
        detail: "복원 실행 전 현재 TEST DB를 별도 파일로 보관",
      });
      setBackups(afterFiles);
      setChecks(result);
      setPhase("VERIFIED");
      await onRestored(); // Reload ordinary order/history UI from restored database.
      if (result.some((check) => !check.passed)) {
        setError("복원 후 비교에서 불일치가 발견됐습니다. 결과를 확인하세요.");
      }
    });
  };

  if (!window.bando?.isTestWorkspace) return null;
  const finished = phase === "VERIFIED";
  const allPassed = checks.length > 0 && checks.every((check) => check.passed);
  return (
    <section className="card" aria-label="TEST 백업 복원 실전 검증">
      <h2>TEST 백업 및 복원 검증</h2>
      <p className="muted">
        격리된 개발자 TEST SQLite만 사용합니다. 실제 백업 생성, 상태 저장,
        복원 확인창, 복원 후 주문과 가격 및 감사 기록의 비교를 순서대로 검증합니다.
        정상 업무 DB와 실제 택배 발송에는 접근하지 않습니다.
      </p>
      <p className="muted">
        시험 중 이 화면을 떠나거나 앱을 종료하면 진행 상황은 초기화됩니다.
        생성된 TEST 백업은 유지되므로, 복원이 필요하면 아래 데이터 백업 및 복구에서 선택할 수 있습니다.
      </p>
      <div className="actions">
        <button disabled={busy} onClick={createBackup}>
          1. TEST 백업 만들기
        </button>
        <button disabled={busy || phase !== "BACKED"} onClick={() => void makeChanges()}>
          2. 가상 주문과 가격 변경
        </button>
        <button disabled={busy || phase !== "CHANGED"} onClick={() => void restoreAndCompare()}>
          3. 백업 복원 및 비교
        </button>
      </div>
      {baseline && (
        <p>검증 기준 백업: <strong>{nameOnly(baseline.filename)}</strong>
          {" / "}기준 리비전 {baseline.before.revision}
          {" / "}주문 {baseline.before.orders.length}건
          {" / "}거래처 {baseline.before.clients.length}개
          {" / "}상품 {baseline.before.products.length}개
        </p>
      )}
      {changed && (
        <p>가상 테스트: 주문 {changed.sample.orderId}
          {" / "}소매가 {changed.sample.previousPrice.toLocaleString("ko-KR")}원 →
          {" "}{changed.sample.testPrice.toLocaleString("ko-KR")}원
          {" / "}변경 리비전 {changed.revision}</p>
      )}
      {checks.length > 0 && (
        <div className="developer-history" aria-label="백업 복원 항목별 검증 결과">
          <h3>{finished
            ? (allPassed ? "복원 검증 통과" : "복원 검증 불일치")
            : (allPassed ? "가상 데이터 변경 확인" : "가상 데이터 변경 확인 필요")}</h3>
          <table>
            <thead><tr><th>검증 항목</th><th>판정</th><th>확인 내용</th></tr></thead>
            <tbody>
              {checks.map((check) => (
                <tr key={check.label}>
                  <td>{check.label}</td>
                  <td>{check.passed ? "통과" : "불일치"}</td>
                  <td>{check.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {finished && allPassed && (
        <p role="status">
          TEST DB 전체 내용 및 접수 감사 기록이 백업 시점과 일치합니다.
          일반 주문내역 화면에서도 가상 주문이 사라졌는지 확인할 수 있습니다.
        </p>
      )}
      {backups.length > 0 && (
        <details>
          <summary>실제 TEST 백업 목록 ({backups.length}개)</summary>
          <ul>{backups.slice(0, 20).map((file) =>
            <li key={file}>{nameOnly(file)}</li>)}</ul>
        </details>
      )}
      {error && <p className="form-error" role="alert">{error}</p>}
    </section>
  );
}
