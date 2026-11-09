import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
const read = (path) => readFileSync(new URL("../" + path, import.meta.url), "utf8");
const board = read("src/WorkflowBoard.tsx");
const css = read("src/styles/patch-v0808.css");
const source = read("src/SourceDocument.tsx");
const sourceCss = read("src/styles/receipt-document.css");
const main = read("src/main.tsx");
const history = read("src/shared/disable-input-history.ts");
const manager = read("src/ClientManager.tsx");

test("workflow summary is a compact pair of lines with normalized tax status", () => {
  const block = board.slice(board.indexOf('className="flow-fixed-summary"'), board.indexOf('{(g.needsNotice'));
  assert.equal((block.match(/className="flow-summary-line"/g) || []).length, 2);
  assert.ok(block.indexOf("배송 {ss.length}건") < block.indexOf("총 운임"));
  assert.ok(block.indexOf("총 운임") < block.indexOf("입금 예정"));
  for (const label of ["부가세 포함", "부가세 별도", "부가세 포함/별도"]) assert.ok(block.includes(label));
  assert.doesNotMatch(block, /부가세 적용|부가세 미추가/);
  assert.match(css, /\.flow-fixed-summary \.flow-summary-line\s*\{[^}]*justify-content: space-between;/);
});
test("source text remains visually bounded before focus, without unnecessary notice", () => {
  assert.doesNotMatch(source, /확정 원문 \/ 주문 변경은/);
  assert.match(sourceCss, /\.source-pane \.source-document\s*\{[^}]*border: 1px solid #555;/);
});
test("input history suggestions are disabled for future modal input fields too", () => {
  assert.match(main, /disableInputHistorySuggestions\(document\.body\)/);
  assert.match(history, /MutationObserver/);
  assert.match(history, /setAttribute\("autocomplete", "off"\)/);
  assert.match(history, /observer\.observe\(root, \{ childList: true, subtree: true \}\)/);
  assert.match(manager, /<Field label="검색 식별자">/); // Preserve stored lookup field for now.
  assert.match(manager, /<Field label="거래처 별칭 \(선택\)">/);
});
