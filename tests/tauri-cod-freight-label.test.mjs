import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const source=(name)=>readFileSync(new URL("../"+name,import.meta.url),"utf8");
const row=source("src/WorkflowFooter.tsx"), board=source("src/WorkflowBoard.tsx"),
  messages=source("src/hub-messages.ts"), styles=source("src/styles/patch-v0808.css");
test("freight label, amount and parenthesized freight terms appear in that order",()=>{
  const start=row.indexOf('<div className="freight-line">');
  const end=row.indexOf('className="freight-inquiry"',start);
  const part=row.slice(start,end);
  assert.ok(start>=0 && end>start);
  assert.ok(part.indexOf('className="freight-name"') < part.indexOf('className="freight-money"'));
  assert.ok(part.indexOf('className="freight-money"') < part.indexOf('className="freight-payment-code"'));
  assert.match(part, /<span aria-hidden="true">\(<\/span>[\s\S]*?<select[\s\S]*?<span aria-hidden="true">\)<\/span>/);
  assert.match(part, /<option value="010">선불<\/option>/);
  assert.match(part, /<option value="020">착불<\/option>/);
  assert.match(styles, /\.freight-amount-code\s*\{[^}]*gap: 3px;/);
});
test("carrier collect is 착불, business credit remains 후불",()=>{
  assert.match(board,/nativeShipment\?\.freightCode === "020"[\s\S]*?\? "착불"/);
  const rust=source("src-tauri/src/business_core/rules/workflow_preview.rs");
  assert.match(rust, /"freightCode": workflow::shipment_freight_code\(order, recipient\)/);
  assert.match(messages,/shipmentFreightCode\(order, r\)==="020" \? "착불"/);
  assert.match(board,/후불 출고 승인/);
  assert.doesNotMatch(row, /후불/);
});
