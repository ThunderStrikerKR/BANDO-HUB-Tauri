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
  assert.match(code, /오른쪽 입력 칸을 선택한 후/);
  assert.match(code, /흰색 블록: 연결되지 않은 내용/);
  assert.match(code, /Ctrl\+Z: 이전 작업 되돌리기/);
  assert.match(css, /\.manual-delivery-table thead th:not\(:last-child\)::after/);
  assert.match(css, /background: #505050/);
  assert.match(css, /grid-template-columns: minmax\(0, 1fr\)/);
});
