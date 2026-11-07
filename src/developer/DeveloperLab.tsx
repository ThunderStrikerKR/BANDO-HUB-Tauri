import { useEffect, useState } from "react";
import { useAsyncTask } from "../shared/useAsyncTask";
import type { NoticeSink } from "../shared/notices";
import type { DeveloperRunHistory, DeveloperTestReport, State } from "../types";
import { DeveloperModalWorkbench } from "./DeveloperModalWorkbench";
import { developerCases, diagnosticOrder, exampleRaw, expectedOptions, inspectOrder, type CaseId } from "./scenarios";

export function DeveloperLab({ state, onNotice, revision }: {
  state: State;
  onNotice: NoticeSink;
  revision: number;
}) {
  const { busy, run } = useAsyncTask(onNotice);
  const [caseId, setCaseId] = useState<CaseId>("normal");
  const [raw, setRaw] = useState(() => exampleRaw("normal", state));
  const [clientId, setClientId] = useState("");
  const [expected, setExpected] = useState("NONE");
  const [latest, setLatest] = useState<DeveloperTestReport>();
  const [history, setHistory] = useState<DeveloperRunHistory[]>([]);
  const [batchResults, setBatchResults] = useState<DeveloperTestReport[]>([]);

  useEffect(() => {
    void window.bando?.testRunHistory?.().then(setHistory)
      .catch((error) => onNotice(String(error), "error"));
  }, [revision]);
  const selectCase = (id: CaseId) => {
    setCaseId(id);
    setRaw(exampleRaw(id, state));
    setLatest(undefined);
    setBatchResults([]);
  };
  const execute = () => void run(async () => {
    const api = window.bando;
    if (!api?.isTestWorkspace || !api.testRecordRun || !api.testRunHistory) {
      throw Error("발주서 검증은 격리 개발자 작업공간에서만 실행할 수 있습니다.");
    }
    const live = await api.load();
    const report = inspectOrder(live, caseId, raw, clientId, expected);
    await api.testRecordRun(report);
    setLatest(report);
    setHistory(await api.testRunHistory());
    onNotice(report.passed ? "검증 기대 조건을 충족했습니다." :
      "기대 조건과 실제 결과가 다릅니다. 세부 이슈를 확인하세요.",
      report.passed ? "success" : "error");
  });
  const inspectNativeBoundary = () => void run(async () => {
    const api = window.bando;
    if (!api?.isTestWorkspace || !api.testReceptionBoundary || !api.testRecordRun ||
      !api.testRunHistory) {
      throw Error("Rust 저장 경계 검증은 격리 테스트 작업공간에서만 실행할 수 있습니다.");
    }
    const live = await api.load();
    const candidate = diagnosticOrder(live, raw, clientId);
    // This is intentionally an unconfirmed draft; native save must block it.
    // No Tauri state_save or SQLite write is issued by this inspection.
    const result = await api.testReceptionBoundary(candidate);
    const report: DeveloperTestReport = {
      scenario: "Rust 저장 경계 / 접수 미확정 차단",
      raw, passed: !result.accepted,
      expected: ["주문 확인 완료 전 저장 거부"],
      detected: [result.accepted ? "저장 경계 통과 (오류)" : "저장 경계 차단 (정상)"],
      recipients: candidate.recipients.map((r) => ({
        name: r.name, address: r.address, contact: r.mobile || r.phone,
        items: r.items.map((i) => i.name || i.raw),
      })),
      notes: [result.reason || "검증 경계가 주문을 허용했습니다.",
        "저장하지 않는 Rust 검증 함수만 호출했습니다. DB에 주문을 생성하지 않았습니다.",
        "각 발주서 오류의 SQLite 트랜잭션 통합 시험과는 구분해야 합니다."],
    };
    await api.testRecordRun(report);
    setLatest(report);
    setHistory(await api.testRunHistory());
    onNotice(report.passed ? "Rust 저장 경계에서 미확정 주문을 차단했습니다." :
      "미확정 주문을 차단하지 못했습니다. 즉시 확인이 필요합니다.",
      report.passed ? "success" : "error");
  });
  const executeAll = () => void run(async () => {
    const api = window.bando;
    if (!api?.isTestWorkspace || !api.testRecordRun || !api.testRunHistory) {
      throw Error("격리 테스트 작업공간이 아닙니다.");
    }
    const live = await api.load();
    const reports = developerCases.filter((item) => item.batch !== false).map((item) => {
      const input = exampleRaw(item.id, live);
      try {
        return inspectOrder(live, item.id, input);
      } catch (error) {
        return {
          scenario: item.label, raw: input, passed: false,
          expected: ["시나리오 정상 실행"], detected: ["시나리오 실행 예외"],
          recipients: [], notes: [String(error)],
        } satisfies DeveloperTestReport;
      }
    });
    for (const report of reports) await api.testRecordRun(report);
    setHistory(await api.testRunHistory());
    setBatchResults(reports);
    const passed = reports.filter((entry) => entry.passed).length;
    onNotice("기본 시나리오 " + reports.length + "개 실행 / 기대 충족 " + passed +
      "개 / 확인 필요 " + (reports.length - passed) + "개",
      passed === reports.length ? "success" : "error");
  });
  return (
    <div className="developer-lab">
      <section className="card">
        <h2>발주서 오류 검증</h2>
        <p className="muted">
          실제 접수 화면과 동일한 파서 및 업무 오류 검증 함수를 사용합니다.
          결과는 테스트 DB에만 기록하며 이 화면에서 실제 주문을 확정하거나 발송하지 않습니다.
        </p>
        <div className="developer-lab-field">
          <label htmlFor="dev-case">시험 시나리오</label>
          <select id="dev-case" value={caseId}
            onChange={(event) => selectCase(event.target.value as CaseId)}>
            {developerCases.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>
          <small>{developerCases.find((item) => item.id === caseId)?.mechanism} / {developerCases.find((item) => item.id === caseId)?.detail}</small>
        </div>
        <div className="developer-lab-field">
          <label htmlFor="dev-client">시험 거래처</label>
          <select id="dev-client" value={clientId} onChange={(event) => setClientId(event.target.value)}>
            <option value="">가상 검증악기 (DB에 저장하지 않음)</option>
            {state.clients.filter((client) => !client.deletedAt).map((client) =>
              <option key={client.id} value={client.id}>{client.name}</option>)}
          </select>
        </div>
        {caseId === "custom" && (
          <div className="developer-lab-field">
            <label htmlFor="dev-expected">기대 오류</label>
            <select id="dev-expected" value={expected} onChange={(event) => setExpected(event.target.value)}>
              {expectedOptions.map((item) =>
                <option key={item.value} value={item.value}>{item.label}</option>)}
            </select>
          </div>
        )}
        <div className="developer-lab-field">
          <label htmlFor="dev-raw">발주서 원문</label>
          <textarea id="dev-raw" value={raw} rows={7} maxLength={20000}
            onChange={(event) => setRaw(event.target.value)}/>
        </div>
        <div className="actions">
          <button disabled={busy} className="primary" onClick={execute}>현재 발주서 검사</button>
          <button disabled={busy} onClick={executeAll}>기본 시나리오 전체 검사</button>
          <button disabled={busy} onClick={inspectNativeBoundary}>Rust 저장 차단 검사</button>
        </div>
        {batchResults.length > 0 && (
          <section className="developer-test-result" aria-label="일괄 발주서 검증 결과">
            <h3>기본 시나리오 전체 결과 / {batchResults.filter((result) => result.passed).length}개 통과 / {batchResults.filter((result) => !result.passed).length}개 불일치</h3>
            <p className="muted">
              구조화 검증은 파서가 자동으로 인식했다는 증거가 아닙니다.
              시험 결과가 불일치한 경우 각 원문 및 기준 데이터를 확인하세요.
            </p>
            <div className="developer-history">
              <table>
                <thead><tr><th>시나리오</th><th>방법</th><th>기대</th><th>실제</th><th>판정</th></tr></thead>
                <tbody>{batchResults.map((report) => (
                  <tr key={report.scenario}>
                    <td>{report.scenario}</td>
                    <td>{developerCases.find((item) => item.label === report.scenario)?.mechanism}</td>
                    <td>{report.expected.join(", ") || "이슈 없음"}</td>
                    <td>{report.detected.join(", ") || "이슈 없음"}</td>
                    <td>{report.passed ? "통과" : "불일치"}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          </section>
        )}
        {latest && (
          <section className="developer-test-result" aria-label="발주서 검증 결과">
            <h3>{latest.passed ? "기대 조건 충족" : "기대 조건 불일치"} / {latest.scenario}</h3>
            <p>기대: {latest.expected.join(", ") || "검토 오류 없음"}</p>
            <p>실제: {latest.detected.join(", ") || "검토 오류 없음"}</p>
            <p>인식된 수취인 {latest.recipients.length}명</p>
            {latest.recipients.map((recipient, index) =>
              <div key={index} className="developer-recipient">
                <strong>{index + 1}번 / {recipient.name || "이름 미확인"}</strong>
                <p>{recipient.address || "주소 미확인"} / {recipient.contact || "연락처 미확인"}</p>
                {recipient.items.map((item, n) => <p key={n}>{item}</p>)}
              </div>)}
            {latest.notes.map((note, index) => <p key={index}>{note}</p>)}
          </section>
        )}
        <details>
          <summary>시험 기록 조회 ({history.length}건, 최근 200건 보관)</summary>
          <div className="developer-history">
            {history.map((entry) => (
              <details key={entry.id}>
                <summary>{entry.passed ? "통과" : "불일치"} / {entry.scenario} / {entry.at}</summary>
                <p>기대: {entry.report.expected.join(", ") || "오류 없음"}</p>
                <p>실제: {entry.report.detected.join(", ") || "오류 없음"}</p>
                <pre>{entry.report.raw}</pre>
              </details>
            ))}
            {!history.length && <p className="muted">기록된 시나리오가 없습니다.</p>}
          </div>
        </details>
      </section>
      <DeveloperModalWorkbench state={state} raw={raw} onNotice={onNotice}
        onRecorded={async () => { setHistory(await window.bando!.testRunHistory!()); }}/>
    </div>
  );
}
