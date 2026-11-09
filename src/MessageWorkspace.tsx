import { useLayoutEffect, useRef, useState } from "react";
import { automaticMessage, withGreeting } from "./automatic-message";
import { validProductUrl } from "./domain";
import { groupOrder } from "./workflow";
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
    [includeLinks, setIncludeLinks] = useState(false),
    latest = useRef(order);
  latest.current = order;
  useLayoutEffect(() => {
    setStatus("");
    setIncludeLinks(false);
  }, [order.id, order.raw, gid]);
  const automatic = gid && order.orderType !== "RETAIL"
      ? automaticMessage(state, gid, includeLinks)
      : undefined,
    request = automatic?.phase !== "payment",
    baseText = automatic
      ? request
        ? (order.requestMessages?.[gid!] ?? automatic.text)
        : automatic.text
      : "",
    // Confirmation links already required by the request remain as-is.
    // The checkbox adds only other valid product links, without duplicates.
    optionalRequestLinks = includeLinks && request && gid
      ? [...new Set(groupOrder(state, gid).recipients.flatMap((recipient) =>
          recipient.items
            .filter((item) => item.url && validProductUrl(item.url) && !baseText.includes(item.url))
            .map((item) => item.name + "\n" + item.url),
        ))].join("\n\n")
      : "",
    optionalSuffix = optionalRequestLinks ? "\n\n" + optionalRequestLinks : "",
    text = baseText + optionalSuffix;
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
        <label className="message-link-toggle">
          <input
            type="checkbox"
            checked={includeLinks}
            onChange={(event) => {
              setIncludeLinks(event.target.checked);
              setStatus("");
            }}
          />
          링크 포함
        </label>
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
              // Optional links belong to the copy preview, not the editable request draft.
              const edited = optionalSuffix && value.endsWith(optionalSuffix)
                ? value.slice(0, -optionalSuffix.length)
                : value;
              onOrder({ ...order, requestMessages: { ...order.requestMessages, [gid]: edited } });
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
