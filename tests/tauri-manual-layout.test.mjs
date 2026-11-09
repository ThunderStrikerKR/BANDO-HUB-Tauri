import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
const code = readFileSync(new URL("../src/orders/ManualClassification.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/styles/reception-manual.css", import.meta.url), "utf8");
test("manual classification splits shipping fields from products", () => {
  assert.match(code, /\["배송", "이름", "주소", "휴대폰", "전화", "배송 요청"\]/);
  assert.match(code, /<tr className="manual-product-section">/);
  assert.match(code, /<td colSpan=\{6\}>/);
  assert.match(code, /className="manual-product-row"/);
  assert.doesNotMatch(code, /rowSpan=\{Math\.max\(row\.items\.length/);
});
test("product actions retain behavior but use compact new layout", () => {
  assert.ok(code.indexOf('className="manual-add-product"') > code.indexOf('className="manual-product-row"'));
  assert.equal((code.match(/>\s*상품 추가\s*<\/button>/g) ?? []).length, 1);
  assert.match(code, /상품 제거/);
  assert.doesNotMatch(code, /상품 행 제외/);
  assert.match(code, /onClick=\{\(\) => addProduct\(row\.id\)\}/);
});
test("source title, instructions and header dividers match agreed UX", () => {
  assert.match(code, /<h3>붙여넣은 내용<\/h3>/);
  assert.match(code, /미배정됨: \{unassignedCount\}개/);
  assert.match(code, /model\.blocks\.filter\(\(block\) => !model\.assignments\[block\.id\]\)\.length/);
  assert.doesNotMatch(code, /오른쪽 입력 칸을 선택한 후/);
  assert.match(css, /\.manual-shipment-heading th:not\(:last-child\)::after/);
  assert.match(css, /background: #505050/);
  assert.match(css, /grid-template-columns: minmax\(0, 1fr\)/);
});

test("every shipment renders its own shipping labels before its delivery data", () => {
  const repeated = code.indexOf('className="manual-shipment-heading"');
  const groups = code.indexOf('<tbody key={row.id} className="manual-shipment-group">');
  const recipient = code.indexOf('className="manual-recipient-row"');
  assert.ok(groups >= 0 && repeated > groups && recipient > repeated);
  assert.match(code, /\["배송", "이름", "주소", "휴대폰", "전화", "배송 요청"\]/);
  assert.doesNotMatch(code, /<thead>/);
});
test("compact fixed columns prioritise address and panel heading is a distinct band", () => {
  assert.match(code, /className="manual-col-address"/);
  for (const cls of ["manual-col-shipment","manual-col-name","manual-col-mobile","manual-col-phone","manual-col-note"]) {
    assert.ok(css.includes("."+cls), cls);
  }
  assert.match(css, /\.manual-sheet-heading h3 \{/);
  assert.match(css, /font-size: 15px;/);
  assert.match(css, /margin: -8px -8px 9px;/);
});
