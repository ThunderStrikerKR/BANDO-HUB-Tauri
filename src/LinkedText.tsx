import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { customerModel } from "./matching";
import { requestMessageSpans } from "./request-message-links";
import type { Order, SourceSpan } from "./types";
export const LinkContext = createContext<{
  active: string;
  recipientId?: string;
  setActive: (key: string) => void;
}>({ active: "", setActive: (_key: string) => {} });
export function Linked({ linkKey, children }: { linkKey: string; children: ReactNode }) {
  const c = useContext(LinkContext);
  return (
    <div
      data-link-key={linkKey}
      className={"linked-field " + (c.active === linkKey ? "linked-active" : "")}
      onMouseEnter={() => c.setActive(linkKey)}
      onMouseLeave={(e) => {
        if (!e.currentTarget.contains(document.activeElement)) c.setActive("");
      }}
      onFocusCapture={() => c.setActive(linkKey)}
      onBlurCapture={() => c.setActive("")}
    >
      {children}
    </div>
  );
}
export function messageSpans(text: string, order: Order, phase: "request" | "payment" = "payment") {
  if (phase === "request") return requestMessageSpans(text, order);
  const spans: SourceSpan[] = [];
  const add = (value: string, key: string, field: string, rid?: string) => {
    if (!value.trim()) return;
    let at = text.indexOf(value);
    while (at >= 0) {
      spans.push({
        start: at,
        end: at + value.length,
        targetId: key,
        field,
        text: value,
        recipientId: rid,
      });
      at = text.indexOf(value, at + value.length);
    }
  };
  for (const r of order.recipients) {
    for (const field of ["name", "address", "phone", "mobile"] as const)
      add(r[field], r.id, field, r.id);
    const begin = r.name ? text.indexOf(r.name) : -1,
      limit =
        begin >= 0
          ? Math.min(
              text.length,
              ...order.recipients
                .filter((x) => x.id !== r.id && x.name.trim())
                .map((x) => text.indexOf(x.name, begin + 1))
                .filter((n) => n > begin),
            )
          : text.length;
    for (const i of r.items)
      for (const name of new Set([i.name, customerModel(i.name)].filter((n) => n.trim()))) {
        let at = text.indexOf(name, Math.max(0, begin));
        while (at >= 0 && at < limit) {
          if (!/[A-Za-z0-9-]/.test(text[at + name.length] ?? "")) {
            spans.push({
              start: at,
              end: at + name.length,
              targetId: i.id,
              field: "product",
              recipientId: r.id,
              text: name,
            });
            const end = text.indexOf("\n", at),
              lineEnd = end < 0 ? text.length : end,
              q = String(i.quantity) + "개",
              where = text.indexOf(q, at + name.length);
            if (
              i.quantity !== null &&
              where >= 0 &&
              where < lineEnd &&
              !/\d/.test(text[where - 1] ?? "")
            )
              spans.push({
                start: where,
                end: where + q.length,
                targetId: i.id,
                field: "quantity",
                recipientId: r.id,
                text: q,
              });
          }
          at = text.indexOf(name, at + name.length);
        }
      }
    if (begin >= 0) {
      const at = text.indexOf("운임 : ", begin);
      if (at >= 0 && at < limit) {
        const end = text.indexOf("\n", at),
          to = end < 0 ? limit : Math.min(end, limit);
        spans.push({
          start: at,
          end: to,
          targetId: r.id,
          recipientId: r.id,
          field: "freight",
          text: text.slice(at, to),
        });
      }
    }
  }
  return spans.filter(
    (s, n, a) =>
      a.findIndex(
        (x) =>
          x.start === s.start &&
          x.end === s.end &&
          x.targetId === s.targetId &&
          x.field === s.field,
      ) === n,
  );
}

export function LinkedText({
  text,
  spans,
  label,
  onChange,
  readOnly = false,
  directEdit = false,
  editingRequested = false,
}: {
  text: string;
  spans: SourceSpan[];
  label: string;
  onChange: (s: string) => void;
  readOnly?: boolean;
  directEdit?: boolean;
  editingRequested?: boolean;
}) {
  const c = useContext(LinkContext),
    // Rust-generated request text arrives asynchronously. If the initial
    // empty placeholder opened a textarea, the later response would stay in
    // edit mode and never render hoverable linked spans until blur.
    [editing, setEditing] = useState(!text && !directEdit);
  const wrapper = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!c.active || editing) return;
    const root = wrapper.current,
      exact = Array.from(root?.querySelectorAll<HTMLElement>("[data-link-key]") ?? []).find(
        (el) => el.dataset.linkKey === c.active,
      ),
      target = exact ?? root?.querySelector(".linked-active");
    target?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [c.active, c.recipientId, editing]);
  const input = useRef<HTMLTextAreaElement>(null),
    pendingCaret = useRef<number | null>(null),
    scroll = useRef(0);
  useLayoutEffect(() => {
    if (editing && pendingCaret.current !== null && input.current) {
      input.current.focus();
      input.current.setSelectionRange(pendingCaret.current, pendingCaret.current);
      input.current.scrollTop = scroll.current;
      pendingCaret.current = null;
    }
  }, [editing]);
  useEffect(() => {
    if (readOnly) setEditing(false);
  }, [readOnly]);
  useEffect(() => {
    if (editingRequested && !readOnly) {
      pendingCaret.current = text.length;
      setEditing(true);
    }
  }, [editingRequested, readOnly]);
  let cursor = 0;
  const content: ReactNode[] = [];
  for (const [index, s] of [...spans]
    .sort((a, b) => a.start - b.start || b.end - a.end)
    .entries()) {
    if (s.start < cursor || s.start < 0 || s.end > text.length) continue;
    content.push(text.slice(cursor, s.start));
    const key = s.targetId + ":" + s.field;
    content.push(
      <span
        key={index}
        tabIndex={0}
        data-link-key={key}
        className={
          "linked-token " +
          (c.active === key || (s.recipientId && s.recipientId === c.recipientId)
            ? "linked-active"
            : "")
        }
        onMouseEnter={() => c.setActive(key)}
        onMouseLeave={(e) => {
          if (document.activeElement !== e.currentTarget) c.setActive("");
        }}
        onFocus={() => c.setActive(key)}
        onBlur={() => c.setActive("")}
      >
        {text.slice(s.start, s.end)}
      </span>,
    );
    cursor = s.end;
  }
  content.push(text.slice(cursor));
  return (
    <div ref={wrapper} className={"linked-text-editor" + (directEdit ? " direct-edit" : "")}>
      <div className="text-edit-tools">
        {!readOnly && (directEdit ? editing : true) && (
          <button
            className="text-button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              if (!editing) pendingCaret.current = 0;
              setEditing(!editing);
            }}
          >
            {editing ? "강조 보기" : "원문" === label ? "원문 편집" : "내용 편집"}
          </button>
        )}
      </div>
      {editing ? (
        <textarea
          ref={input}
          aria-label={label}
          readOnly={readOnly}
          value={text}
          onBlur={(e) => {
            scroll.current = e.currentTarget.scrollTop;
            setEditing(false);
          }}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <div
          role="textbox"
          aria-label={label}
          aria-readonly={readOnly}
          tabIndex={0}
          className="linked-text-view"
          onPointerDown={(e) => {
            if (!directEdit || readOnly || e.button !== 0) return;
            const view = e.currentTarget;
            const doc = document as Document & {
              caretRangeFromPoint?: (x: number, y: number) => Range | null;
            };
            const caret = doc.caretRangeFromPoint?.(e.clientX, e.clientY);
            let at = text.length;
            if (caret && view.contains(caret.startContainer)) {
              const prefix = document.createRange();
              prefix.selectNodeContents(view);
              prefix.setEnd(caret.startContainer, caret.startOffset);
              at = prefix.toString().length;
            }
            scroll.current = view.scrollTop;
            pendingCaret.current = at;
            e.preventDefault();
            setEditing(true);
          }}
          onFocus={(e) => {
            if (directEdit && !readOnly && e.target === e.currentTarget) {
              pendingCaret.current = 0;
              setEditing(true);
            }
          }}
          onDoubleClick={() => {
            if (!readOnly) setEditing(true);
          }}
        >
          {content || "내용을 입력하세요."}
        </div>
      )}
    </div>
  );
}
