import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
const read = (path) => readFileSync(new URL("../" + path, import.meta.url), "utf8");

test("source footer keeps the three controls visible without the removed notice", () => {
  const source = read("src/SourceDocument.tsx");
  const workspace = read("src/HubWorkspace.tsx");
  const styles = read("src/styles/receipt-document.css");
  assert.match(source, /className="source-actions"/);
  assert.match(source, /내용 삭제/);
  assert.match(source, /수동 분류/);
  assert.match(source, /AI 분석/);
  assert.doesNotMatch(source, /확정 원문 \/ 주문 변경은 수취인/);
  assert.match(source, /formal && <div className="source-footer-space" aria-hidden="true" \/>/);
  assert.match(workspace, /gridTemplateRows: `minmax\(275px,\$\{verticalRatio\}fr\)/);
  assert.match(styles, /\.source-pane \.source-footer-space\s*\{[^}]*flex: 0 0 22px;/s);
});

test("recipient section keeps a fixed row when parsing finds no recipients", () => {
  const style = read("src/styles/patch-v0808.css");
  const desk = read("src/OrderDesk.tsx");
  assert.match(style, /\.review-layout\s*\{[^}]*grid-template-rows: minmax\(0, 28%\) 210px minmax\(0, 1fr\);/s);
  assert.doesNotMatch(style, /grid-template-rows: minmax\(0, 28%\) fit-content\(210px\)/);
  assert.match(desk, /className="recipient-body"/);
  assert.match(desk, /className="items-freight-panel"/);
  assert.match(style, /\.review-layout \.receipt-panel-content\s*\{[^}]*overflow: auto;/s);
});
