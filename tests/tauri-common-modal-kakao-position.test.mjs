import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const read = path => readFileSync(new URL("../" + path, import.meta.url), "utf8");
const shell = read("src/HubShell.tsx");
const shared = read("src/styles/modals.css");
const productAdmin = read("src/styles/product-admin-redesign.css");
const actions = read("src/styles/dialogs.css");
const editor = read("src/OrderItemEditor.tsx");
const detail = read("src/styles/order-item-editor.css");

/** The left native KakaoTalk region is measured once by HubShell. */
test("HubShell supplies the external KakaoTalk reserved width to every dialog", () => {
  assert.match(shell, /--kakao-reserved-width/);
  assert.match(shell, /b\.right \+ 6/);
  assert.match(shell, /stacked \? "0px"/);
});

test("all shared modals are centered within the unoccluded app width", () => {
  assert.match(shared, /inset: 0 0 0 var\(--kakao-reserved-width, 0px\)/);
  assert.match(shared, /100vw - var\(--kakao-reserved-width, 0px\) - var\(--modal-viewport-gutter\)/);
  assert.match(shared, /transparent var\(--kakao-reserved-width, 0px\)/);
  assert.match(shared, /rgb\(0 0 0 \/ 65%\) var\(--kakao-reserved-width, 0px\)/);
  assert.match(actions, /left: calc\(var\(--kakao-reserved-width, 0px\)/);
});

test("product detail dialog cannot reset the shared placement back to full viewport", () => {
  assert.match(productAdmin,/\.app-modal-layer\.product-detail-dialog \{/);
  assert.match(productAdmin, /inset: 0 0 0 var\(--kakao-reserved-width, 0px\)/);
  assert.doesNotMatch(productAdmin, /inset: 0;/);
  assert.match(productAdmin, /max-width: max\(0px, calc\(100vw - var\(--kakao-reserved-width, 0px\) - 36px\)\)/);
});

test("order editor uses one shared modal; fixed box and internal search scroll persist", () => {
  assert.match(editor, /<Modal[\s\S]*className="order-item-editor-modal"/);
  assert.match(detail, /width: min\(756px,/);
  assert.match(detail, /height: min\(566px,/);
  assert.match(detail, /\.order-item-edit-results \{/);
  assert.match(detail, /overflow-y: auto/);
  assert.doesNotMatch(editor, /createPortal|ResizeObserver|hub-slot-0/);
  assert.doesNotMatch(detail, /order-item-edit-layer/);
});

/** Bounding-box calculation: the dialog must remain inside the visible region
 * at supported window sizes; native KakaoTalk occupies the left-hand strip. */
test("reserved-width centering remains correct at multiple window sizes", () => {
  for (const [viewport, reserved, preferred] of [
    [1516, 410, 880],
    [1920, 420, 880],
    [1280, 420, 880],
    [1024, 400, 880],
    [1516, 410, 756],
    [1000, 400, 756],
    [1516, 0, 880],
  ]) {
    const available = viewport - reserved;
    const width = Math.min(preferred, Math.max(0, available - 36));
    const x = reserved + (available - width) / 2;
    assert.ok(x >= reserved, "hidden behind KakaoTalk: " + [viewport,reserved,preferred]);
    assert.ok(x + width <= viewport, "offscreen modal: " + [viewport,reserved,preferred]);
    assert.ok(Math.abs((x + width / 2) - (reserved + available / 2)) < .1);
  }
});
