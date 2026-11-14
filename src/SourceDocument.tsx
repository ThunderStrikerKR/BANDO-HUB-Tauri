import { flushSync } from "react-dom";
import { HelpTooltip } from "./ui/HelpTooltip";
import { newRetailOrder } from "./orders/retail";
import { RetailOrderDialog } from "./orders/RetailOrderDialog";
import { OcrReviewDialog } from "./OcrReviewDialog";
import { Modal } from "./ui";
import { useEffect, useRef, useState } from "react";
import { ClientChooser } from "./ClientChooser";
import { KakaoClients } from "./KakaoClients";
import { LinkedText } from "./LinkedText";
import { ClientPicker, TierBadge } from "./ManagementUI";
import { confirmAction } from "./dialogs";
import { replaceReception } from "./orders/reception";
import type { NoticeSink } from "./shared/notices";
import { nativeRememberedTitleClient } from "./native-title-clients";
import type { Client, DockWindow, OcrCapture, Order, State } from "./types";

export function SourceDocument({
  state,
  order,
  text,
  client,
  onText,
  onOrder,
  onDealer,
  onSaveState,
  onNotice,
  onManual,
  onSettings,
}: {
  state: State;
  order: Order;
  text: string;
  client?: Client;
  onText: (text: string) => void;
  onOrder: (order: Order) => void;
  onDealer: (client: Client) => Promise<void> | void;
  onSave: (state: State) => Promise<void>;
  onSaveState: (state: State) => Promise<void>;
  onNotice: NoticeSink;
  onManual?: () => void;
  onSettings?: () => void;
}) {
  const [retail, setRetail] = useState(false);
  const [ocrResult, setOcrResult] = useState<OcrCapture | null>(null);
  const [ocrBusy, setOcrBusy] = useState(false);
  const [retailDraft, setRetailDraft] = useState(newRetailOrder);
  const settingsLink = useRef(onSettings);
  settingsLink.current = onSettings;
  const [dealer, setDealer] = useState(false),
    [busy, setBusy] = useState(false);
  const pending = useRef(false),
    alive = useRef(true);
  const [windows, setWindows] = useState<DockWindow[]>([]);
  const [error, setError] = useState("");
  const [ocrFailure, setOcrFailure] = useState("");
  const [showOcrFailure, setShowOcrFailure] = useState(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (!text) {
      setWindows([]);
      setError("");
    }
  }, [text]);
  const formal = !!order.confirmedAt || state.orders.some((o) => o.id === order.id);
  const autoAttempt = useRef("");
  const autoInput = useRef({ state, windows, text, orderId: order.id, dealerId: order.clientId });
  autoInput.current = { state, windows, text, orderId: order.id, dealerId: order.clientId };
  useEffect(() => {
    if (!text.trim() || client || order.clientId || formal || busy) return;
    let active = true;
    void nativeRememberedTitleClient(state, windows)
      .then(async (id) => {
        if (!active || !alive.current ||
            autoInput.current.state !== state || autoInput.current.windows !== windows ||
            autoInput.current.text !== text || autoInput.current.orderId !== order.id ||
            autoInput.current.dealerId !== order.clientId) return;
        const matched = state.clients.find((c) => c.id === id && !c.deletedAt && c.active !== false);
        if (!matched) return;
        const attempt = JSON.stringify([order.id, text, matched.id]);
        if (autoAttempt.current === attempt) return;
        autoAttempt.current = attempt;
        await onDealer(matched);
      })
      .catch((e) => {
        if (active && alive.current) setError(String(e).replace(/^Error: /, ""));
      });
    return () => { active = false; };
  }, [state, windows, text, client, order.clientId, order.id, formal, busy, onDealer]);
  useEffect(() => {
    if (!text.trim() || client || formal) return;
    let current = true;
    const timer = setInterval(
      () =>
        void window
          .bando!.dockWindows()
          .then((rows) => {
            if (current)
              setWindows((previous) =>
                JSON.stringify(previous) === JSON.stringify(rows) ? previous : rows,
              );
          })
          .catch(() => {}),
      2000,
    );
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [!!text.trim(), client?.id, formal]);
  const captureOcr = async () => {
    if (formal || pending.current) return;
    pending.current = true;
    setBusy(true);
    setOcrBusy(true);
    setError("");
    setOcrFailure("");
    try {
      if (!window.bando?.captureOcr) throw Error("이 버전에서는 OCR 화면 캡처를 사용할 수 없습니다.");
      const result = await window.bando.captureOcr();
      if (!alive.current) return;
      if (!result.text.trim()) {
        setError("선택한 화면에서 글자를 인식하지 못했습니다. 다시 범위를 지정해 주세요.");
        return;
      }
      setOcrResult(result);
    } catch (cause) {
      if (alive.current) {
        const detail = String(cause).replace(/^Error: /, "");
        setError("OCR 처리에 실패했습니다.");
        setOcrFailure(detail);
        setShowOcrFailure(true);
      }
    } finally {
      pending.current = false;
      if (alive.current) {
        setBusy(false);
        setOcrBusy(false);
      }
    }
  };
  const applyOcr = async (edited: string, mode: "replace" | "append") => {
    if (formal || pending.current || !ocrResult) return;
    const cleaned = edited.trim();
    if (!cleaned) {
      setError("OCR 결과가 비어 있습니다. 내용을 확인해 주세요.");
      return;
    }
    const raw = mode === "append" && text.trim() ? text.trimEnd() + "\n" + cleaned : cleaned;
    if (raw.length > 20000) {
      setError("발주 원문은 최대 20,000자까지 입력할 수 있습니다.");
      return;
    }
    if (mode === "replace" && text.trim() && raw !== text &&
      !(await confirmAction("기존 미확정 원문과 분석 결과를 OCR 내용으로 교체할까요?"))) return;
    if (formal) return;
    const next = replaceReception(order, raw);
    onText(raw);
    onOrder(next);
    setOcrResult(null);
    setError("");
    onNotice("검토한 OCR 문구를 발주 원문에 반영했습니다.", "success");
  };
  const paste = async (value?: string, orderType = order.orderType ?? "AGENCY") => {
    if (formal || pending.current) return;
    pending.current = true;
    setBusy(true);
    try {
      const raw = value ?? (await window.bando!.readClipboard());
      if (!raw.trim()) throw Error("클립보드에 발주 텍스트가 없습니다.");
      if (
        text &&
        raw !== text &&
        !(await confirmAction("현재 초안과 분석 결과를 새 원문으로 교체할까요?"))
      )
        return;
      const next = raw === text ? structuredClone(order) : replaceReception(order, raw);
      next.orderType = orderType;
      let chats: DockWindow[] = [];
      try {
        chats = await window.bando!.dockWindows();
      } catch {
        /* Title lookup is optional; manual selection remains available. */
      }
      if (!alive.current) return;
      setWindows(chats);
      if (!order.clientId) {
        // A failed optional title lookup must not discard a valid pasted order.
        try {
          const id = await nativeRememberedTitleClient(state, chats);
          if (!alive.current) return;
          const matched = state.clients.find((c) => c.id === id && !c.deletedAt && c.active !== false);
          if (matched) {
            next.clientId = matched.id;
            next.clientSnapshot = structuredClone(matched);
          }
        } catch (error) {
          onNotice("카카오톡 거래처 자동 연결을 확인하지 못했습니다. 거래처를 직접 선택해 주세요.", "error");
        }
      }
      setError("");
      onText(raw);
      onOrder(next);
    } catch (error) {
      setError(String(error).replace(/^Error: /, ""));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  return (
    <section className={"desk-pane source-pane" + (text ? " received-source" : "")}>
      {retail && (
        <RetailOrderDialog
          state={state}
          initialOrder={retailDraft}
          onDraft={setRetailDraft}
          onSave={onSaveState}
          onClose={() => {
            setRetail(false);
            setRetailDraft(newRetailOrder());
          }}
          onSettings={
            onSettings
              ? () => {
                  flushSync(() => setRetail(false));
                  settingsLink.current?.();
                }
              : undefined
          }
        />
      )}
      <header className="pane-heading source-heading">
        <h2 className="source-help-heading">발주 원문 <HelpTooltip title="발주서 접수" purpose="거래처에서 받은 주문 내용을 입력하고, 주문할 상품과 받는 사람 정보를 확인합니다." when="카카오톡이나 문자, 메일, 팩스 등으로 주문이 들어왔을 때 사용합니다." steps={["대리발송이나 대리점 납품 등 주문에 맞는 입력 방식을 선택합니다.", "주문 내용을 붙여넣거나 캡처 범위 지정을 눌러 화면 글자를 인식합니다.", "거래처를 확인하고 수취인과 상품 내용을 검토합니다.", "확인이 필요한 항목을 수정한 뒤 주문을 진행합니다."]} result="주문 원문을 바탕으로 상품과 수취인 정보를 확인할 수 있습니다." caution="화면에서 글자를 인식하더라도 잘못 읽은 내용은 직원이 직접 확인해야 합니다." /></h2>
        {!formal && (
          <div className="source-heading-actions" aria-label="발주 입력 방식">
            <button disabled={busy} onClick={() => void paste(undefined, "AGENCY")}>
              대리발송
            </button>
            <button disabled={busy} onClick={() => void paste(undefined, "DEALER")}>
              대리점 납품
            </button>
            <button disabled={busy} onClick={() => setRetail(true)}>
              직접 입력
            </button>
            <button disabled={busy} onClick={() => void captureOcr()}>
              캡처 범위 지정
            </button>
          </div>
        )}
      </header>
      <div className="source-top" aria-label="현재 거래처 영역">
        {!!text &&
          (client ? (
            <div className="receipt-client">
              <small>현재 거래처</small>
              <b title={client.name}>{client.name}</b>
              <TierBadge client={client} />
              <button disabled={busy} onClick={() => setDealer(true)}>
                변경
              </button>
            </div>
          ) : (
            <div className="source-client-actions">
              <button disabled={busy} onClick={() => setDealer(true)}>
                거래처 찾기
              </button>
              {!formal && !busy && (
                <ClientPicker
                  compact
                  clients={state.clients.filter((c) => c.active !== false)}
                  raw={text}
                  onSelect={(c) =>
                    void Promise.resolve()
                      .then(() => onDealer(c))
                      .catch((e) => setError(String(e)))
                  }
                />
              )}
              {!formal && (
                <KakaoClients
                  state={state}
                  order={order}
                  windows={windows}
                  onWindows={setWindows}
                  onSelect={async (id) => {
                    const c = state.clients.find((c) => c.id === id);
                    if (c) await onDealer(c);
                  }}
                  onSave={onSaveState}
                  onNotice={onNotice}
                />
              )}
            </div>
          ))}
      </div>
      <div
        className="source-document"
        onPaste={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (!formal) void paste(event.clipboardData.getData("text/plain"));
        }}
      >
        <LinkedText
          readOnly
          label="주문 원문"
          text={order.analysisRaw ?? order.raw}
          spans={order.recipients.flatMap((r) => [
            ...(r.sources ?? []),
            ...r.items.flatMap((i) => i.sources ?? []),
          ])}
          onChange={() => {}}
        />
        {ocrBusy && (
          <div className="source-ocr-progress" role="status" aria-live="polite" aria-label="OCR 진행 상태">
            <strong>OCR 처리 중…</strong>
            <span>화면에서 캡처 범위를 지정하거나 문자 인식이 끝날 때까지 기다려 주세요.</span>
          </div>
        )}
      </div>
      {order.analysisRaw && order.analysisRaw !== order.raw && (
        <small>작업용 정정 원문 / 최초 접수 원문 보존</small>
      )}
      <div className="source-inline-status" role="status" title={error}>
        {error}
        {!!ocrFailure && (
          <button type="button" className="ocr-error-detail-button"
            onClick={() => setShowOcrFailure(true)}>
            오류 상세
          </button>
        )}
      </div>
      {!formal && (
        <div className="source-actions">
          {!!text && (
            <button
              disabled={busy}
              onClick={async () => {
                if (await confirmAction("현재 미확정 원문과 분석 결과를 비울까요?")) {
                  onText("");
                  onOrder(replaceReception(order, ""));
                }
              }}
            >
              내용 삭제
            </button>
          )}
          {!!text && (
            <span className="source-actions-right">
              <button disabled={busy || order.analysisRaw !== text || !onManual} onClick={onManual}>
                수동 분류
              </button>
              <button disabled title="추후 지원 예정">
                AI 분석
              </button>
            </span>
          )}
        </div>
      )}
      {formal && <div className="source-footer-space" aria-hidden="true" />}
      {showOcrFailure && (
        <Modal title="OCR 실행 오류" onClose={() => setShowOcrFailure(false)}>
          <p>OCR 실행 중 오류가 발생했습니다. 기존 발주 원문과 주문 데이터는 변경되지 않았습니다.</p>
          <pre className="ocr-error-detail">{ocrFailure}</pre>
          <div className="actions">
            <button type="button" onClick={() => void window.bando?.copy(ocrFailure)}>
              오류 내용 복사
            </button>
            <button type="button" onClick={() => setShowOcrFailure(false)}>닫기</button>
          </div>
        </Modal>
      )}
      {ocrResult && !formal && (
        <OcrReviewDialog
          result={ocrResult}
          onCancel={() => setOcrResult(null)}
          onApply={(edited, mode) => void applyOcr(edited, mode)}
        />
      )}
      {dealer && (
        <ClientChooser
          clients={state.clients}
          current={client}
          onSelect={onDealer}
          onClose={() => setDealer(false)}
        />
      )}
    </section>
  );
}
