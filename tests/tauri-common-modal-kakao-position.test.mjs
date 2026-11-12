import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const read = path => readFileSync(new URL("../" + path, import.meta.url), "utf8");
const shell = read("src/HubShell.tsx");
const common = read("src/styles/modals.css");
const products = read("src/styles/product-admin-redesign.css");
const decisions = read("src/styles/dialogs.css");
const editor = read("src/OrderItemEditor.tsx");
const editorStyles = read("src/styles/order-item-editor.css");

test("native KakaoTalk width is measured once in the BANDO HUB shell", () => {
  assert.ok(shell.includes("--kakao-reserved-width"));
  assert.ok(shell.includes("b.right + 6"));
  assert.ok(shell.includes('stacked ? "0px"'));
});

test("shared modal placement and backdrop exclude the always-on-top KakaoTalk strip", () => {
  assert.ok(common.includes("inset: 0 0 0 var(--kakao-reserved-width, 0px)"));
  assert.ok(common.includes("100vw - var(--kakao-reserved-width, 0px) - var(--modal-viewport-gutter)"));
  assert.ok(common.includes("transparent var(--kakao-reserved-width, 0px)"));
  assert.ok(decisions.includes("left: calc(var(--kakao-reserved-width, 0px)"));
});

test("product administration dialogs preserve the shared reserved left edge", () => {
  const detailRule = products.split(".app-modal-layer.product-detail-dialog {")[1]?.split("}")[0];
  assert.ok(detailRule, "missing product-detail-dialog rule");
  assert.ok(detailRule.includes("inset: 0 0 0 var(--kakao-reserved-width, 0px)"));
  assert.ok(!detailRule.includes("inset: 0;"));
  assert.ok(detailRule.includes("max-width: max(0px, calc(100vw - var(--kakao-reserved-width, 0px) - 36px))"));
});

test("brief modal contents do not inherit the old global 820px blank canvas", () => {
  const globalRule = read("src/styles/patch-v0808.css")
    .split(".app-modal-layer > .modal {")[1]?.split("}")[0];
  assert.ok(globalRule, "missing common modal panel rule");
  assert.ok(globalRule.includes("height: auto"));
  assert.ok(!globalRule.includes("820px"));
  assert.ok(read("src/styles/client-editor.css").includes("height: min(820px"));
  assert.ok(products.includes("height: min(820px"));
  assert.ok(editorStyles.includes("height: min(566px"));
});

test("order item correction reuses Modal, fixed outer bounds and scrollable search", () => {
  assert.ok(editor.includes("<Modal"));
  assert.ok(editor.includes('className="order-item-editor-modal"'));
  assert.ok(!editor.includes("createPortal"));
  assert.ok(!editor.includes("ResizeObserver"));
  assert.ok(editorStyles.includes("width: min(756px"));
  assert.ok(editorStyles.includes("height: min(566px"));
  assert.ok(editorStyles.includes(".order-item-edit-results {"));
  assert.ok(editorStyles.includes("overflow-y: auto"));
});

test("centering stays inside the unoccluded viewport at representative resolutions", () => {
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
    assert.ok(x >= reserved, "hidden behind KakaoTalk: " + [viewport, reserved, preferred]);
    assert.ok(x + width <= viewport, "dialog extends beyond screen");
    assert.equal(x + width / 2, reserved + available / 2);
  }
});
