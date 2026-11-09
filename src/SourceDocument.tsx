import { flushSync } from "react-dom";
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
import { rememberedTitleClient } from "./title-clients";
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
  useEffect(() => {
    if (!text.trim() || client || order.clientId || formal || busy) return;
    const id = rememberedTitleClient(state, windows),
      matched = state.clients.find((c) => c.id === id);
    if (!matched) return;
    const attempt = JSON.stringify([order.id, text, matched.id]);
    if (autoAttempt.current === attempt) return;
    autoAttempt.current = attempt;
    void Promise.resolve()
      .then(() => onDealer(matched))
      .catch((e) => {
        if (alive.current) setError(String(e).replace(/^Error: /, ""));
      });
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
      if (alive.current) setBusy(false);
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
        const id = rememberedTitleClient(state, chats),
          matched = state.clients.find((c) => c.id === id);
        if (matched) {
          next.clientId = matched.id;
          next.clientSnapshot = structuredClone(matched);
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
        <h2>발주 원문</h2>
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
              {busy ? "처리 중…" : "캡처 범위 지정"}
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
      {formal && (
        <small className="source-protection">
          확정 원문 / 주문 변경은 수취인 / 상품 정보에서 처리하세요.
        </small>
      )}
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
