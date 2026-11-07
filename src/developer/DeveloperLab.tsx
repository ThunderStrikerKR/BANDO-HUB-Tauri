import { useEffect, useState } from "react";
import { useAsyncTask } from "../shared/useAsyncTask";
import type { NoticeSink } from "../shared/notices";
import type { DeveloperRunHistory, DeveloperTestReport, State } from "../types";
import { Modal } from "../ui";
import { developerCases, exampleRaw, expectedOptions, inspectOrder, type CaseId } from "./scenarios";

type ModalMode = "NORMAL" | "EMPTY" | "ERROR" | "BUSY" | "LONG" | "WARNING" | "SUCCESS";
const modalModes: { id: ModalMode; label: string }[] = [
  { id: "NORMAL", label: "기본" },
  { id: "EMPTY", label: "데이터 없음" },
  { id: "ERROR", label: "필수 입력 오류" },
  { id: "BUSY", label: "저장 중 및 버튼 잠금" },
  { id: "LONG", label: "긴 텍스트 및 스크롤" },
  { id: "WARNING", label: "위험 작업 경고" },
  { id: "SUCCESS", label: "저장 성공 안내" },
];
const modalNames = [
  "발주서 원문 정정", "수동 분류", "상품 등록", "거래처 등록",
  "Excel 업로드 검증", "공장 발송 확인", "공장 회신 검토", "운송장 정보 정정",
];

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
  const [modalName, setModalName] = useState(modalNames[0]);
  const [modalMode, setModalMode] = useState<ModalMode>("NORMAL");
  const [modalOpen, setModalOpen] = useState(false);
  const [modalText, setModalText] = useState("");

  useEffect(() => {
    void window.bando?.testRunHistory?.().then(setHistory)
      .catch((error) => onNotice(String(error), "error"));
  }, [revision]);
  useEffect(() => {
    if (!modalOpen || modalMode !== "BUSY") return;
    // Test-mode-only busy preview must unlock the close button automatically.
    const timer = window.setTimeout(() => setModalMode("NORMAL"), 1800);
    return () => window.clearTimeout(timer);
  }, [modalOpen, modalMode]);

  const selectCase = (id: CaseId) => {
    setCaseId(id);
    setRaw(exampleRaw(id, state));
    setLatest(undefined);
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
  const executeAll = () => void run(async () => {
    const api = window.bando;
    if (!api?.isTestWorkspace || !api.testRecordRun || !api.testRunHistory) {
      throw Error("격리 테스트 작업공간이 아닙니다.");
    }
    const live = await api.load();
    const reports = developerCases.filter((item) => item.id !== "custom").map((item) =>
      inspectOrder(live, item.id, exampleRaw(item.id, live)));
    for (const report of reports) await api.testRecordRun(report);
    setHistory(await api.testRunHistory());
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
          <small>{developerCases.find((item) => item.id === caseId)?.detail}</small>
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
        </div>
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
      <section className="card">
        <h2>팝업 UI 상태 검사</h2>
        <p className="muted">
          앱에서 사용하는 실제 공통 Modal을 띄워 포커스, 닫기, 입력 오류,
          로딩 중 잠금, 긴 텍스트, 경고 및 안내 상태를 직접 확인합니다.
          개별 업무 팝업은 격리된 앱의 각 업무 화면에서도 실험할 수 있습니다.
        </p>
        <div className="developer-lab-field">
          <label htmlFor="dev-modal-name">팝업 유형</label>
          <select id="dev-modal-name" value={modalName}
            onChange={(event) => setModalName(event.target.value)}>
            {modalNames.map((name) => <option key={name}>{name}</option>)}
          </select>
        </div>
        <div className="developer-lab-field">
          <label htmlFor="dev-modal-mode">시험 상태</label>
          <select id="dev-modal-mode" value={modalMode}
            onChange={(event) => setModalMode(event.target.value as ModalMode)}>
            {modalModes.map((mode) => <option key={mode.id} value={mode.id}>{mode.label}</option>)}
          </select>
        </div>
        <button onClick={() => { setModalText(""); setModalOpen(true); }}>
          선택한 팝업 상태 열기
        </button>
        {modalOpen && (
          <Modal title={"UI 검사 / " + modalName} busy={modalMode === "BUSY"}
            className="developer-preview-dialog" onClose={() => setModalOpen(false)}>
            {modalMode === "EMPTY" ? <p>표시할 데이터가 없습니다.</p> : <>
              {modalMode === "BUSY" && <p role="status">저장 중입니다. 잠시 후 버튼 잠금이 해제됩니다.</p>}
              {modalMode === "ERROR" && <p role="alert" className="form-error">필수 입력 항목을 확인해 주세요.</p>}
              {modalMode === "WARNING" && <p role="alert">이 작업은 시험용 경고입니다. 실제 데이터는 변경되지 않습니다.</p>}
              {modalMode === "SUCCESS" && <p role="status">시험 작업이 정상 완료된 상태입니다.</p>}
              <label htmlFor="dev-preview-input">검증용 입력란</label>
              <input id="dev-preview-input" aria-invalid={modalMode === "ERROR"}
                placeholder="테스트 입력" value={modalText}
                onChange={(event) => setModalText(event.target.value)}/>
              {modalMode === "LONG" && <p className="developer-long-text">
                {"아주 긴 발주서 및 거래처 안내 문구가 모달 바깥으로 넘치지 않는지 검증합니다. ".repeat(60)}
              </p>}
            </>}
            <div className="row-end">
              <button type="button" onClick={() => setModalOpen(false)}>취소</button>
              <button type="button" className="primary" disabled={modalMode === "ERROR"}
                onClick={() => setModalOpen(false)}>시험 확인</button>
            </div>
          </Modal>
        )}
      </section>
    </div>
  );
}
