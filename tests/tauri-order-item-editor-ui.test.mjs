import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { tsImport } from "tsx/esm/api";

const read = path => readFileSync(new URL("../" + path, import.meta.url), "utf8");
const editor = read("src/OrderItemEditor.tsx");
const styles = read("src/styles/order-item-editor.css");
const imported = read("src/styles/index.css");
const state = JSON.parse(read("src-tauri/resources/state-seed.json"));
const { resolvePrice, itemFromProduct } = await tsImport("../src/domain.ts", import.meta.url);
const priceClient = { id:"sample-customer",tier:"retail",overrides:{} };
const p709 = state.products.find(p=>p.name==="BD 709 / 블랙 / 타공 상판");

test("order item correction reuses the shared Kakao-aware modal", () => {
  assert.match(editor, /<Modal/);
  assert.match(editor, /className="order-item-editor-modal"/);
  assert.match(editor, /draft=\{draft\}/);
  assert.doesNotMatch(editor, /createPortal|ResizeObserver|hub-slot-0|showModal/);
  assert.match(styles, /\.app-modal-layer\.order-item-editor-modal/);
  assert.doesNotMatch(styles, /order-item-edit-layer|order-item-edit-dialog/);
});

test("the approved fixed size, layout tokens and collapsed inline search are retained", () => {
  assert.match(styles, /width: min\(756px,/);
  assert.match(styles, /height: min\(566px,/);
  assert.match(read("src/styles/modals.css"), /font-size: var\(--modal-title-size\)/);
  assert.match(read("src/styles/components.css"), /font-size: var\(--modal-action-size\)/);
  assert.match(styles, /\.order-item-edit-search\[hidden\][\s\S]*display: none/);
  assert.match(editor, /aria-expanded=\{searchOpen\}/);
  assert.match(editor, /setSearchOpen\(\(expanded\) => !expanded\)/);
  assert.match(editor, /searchProducts\(state, query, client\.id\)/);
  assert.match(imported, /@import "\.\/order-item-editor\.css";/);
  assert.doesNotMatch(editor, /<ProductSearchDialog/);
});

test("only four approved product fields and existing action buttons remain", () => {
  for (const text of ["상품명","카테고리","가격","상품 변경","검색 접기","삭제","닫기","적용"]) {
    assert.ok(editor.includes(text),text);
  }
  assert.match(editor, /className="order-item-edit-photo"/);
  assert.match(editor, /productImage\?\.\(current\.id\)/);
  assert.doesNotMatch(editor, /<Field label="수량"/);
  assert.doesNotMatch(editor, /<MoneyInput/);
  assert.doesNotMatch(editor, /type="number"/);
  assert.match(editor, /item\.quantity/);
  assert.match(editor, /onApply\(next\)/);
});

test("catalog names, prices, images, identity and existing quantity remain independent", () => {
  assert.equal(p709.variants.length,1);
  assert.equal(p709.variants[0].retail,59000);
  assert.equal(resolvePrice(p709,p709.variants[0].id,priceClient),59000);
  const example=itemFromProduct(p709,priceClient,p709.variants[0].color,4,p709.variants[0].id);
  assert.equal(example.quantity,4);
  assert.equal(example.unitPrice,59000);
  assert.equal(example.productId,p709.id);
  assert.match(editor, /id: item\.id/);
  assert.match(editor, /raw: item\.raw/);
  assert.match(editor, /quantity: item\.quantity/);
  assert.match(editor, /quantityConfirmed: item\.quantityConfirmed/);
  assert.match(editor, /onError=\{\(\) => setInvalidImage\(usableImage\)\}/);
  assert.match(editor, /candidate\.id === item\.productId/);
  assert.match(editor, /if \(locked \|\| !changed/);
});
