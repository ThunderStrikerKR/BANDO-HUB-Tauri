import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const source = (name) => readFileSync(new URL("../" + name, import.meta.url), "utf8");
const component = source("src/OrderDesk.tsx");
const style = source("src/styles/patch-v0808.css");

test("recipient section keeps its own space before parsing, with internal scrolling", () => {
  assert.match(style, /grid-template-rows: minmax\(0, 28%\) 210px minmax\(0, 1fr\)/);
  assert.match(style, /\.review-layout > \.recipient-body > \.receipt-panel-content\s*\{\s*flex: 0 1 auto;/);
  assert.match(style, /\.review-layout \.receipt-panel-content\s*\{[^}]*overflow: auto;/s);
  assert.doesNotMatch(style, /minmax\(0, 0\.32fr\)/);
});

test("dispatch selector follows add-product button with an explicit label", () => {
  const section = component.slice(component.indexOf('className="items-freight-panel"'));
  const tableIndex = section.indexOf('<table className="compact-items">');
  const buttonIndex = section.indexOf("＋ 상품 추가");
  const dispatchIndex = section.indexOf('className="dispatch-origin"');
  assert.ok(tableIndex >= 0 && buttonIndex > tableIndex && dispatchIndex > buttonIndex);
  assert.match(section, /aria-label="발송지"/);
  assert.match(section, /<span className="dispatch-origin-label">발송지:<\/span>/);
  assert.match(section, /row\.items\.forEach\(\(i\) => \(i\.origin = origin\)\)/);
  assert.match(style, /\.recipient-row-actions > \.dispatch-origin/);
  assert.match(style, /margin-left: auto/);
});
