import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
const load = (path) => readFileSync(new URL("../" + path, import.meta.url), "utf8");
const desk = load("src/OrderDesk.tsx");
const staff = load("src/StaffChecks.tsx");
const guard = load("src/working-raw.ts");
const css = load("src/styles/patch-v0808.css");

test("raw correction is not inserted as an unrequested action in order review", () => {
  assert.doesNotMatch(desk, /WorkingRawDialog|rawCorrectionAllowed|onCorrectRaw|setCorrecting/);
  assert.doesNotMatch(staff, /원문 정정|onCorrectRaw|rawCorrectableIssue/);
  assert.match(desk, /<StaffChecks\s+blocks=\{staffBlocks\}/);
  assert.match(guard, /orderIssues\(o\)\.some\([\s\S]*?rawCorrectableIssue\(i.kind\)/);
});
test("recipient form remains compact without collapsing its whole panel", () => {
  assert.match(css, /grid-template-rows: minmax\(0, 28%\) 210px minmax\(0, 1fr\)/);
  assert.match(css, /\.review-layout > \.recipient-body \.recipient-fields\s*\{[\s\S]*?padding-bottom: 0;[\s\S]*?margin-bottom: 0;[\s\S]*?border-bottom: 0;/);
  assert.match(css, /\.review-layout > \.recipient-body > \.receipt-panel-content\s*\{[\s\S]*?padding: 6px 10px 4px;/);
  assert.match(css, /\.review-layout > \.recipient-body \.recipient-review\s*\{[\s\S]*?padding: 0;[\s\S]*?margin: 0;/);
});

test("issue descriptions and informational messages are static; explicit buttons handle navigation", () => {
  assert.match(staff, /<div className="issue-heading">/);
  assert.doesNotMatch(staff, /<button className="issue-heading"/);
  assert.match(staff, /<div className="staff-fact-message">/);
  assert.doesNotMatch(staff, /클릭해 정정/);
  assert.match(staff, /<button onClick=\{\(\) => onSelect\(b\)\}>입력 위치로 이동<\/button>/);
  // A semantic button may also specify type="button" without changing the action.
  assert.match(staff, /<button(?: type="button")? onClick=\{\(\) => onSelect\(b\)\}>수량 수정<\/button>/);
});
