import { useLayoutEffect, useRef, useState } from "react";
import { automaticMessage, withGreeting } from "./automatic-message";
import { recordCopy } from "./message-model";
import { LinkedText, messageSpans } from "./LinkedText";
import type { NoticeSink } from "./shared/notices";
import type { Order, State } from "./types";
export function MessageWorkspace({
  state,
  order,
  gid,
  onOrder,
  onSave,
}: {
  state: State;
  order: Order;
  gid?: string;
  onOrder: (o: Order) => void;
  onSave: (s: State) => Promise<void>;
  onSelect: (id: string) => void;
  onNotice: NoticeSink;
}) {
  const [busy, setBusy] = useState(false),
    [status, setStatus] = useState(""),
    latest = useRef(order);
  latest.current = order;
  useLayoutEffect(() => setStatus(""), [order.id, order.raw, gid]);
  const automatic = gid && order.orderType !== "RETAIL" ? automaticMessage(state, gid) : undefined,
    request = automatic?.phase !== "payment",
    text = automatic
      ? request
        ? (order.requestMessages?.[gid!] ?? automatic.text)
        : automatic.text
      : "";
  const disabled = busy || !text.trim() || (!request && !!automatic?.paymentIssues.length);
  const copy = async (greeting: boolean) => {
    if (disabled || !gid) return;
    setBusy(true);
    try {
      await window.bando!.copy(greeting ? withGreeting(text) : text);
      if (latest.current.id !== order.id || latest.current.raw !== order.raw) return;
      if (order.confirmedAt)
        await onSave(recordCopy(state, gid, request ? "REQUEST" : "PAYMENT", crypto.randomUUID()));
      else if (request)
        onOrder({
          ...latest.current,
          requestCopiedGroups: [...new Set([...(latest.current.requestCopiedGroups ?? []), gid])],
        });
      setStatus("복사했습니다.");
    } catch (e) {
      setStatus(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <aside className="desk-pane messages-pane">
      <header className="pane-heading">
        <h2>복사용 자동 메시지</h2>
      </header>
      <div className="stage-message-preview">
        <LinkedText
          readOnly={!request}
          directEdit={request}
          label="복사용 자동 메시지 본문"
          text={text}
          spans={messageSpans(text, order)}
          onChange={(value) => {
            if (gid && request) {
              onOrder({ ...order, requestMessages: { ...order.requestMessages, [gid]: value } });
              setStatus("");
            }
          }}
        />
      </div>
      <div className="message-inline-status" role="status">
        {status}
      </div>
      <footer className="message-copy-actions">
        <button disabled={disabled} onClick={() => void copy(false)}>
          그대로 복사
        </button>
        <button disabled={disabled} onClick={() => void copy(true)}>
          인사말 포함 복사
        </button>
      </footer>
    </aside>
  );
}
