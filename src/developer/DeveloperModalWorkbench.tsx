import { HelpTooltip } from "../ui/HelpTooltip";
import { useEffect, useMemo, useState } from "react";
import { ClientManager } from "../ClientManager";
import { FactoryReplyImport } from "../FactoryReplyImport";
import { IssueResolver } from "../IssueResolver";
import { ProductCategoryPicker } from "../ProductDetailComponents";
import { ProductManager } from "../ProductManager";
import { ProductSearchDialog } from "../ProductSearchDialog";
import { ReceiptArchive } from "../ReceiptArchive";
import { RegistrationManager } from "../RegistrationManager";
import { WorkingRawDialog } from "../WorkingRawDialog";
import { ManualClassification } from "../orders/ManualClassification";
import { RetailOrderDialog } from "../orders/RetailOrderDialog";
import type { NoticeSink } from "../shared/notices";
import type { DeveloperTestReport, State } from "../types";
import { orderIssues } from "../validation";
import { Modal } from "../ui";
import { diagnosticOrder, exampleRaw } from "./scenarios";

type Mode = "NORMAL" | "EMPTY" | "ERROR" | "BUSY" | "LONG" | "WARNING" | "SUCCESS" | "FAILURE" | "CANCEL";
type Popup = "common" | "raw" | "manual" | "resolver" | "product-search" |
  "category" | "retail" | "product" | "client" | "registration" | "reply" | "receipt";
const modes: { id: Mode; label: string }[] = [
  { id: "NORMAL", label: "기본" },
  { id: "EMPTY", label: "데이터 없음" },
  { id: "ERROR", label: "필수 입력 오류" },
  { id: "BUSY", label: "저장 중 및 버튼 잠금" },
  { id: "LONG", label: "긴 텍스트 및 스크롤" },
  { id: "WARNING", label: "위험 작업 경고" },
  { id: "SUCCESS", label: "저장 성공 안내" },
  { id: "FAILURE", label: "저장 실패 및 재시도" },
  { id: "CANCEL", label: "취소 및 미저장 입력" },
];
const popups: { id: Popup; label: string; detail: string }[] = [
  { id: "common", label: "공통 Modal 상태", detail: "실제 공통 Modal의 포커스, 스크롤, 버튼 잠금, 취소 및 오류 표시를 재현" },
  { id: "raw", label: "원문 정정", detail: "실제 WorkingRawDialog. 시험용 미완성 주문으로 정정 사유와 비교 검증" },
  { id: "manual", label: "수동 분류", detail: "실제 ManualClassification. 시험용 원문으로 이름, 주소, 상품 귀속 확인" },
  { id: "resolver", label: "상품 및 수량 확인", detail: "실제 IssueResolver. 미등록 모델의 후보 선택 단계 검사" },
  { id: "product-search", label: "상품 검색", detail: "실제 ProductSearchDialog. 상품 목록, 검색, 선택, 긴 텍스트 상태 검사" },
  { id: "category", label: "카테고리 선택", detail: "실제 ProductCategoryPicker. 분류 탐색과 검색 검사" },
  { id: "retail", label: "소매 주문 작성", detail: "실제 RetailOrderDialog. 주문 완료를 누르면 필수값 오류를 재현" },
  { id: "product", label: "상품 관리 및 등록", detail: "실제 ProductManager 화면에서 직접 등록 또는 수정 창 열기" },
  { id: "client", label: "거래처 관리 및 등록", detail: "실제 ClientManager 화면에서 거래처 등록 버튼으로 검증 상태 확인" },
  { id: "registration", label: "상품 Excel 등록 검증", detail: "실제 RegistrationManager. 양식 선택과 업로드 결과 팝업 확인" },
  { id: "reply", label: "공장 회신 검토", detail: "실제 FactoryReplyImport. 파일을 선택하면 행 검토 팝업 표시" },
  { id: "receipt", label: "접수 감사 보관함", detail: "실제 ReceiptArchive. 시험 DB 감사 기록을 조회하는 팝업" },
];
const noProductionWrite = async (): Promise<void> => {
  throw Error("UI 검사에서는 저장을 차단합니다. 실제 테스트 저장은 별도의 TEST 업무 화면에서 진행하세요.");
};

export function DeveloperModalWorkbench({ state, raw, onNotice, onRecorded }: {
  state: State;
  raw: string;
  onNotice: NoticeSink;
  onRecorded: () => Promise<void>;
}) {
  const [popup, setPopup] = useState<Popup>("common");
  const [mode, setMode] = useState<Mode>("NORMAL");
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [recording, setRecording] = useState(false);
  const [reportError, setReportError] = useState("");

  useEffect(() => {
    if (!open || popup !== "common" || mode !== "BUSY") return;
    const timer = window.setTimeout(() => setMode("NORMAL"), 1800);
    return () => window.clearTimeout(timer);
  }, [open, popup, mode]);

  const fixtures = useMemo(() => {
    // All business dialogs operate on a temporary, detached state clone.
    // Their save callbacks are rejected, never routed to state_save.
    const working = structuredClone(state);
    const input = raw.trim() ? raw : exampleRaw("missing-contact", working);
    const manual = diagnosticOrder(working, input);
    const rawOrder = orderIssues(manual).some((issue) => issue.severity === "ACTION" &&
      ["NAME","ADDRESS","CONTACT","MODEL","QUANTITY_MISSING","ITEM","UNASSIGNED_EVIDENCE"].includes(issue.kind))
      ? manual : diagnosticOrder(working, exampleRaw("missing-contact", working));
    working.orders.push(rawOrder);
    const uncertain = diagnosticOrder(working, exampleRaw("unknown-model", working));
    const recipient = uncertain.recipients[0];
    const item = recipient?.items[0];
    return { working, raw: rawOrder, manual, uncertain, recipient, item };
  }, [state, raw]);

  const record = async (passed: boolean) => {
    if (!window.bando?.isTestWorkspace || !window.bando.testRecordRun) return;
    setRecording(true);
    setReportError("");
    try {
      const chosen = popups.find((item) => item.id === popup)!;
      const report: DeveloperTestReport = {
        scenario: "UI 검사 / " + chosen.label + " / " + (popup === "common" ? mode : "실제 화면"),
        raw: "실제 UI 수동 점검: " + chosen.detail,
        passed,
        expected: ["포커스", "필드 오류", "스크롤", "버튼 상태", "취소", "저장 안전성"],
        detected: [passed ? "검사자 정상 판정" : "검사자 문제 발견"],
        recipients: [],
        notes: ["사람이 관찰한 결과이며 자동화 시험 통과로 간주하지 않습니다.", "정식 업무 DB 저장 없음"],
      };
      await window.bando.testRecordRun(report);
      await onRecorded();
      onNotice("UI 검사 결과를 격리 테스트 DB에 기록했습니다.", "success");
    } catch (e) {
      setReportError(String(e));
    } finally {
      setRecording(false);
    }
  };

  const preview = () => {
    const close = () => setOpen(false);
    if (popup === "common") return (
      <Modal title={"UI 상태 시험 / " + modes.find((v) => v.id === mode)?.label}
        className="developer-preview-dialog" busy={mode === "BUSY"}
        draft={mode === "CANCEL" ? { text } : undefined}
        onClose={close}>
        {mode === "EMPTY" ? <p>표시할 데이터가 없습니다.</p> : <>
          {mode === "BUSY" && <p role="status">시험용 처리 중입니다. 자동으로 버튼이 활성화됩니다.</p>}
          {mode === "ERROR" && <p role="alert" className="form-error">필수 입력 항목을 확인하세요.</p>}
          {mode === "WARNING" && <p role="alert" className="warnings">시험용 위험 작업 경고입니다. 실제 데이터는 변경되지 않습니다.</p>}
          {mode === "SUCCESS" && <p role="status">저장 성공 알림을 표시하는 시험 상태입니다.</p>}
          {mode === "FAILURE" && <p role="alert" className="form-error">저장이 실패했습니다. 입력 내용은 유지되며 다시 시도할 수 있습니다.</p>}
          <label htmlFor="developer-preview-input">검증용 입력</label>
          <input id="developer-preview-input" aria-invalid={mode === "ERROR"}
            placeholder="시험 입력" value={text} onChange={(event) => setText(event.target.value)} />
          {mode === "LONG" && <p className="developer-long-text">
            {"길이가 긴 입력과 안내 문구도 모달 크기를 넘지 않고 스크롤되어야 합니다. ".repeat(180)}
          </p>}
          {mode === "CANCEL" && <p>값을 변경한 뒤 취소, X, ESC를 각각 눌러 미저장 상태 동작을 확인하세요.</p>}
        </>}
        <div className="row-end">
          <button type="button" onClick={close}>취소</button>
          <button type="button" className="primary" disabled={mode === "ERROR"}
            onClick={close}>{mode === "FAILURE" ? "재시도" : "시험 확인"}</button>
        </div>
      </Modal>
    );
    if (popup === "raw")
      return <WorkingRawDialog state={fixtures.working} order={fixtures.raw}
        onApply={noProductionWrite} onClose={close}/>;
    if (popup === "manual")
      return <ManualClassification state={fixtures.working} order={fixtures.manual}
        onNotice={onNotice} onApply={() => { onNotice("수동 분류 화면을 확인했습니다. 테스트 저장은 수행하지 않았습니다.", "success"); close(); }}
        onClose={close} />;
    if (popup === "resolver")
      return fixtures.recipient && fixtures.item
        ? <IssueResolver state={fixtures.working} order={fixtures.uncertain}
            recipient={fixtures.recipient} item={fixtures.item}
            onApply={async () => noProductionWrite()} onNotice={onNotice} onClose={close}/>
        : <p role="alert">후보 상품을 재현할 수 없습니다. 시험 기준 데이터를 확인하세요.</p>;
    if (popup === "product-search")
      return <ProductSearchDialog state={fixtures.working} onClose={close}
        onChoose={(product) => { onNotice("선택한 상품: " + product.name, "success"); close(); }}/>;
    if (popup === "category")
      return <ProductCategoryPicker categories={state.categories ?? []}
        onClose={close} onSelect={(id) => { onNotice("선택한 카테고리: " + id, "success"); close(); }}/>;
    if (popup === "retail")
      return <RetailOrderDialog state={fixtures.working} onClose={close} onSave={noProductionWrite}/>;
    // Managers show their real modal by clicking the corresponding button.
    if (popup === "client")
      return <ClientManager state={fixtures.working} onNotice={onNotice}
        onSave={noProductionWrite} onRefresh={async () => {}}/>;
    if (popup === "product")
      return <ProductManager state={fixtures.working} onNotice={onNotice}
        onSave={noProductionWrite} onRefresh={async () => {}}/>;
    if (popup === "registration")
      return <RegistrationManager state={fixtures.working} onNotice={onNotice}
        onSave={noProductionWrite} onRefresh={async () => {}}/>;
    if (popup === "reply")
      return <FactoryReplyImport previewOnly onNotice={onNotice}
        onSave={noProductionWrite} onRefresh={async () => {}}/>;
    return <ReceiptArchive/>;
  };
  const isWorkspace = ["client", "product", "registration", "reply", "receipt"].includes(popup);
  return (
    <section className="card developer-modal-workbench">
      <h2 className="settings-help-heading">실제 업무 팝업 및 UI 상태 검사 <HelpTooltip title="팝업 화면 검사" purpose="주문이나 거래처 관리에 사용하는 팝업창이 올바르게 열리고 버튼과 오류 표시가 정상인지 시험합니다." when="팝업의 레이아웃, 입력 오류 또는 버튼 동작을 확인할 때 사용합니다." steps={["검사할 업무 화면과 상태를 선택합니다.", "선택한 실제 화면 열기를 누릅니다.", "입력창과 안내 메시지, 버튼 상태를 확인합니다.", "정상이면 정상으로 기록, 문제가 있으면 문제 발견 기록을 누릅니다."]} result="확인한 팝업 상태를 시험 기록으로 남길 수 있습니다." caution="미리보기에서는 실제 업무 저장을 차단합니다. 실제 저장 흐름은 TEST 프로그램에서 따로 확인합니다." /></h2>

      <div className="developer-lab-field">
        <label htmlFor="dev-popup">검사 대상</label>
        <select id="dev-popup" value={popup}
          onChange={(event) => { setOpen(false); setPopup(event.target.value as Popup); }}>
          {popups.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
        </select>
        <small>{popups.find((item) => item.id === popup)?.detail}</small>
      </div>
      {popup === "common" && <div className="developer-lab-field">
        <label htmlFor="dev-popup-state">공통 Modal 상태</label>
        <select id="dev-popup-state" value={mode}
          onChange={(event) => { setOpen(false); setMode(event.target.value as Mode); }}>
          {modes.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
        </select>
      </div>}
      {popup !== "common" && <p className="muted">
        실제 업무 팝업의 오류 및 버튼 잠금은 각 화면의 입력, 검토 및 승인 단계를 통해 확인하세요.
        업무 저장을 포함한 통합시험은 TEST 앱의 원래 메뉴에서 별도로 실행합니다.
      </p>}
      <div className="actions">
        <button type="button" onClick={() => { setText(""); setOpen((prev) => !prev); }}>
          {open ? "시험 화면 닫기" : "선택한 실제 화면 열기"}
        </button>
        <button type="button" disabled={!open || recording} onClick={() => void record(true)}>정상으로 기록</button>
        <button type="button" disabled={!open || recording} onClick={() => void record(false)}>문제 발견 기록</button>
      </div>
      {reportError && <p className="form-error" role="alert">{reportError}</p>}
      {open && isWorkspace
        ? <div className="developer-live-container">{preview()}</div>
        : open && preview()}
      <p className="muted">
        공장 발송 확인, 운송장 정정 등 실제 배송 스냅샷이 필요한 팝업은
        격리 TEST 앱의 접수 / 주문내역 / Excel 관리 화면에서 시험 주문을 만든 뒤 열어야 합니다.
        샘플 데이터로 배송 사실을 임의로 확정하지 않습니다.
      </p>
    </section>
  );
}
