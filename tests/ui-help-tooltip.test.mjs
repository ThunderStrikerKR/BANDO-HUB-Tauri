import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL("../" + path, import.meta.url), "utf8");

test("shared beginner help shows purpose, usage steps and results above dialogs", () => {
  const help = read("src/ui/HelpTooltip.tsx");
  const styles = read("src/styles/help-tooltip.css");
  assert.match(help, /purpose: string/);
  assert.match(help, /steps\?: string\[\]/);
  assert.match(help, /언제 사용하나요\?/);
  assert.match(help, /사용 방법/);
  assert.match(help, /사용하면 어떻게 되나요\?/);
  assert.match(help, /role="tooltip"/);
  assert.match(help, /popover="manual"/);
  assert.match(help, /help\.showPopover\(\)/);
  assert.match(help, /onFocus=/);
  assert.match(styles, /max-height: min\(70dvh, 500px\)/);
});

test("client editor separates identity, sender and trade terms with a persistent footer", () => {
  const client = read("src/ClientManager.tsx");
  const styles = read("src/styles/client-editor.css");
  for (const heading of ["거래처 식별", "발송인 정보", "거래 조건"]) {
    assert.ok(client.includes("<h3>" + heading + "</h3>"));
  }
  assert.match(client, /className="client-editor-body"/);
  assert.match(client, /className="client-editor-footer"/);
  assert.match(client, /저장하지 않은 변경사항이 있습니다/);
  assert.match(client, /state\.clients\.some\(\(c\) => c\.id === edit\.id\) \? "변경사항 저장" : "거래처 등록"/);
  assert.match(styles, /\.client-editor-body\s*\{[^}]*overflow: auto;/s);
  assert.match(styles, /\.client-editor-footer\s*\{[^}]*flex: none;/s);
});

test("product and shipping managers prioritize operations and retain critical warnings", () => {
  const product = read("src/ProductManager.tsx");
  const shipping = read("src/ShippingManager.tsx");
  const freight = read("src/ProductFreightPanel.tsx");
  assert.match(product, /excelOpen && <section className="card product-excel-panel">/);
  assert.match(product, /<Field label="상품명" help=\{\{/);
  assert.match(product, /<Field label="상품설명" help=\{\{/);
  assert.match(shipping, /className="shipping-basis-settings"/);
  assert.match(shipping, /className="shipping-savebar"/);
  assert.match(freight, /className="warnings"/);
  assert.match(freight, /미확정 운임/);
});
