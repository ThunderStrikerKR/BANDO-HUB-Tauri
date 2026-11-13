import { useEffect, useLayoutEffect, useRef, useState } from "react";
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
    [rendered, setRendered] = useState<{
      source: State;
      groupId: string;
      includeLinks: boolean;
      data?: NativeAutomaticMessage;
      error?: string;
    }>(),
    latest = useRef(order);
  latest.current = order;
  useLayoutEffect(() => {
    setStatus("");
    setIncludeLinks(false);
  }, [order.id, order.raw, gid]);
  // The Rust projection supplies both the exact payment text and the
  // signature for its copy audit. Never calculate either independently in TS.
  useEffect(() => {
    if (!gid || order.orderType === "RETAIL") return;
    let current = true;
    void nativeAutomaticMessage(state, gid, includeLinks)
      .then((data) => {
        if (current) setRendered({ source: state, groupId: gid, includeLinks, data });
      })
      .catch((error) => {
        if (current) setRendered({
          source: state, groupId: gid, includeLinks,
          error: "자동 메시지 생성 실패: " + String(error),
        });
      });
    return () => { current = false; };
  }, [state, gid, order.orderType, includeLinks]);
  const currentRender = rendered?.source === state &&
      rendered.groupId === gid && rendered.includeLinks === includeLinks
      ? rendered
      : undefined;
  const automatic = currentRender?.data,
    request = automatic?.phase !== "payment",
    baseText = automatic
      ? request
        ? (order.requestMessages?.[gid!] ?? automatic.text)
        : automatic.text
      : "",
    // Rust selects valid official links. The UI only toggles and formats the
    // extra links that are not already present in the editable request draft.
    optionalRequestLinks = includeLinks && request && automatic
      ? automatic.validRequestLinks
          .filter((entry) => !baseText.includes(entry.split("\n").at(-1) ?? ""))
          .join("\n\n")
      : "",
    optionalSuffix = optionalRequestLinks ? "\n\n" + optionalRequestLinks : "",
    text = baseText + optionalSuffix;
  const disabled = busy || !automatic || !text.trim() ||
    (!request && !!automatic.paymentIssues.length);
  const copy = async (greeting: boolean) => {
    if (disabled || !gid || !automatic) return;
    setBusy(true);
    try {
      await window.bando!.copy(greeting ? withGreeting(text) : text);
      if (latest.current.id !== order.id || latest.current.raw !== order.raw) return;
      if (order.confirmedAt)
        await onSave(await nativeRecordMessageCopy(
          state, gid, request ? "REQUEST" : "PAYMENT", crypto.randomUUID(),
          request ? undefined : automatic.signature,
        ));
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
        {status || currentRender?.error || ""}
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
