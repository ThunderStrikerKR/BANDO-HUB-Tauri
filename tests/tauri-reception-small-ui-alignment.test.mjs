import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
const read=(p)=>readFileSync(new URL("../"+p,import.meta.url),"utf8");
test("source help icon overrides heading button padding and stays center-aligned",()=>{
  const css=read("src/styles/help-tooltip.css");
  assert.match(css,/\.source-help-heading \.help-tooltip-trigger/);
  assert.match(css,/padding: 0; margin: 0;/);
  assert.match(css,/align-items: center; justify-content: center/);
});
test("no-recipient instructions use the same empty-state base class as other screens",()=>{
  assert.match(read("src/OrderDesk.tsx"),/className="empty detail-empty">발주 원문을 입력하거나 배송 건을 선택하세요/);
  assert.match(read("src/styles/receipt-layout.css"),/\.receipt-panel-content > \.detail-empty/);
});
