import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { withGreeting } from "./automatic-message";
import { nativeAutomaticMessage, type NativeAutomaticMessage } from "./native-automatic-message";
import { nativeRecordMessageCopy } from "./native-message-audit";
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
    [resolved, setResolved] = useState<{
      fingerprint: string;
      groupId: string;
      links: boolean;
      result: NativeAutomaticMessage;
    }>(),
    [loadError, setLoadError] = useState(""),
    latest = useRef(order),
    latestState = useRef(state);
  latest.current = order;
  latestState.current = state;
  // Editing a request draft does not change its financial / workflow rules.
  // A late native response never overwrites a newer state or user input.
  const fingerprint = useMemo(() => JSON.stringify({
    ...state,
    orders: state.orders.map(({ requestMessages: _draft, ...businessOrder }) => businessOrder),
  }), [state]);
  useEffect(() => {
    if (!gid || order.orderType === "RETAIL") {
      setResolved(undefined);
      setLoadError("");
      return;
    }
    let cancelled = false;
    setLoadError("");
    void nativeAutomaticMessage(latestState.current, gid, includeLinks)
      .then((result) => {
        if (!cancelled) setResolved({ fingerprint, groupId: gid, links: includeLinks, result });
      })
      .catch((error) => {
        if (!cancelled) {
          setResolved(undefined);
          setLoadError(String(error));
        }
      });
    return () => { cancelled = true; };
  }, [fingerprint, gid, includeLinks, order.orderType]);
  useLayoutEffect(() => {
    setStatus("");
    setIncludeLinks(false);
  }, [order.id, order.raw, gid]);
  const automatic = resolved?.fingerprint === fingerprint &&
      resolved?.groupId === gid && resolved?.links === includeLinks
      ? resolved.result
      : undefined,
    request = automatic?.phase !== "payment",
    baseText = automatic
      ? request
        ? (order.requestMessages?.[gid!] ?? automatic.text)
        : automatic.text
      : "",
    // Confirmation links already required by the request remain as-is.
    // The checkbox adds only other valid product links, without duplicates.
    optionalRequestLinks = includeLinks && request && automatic
      ? automatic.validRequestLinks
          .filter((entry) => !baseText.includes(entry.slice(entry.lastIndexOf("\n") + 1)))
          .join("\n\n")
      : "",
    optionalSuffix = optionalRequestLinks ? "\n\n" + optionalRequestLinks : "",
    text = baseText + optionalSuffix;
  const disabled = busy || !automatic || !text.trim() || (!request && !!automatic.paymentIssues.length);
  const copy = async (greeting: boolean) => {
    if (disabled || !gid) return;
    setBusy(true);
    try {
      await window.bando!.copy(greeting ? withGreeting(text) : text);
      if (latest.current.id !== order.id || latest.current.raw !== order.raw) return;
      if (order.confirmedAt)
        await onSave(await nativeRecordMessageCopy(state, gid, request ? "REQUEST" : "PAYMENT", crypto.randomUUID(), automatic?.signature));
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
        {loadError || status}
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
