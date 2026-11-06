import type { Order } from "./types";
export interface ReceiptDifference {
  kind: "추가" | "삭제" | "변경";
  before: string;
  after: string;
}
/** Exact bounded line comparison only. Ambiguous repeated lines deliberately produce no summary. */
export function receiptDifferences(before: string, after: string): ReceiptDifference[] | undefined {
  if (before === after) return [];
  if (before.length + after.length > 40000) return;
  const a = before.replaceAll("\r\n", "\n").split("\n"),
    b = after.replaceAll("\r\n", "\n").split("\n");
  if (a.length > 300 || b.length > 300) return;
  const clean = (xs: string[]) => xs.filter((x) => x.trim());
  for (const xs of [clean(a), clean(b)]) if (new Set(xs).size !== xs.length) return;
  if (JSON.stringify(clean(a).slice().sort()) === JSON.stringify(clean(b).slice().sort()))
    return [];
  const common = clean(a).filter((x) => b.includes(x));
  if (a.length > 1 && b.length > 1 && !common.length) return;
  const dp = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const parts: { kind: "same" | "remove" | "add"; value: string }[] = [];
  let i = 0,
    j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      parts.push({ kind: "same", value: a[i++] });
      j++;
    } else if (i < a.length && (j === b.length || dp[i + 1][j] >= dp[i][j + 1]))
      parts.push({ kind: "remove", value: a[i++] });
    else parts.push({ kind: "add", value: b[j++] });
  }
  // Unique lines appearing in both inputs were moved, not changed.
  const moved = new Set(
    parts
      .filter(
        (p) =>
          p.kind === "remove" &&
          p.value.trim() &&
          parts.some((q) => q.kind === "add" && q.value === p.value),
      )
      .map((p) => p.value),
  );
  const result: ReceiptDifference[] = [];
  let removed: string[] = [],
    added: string[] = [];
  const flush = () => {
    if (removed.length || added.length)
      result.push({
        kind: removed.length && added.length ? "변경" : removed.length ? "삭제" : "추가",
        before: removed.join("\n"),
        after: added.join("\n"),
      });
    removed = [];
    added = [];
  };
  for (const p of parts) {
    if (p.kind === "same") {
      flush();
      continue;
    }
    if (moved.has(p.value) || !p.value.trim()) continue;
    (p.kind === "remove" ? removed : added).push(p.value);
  }
  flush();
  return result;
}
export function receiptImpacts(before: Order, after: Order) {
  const result: string[] = [];
  const old = before.recipients,
    next = after.recipients;
  if (old.length !== next.length) result.push(`수취인 ${old.length}명 → ${next.length}명`);
  let product = false,
    quantity = false,
    delivery = false,
    names = false;
  for (let n = 0; n < Math.min(old.length, next.length); n++) {
    const a = old[n],
      b = next[n];
    names ||= a.name !== b.name;
    delivery ||= ["address", "mobile", "phone", "note"].some(
      (k) => a[k as keyof typeof a] !== b[k as keyof typeof b],
    );
    product ||=
      JSON.stringify(a.items.map((i) => [i.productId, i.variantId, i.name])) !==
      JSON.stringify(b.items.map((i) => [i.productId, i.variantId, i.name]));
    quantity ||=
      JSON.stringify(a.items.map((i) => i.quantity)) !==
      JSON.stringify(b.items.map((i) => i.quantity));
  }
  if (names) result.push("수취인 이름 변경");
  if (product) result.push("상품 변경");
  if (quantity) result.push("수량 변경");
  if (delivery) result.push("배송 정보 변경");
  if (product || quantity || old.length !== next.length) result.push("운임 / 금액 재확인 필요");
  return result;
}
