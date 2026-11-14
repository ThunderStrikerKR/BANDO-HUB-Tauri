/** Hover-only UI projection of editable inquiry text onto the matching
 * recipient fields. This does not decide staff issues, change messages,
 * persist data or call TypeScript business rules. Message text is owned by
 * the Rust output renderer; these spans are visual affordances only.
 *
 * Do not guess a recipient when several equally named/anonymous recipients
 * appear in a request: an incorrect highlight is worse than no highlight.
 */
import { customerModel } from "./matching";
import type { Order, Recipient, SourceSpan } from "./types";

function recipientForSegment(
  segment: string, recipients: Recipient[],
): Recipient | undefined {
  const named = recipients.filter((r) =>
    !!r.name.trim() && segment.includes(r.name.trim()));
  if (named.length === 1) return named[0];
  if (named.length > 1) return undefined;
  if (recipients.length === 1) return recipients[0];

  // A missing-name message is rendered with the generic "수취인" label.
  // Only select it when there is exactly one unnamed recipient.
  const unnamed = recipients.filter((r) => !r.name.trim());
  if (segment.includes("수취인") && unnamed.length === 1) return unnamed[0];

  // A custom per-product question may omit recipient names entirely.
  const byProduct = recipients.filter((r) =>
    r.items.some((i) => [i.name, customerModel(i.name)]
      .some((name) => !!name.trim() && segment.includes(name))));
  return byProduct.length === 1 ? byProduct[0] : undefined;
}

export function requestMessageSpans(text: string, order: Order): SourceSpan[] {
  const spans: SourceSpan[] = [];
  let offset = 0;
  const recipients = order.recipients;

  // Rust joins each recipient inquiry with a blank line. Keep the source
  // offsets exact, including whitespace, when matching editable drafts.
  for (const segment of text.split(/(\n\s*\n)/)) {
    const base = offset;
    offset += segment.length;
    if (!segment.trim()) continue;
    const recipient = recipientForSegment(segment, recipients);
    if (!recipient) continue;

    const add = (start: number, end: number, id: string, field: string) => {
      if (end <= start) return;
      spans.push({
        start: base + start,
        end: base + end,
        targetId: id,
        field,
        recipientId: recipient.id,
        text: segment.slice(start, end),
      });
    };
    const addPattern = (pattern: RegExp, id: string, field: string) => {
      for (const match of segment.matchAll(pattern))
        add(match.index, match.index + match[0].length, id, field);
    };

    // Existing names remain live on the recipient name field.
    if (recipient.name.trim()) {
      let at = segment.indexOf(recipient.name);
      while (at >= 0) {
        add(at, at + recipient.name.length, recipient.id, "name");
        at = segment.indexOf(recipient.name, at + recipient.name.length);
      }
    }
    // The important missing-value labels, not just the actual values,
    // must link back to their editable input fields.
    addPattern(/수취인명|받으실\s*분(?:의)?\s*성함|받는\s*분\s*성함|성함|이름/g,
      recipient.id, "name");
    addPattern(/배송지\s*주소|상세\s*주소|배송지|주소/g,
      recipient.id, "address");
    addPattern(/휴대전화\s*번호|휴대폰\s*번호|연락처|휴대전화|휴대폰|전화번호|핸드폰/g,
      recipient.id, "phone");

    // Map product-specific questions to the actual line item, avoiding
    // false mappings when a recipient has two similar/ambiguous products.
    for (const item of recipient.items) {
      const names = [...new Set([item.name, customerModel(item.name)]
        .filter((value) => !!value.trim()))].sort((a, b) => b.length - a.length);
      for (const name of names) {
        let at = segment.indexOf(name);
        while (at >= 0) {
          const before = segment[at - 1] ?? "";
          const after = segment[at + name.length] ?? "";
          if (!/[A-Za-z0-9-]/.test(before) && !/[A-Za-z0-9-]/.test(after)) {
            const tail = segment.slice(at + name.length);
            const count = tail.match(/^\s*(?:상품\s*)?(?:수량|개수)/);
            const model = tail.match(/^\s*(?:모델\s*(?:\/\s*옵션)?|옵션)/);
            if (count)
              add(at, at + name.length + count[0].length, item.id, "quantity");
            else if (model)
              add(at, at + name.length + model[0].length, item.id, "product");
            else
              add(at, at + name.length, item.id, "product");
          }
          at = segment.indexOf(name, at + name.length);
        }
      }
    }
    // A stand-alone "수량" or "모델 / 옵션" is meaningful only when
    // there is a single possible line item in that recipient's request.
    if (recipient.items.length === 1) {
      const id = recipient.items[0].id;
      addPattern(/수량|개수/g, id, "quantity");
      addPattern(/상품명|모델\s*\/\s*옵션|모델명|옵션/g, id, "product");
    }
  }

  // LinkedText already sorts by start and longest end, but canonicalize
  // exact duplicate spans here for stable focus and renderer tests.
  return spans.filter((span, index) => spans.findIndex((other) =>
    other.start === span.start && other.end === span.end &&
    other.targetId === span.targetId && other.field === span.field) === index);
}
