import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const read = (name) => readFileSync(new URL("../" + name, import.meta.url), "utf8");
const validation = read("src/validation.ts");
const checks = read("src/StaffChecks.tsx");
const css = read("src/styles/reception-manual.css");

test("unassigned evidence warning uses plain-language title instead of ownership jargon", () => {
  assert.match(validation, /"UNASSIGNED_EVIDENCE",\s*"상품 또는 수량 정보가 연결되지 않았습니다"/);
  assert.doesNotMatch(validation, /원문 정보의 배송 건 귀속을 확인하세요/);
  assert.match(checks, /"수동 분류에서 확인"/);
  assert.doesNotMatch(checks, /"수동 분류로 귀속 확인"/);
});
test("warning shows unassigned original text and whether each candidate is product or quantity", () => {
  assert.match(validation, /recipient\.unassignedEvidence \?\? \[\]/);
  assert.match(validation, /candidate\.text \|\| candidate\.value/);
  assert.match(validation, /candidate\.kind === "quantity" \? "수량" : "상품"/);
  assert.match(validation, /kind === "UNASSIGNED_EVIDENCE" && r/);
  assert.match(validation, /unassignedEvidenceDetail\(r\)/);
  assert.match(checks, /className="unassigned-evidence-hint"/);
  assert.match(css, /\.staff-checks \.unassigned-evidence-detail/);
});
test("existing warning condition and manual classification navigation remain unchanged", () => {
  assert.match(validation, /if \(r\.unassignedEvidence\?\.length\)/);
  assert.match(validation, /r\.unassignedEvidence,\s*\)/);
  assert.match(checks, /onClick=\{\(\) => onSelect\(b\)\}/);
});
