import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
const load = (path) => readFileSync(new URL("../" + path, import.meta.url), "utf8");
const desk = load("src/OrderDesk.tsx");
const staff = load("src/StaffChecks.tsx");
const guard = load("src/working-raw.ts");
const css = load("src/styles/patch-v0808.css");

test("raw correction never takes an independent review-grid row", () => {
  assert.doesNotMatch(desk, /rawCorrectionAllowed\(flowState, draft\) && \(/);
  assert.match(desk, /<StaffChecks\s+onCorrectRaw=/);
  assert.match(staff, /onCorrectRaw && rawCorrectableIssue\(b.kind\)/);
  assert.match(staff, /<button onClick=\{onCorrectRaw\}>원문 정정<\/button>/);
  assert.match(guard, /orderIssues\(o\)\.some\([\s\S]*?rawCorrectableIssue\(i.kind\)/);
});
test("recipient line and excessive whitespace are removed, extra area goes to products", () => {
  assert.match(css, /grid-template-rows: minmax\(0, 28%\) fit-content\(210px\) minmax\(0, 1fr\)/);
  assert.match(css, /\.review-layout > \.recipient-body \.recipient-fields\s*\{[\s\S]*?padding-bottom: 0;[\s\S]*?margin-bottom: 0;[\s\S]*?border-bottom: 0;/);
  assert.match(css, /\.review-layout > \.recipient-body > \.receipt-panel-content\s*\{[\s\S]*?padding: 6px 10px 4px;/);
  assert.match(css, /\.review-layout > \.recipient-body \.recipient-review\s*\{[\s\S]*?padding: 0;[\s\S]*?margin: 0;/);
});
