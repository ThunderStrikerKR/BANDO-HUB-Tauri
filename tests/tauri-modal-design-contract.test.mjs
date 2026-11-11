import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { auditCSS } from "../scripts/audit-css-ownership.mjs";

const root = new URL("../", import.meta.url);
const source = (path) => readFileSync(new URL("../" + path, import.meta.url), "utf8");
const tokens = source("src/styles/tokens.css");
const modals = source("src/styles/modals.css");
const decisions = source("src/styles/dialogs.css");
const components = source("src/styles/components.css");
const modalApi = source("src/ui/Modal.tsx");
const decisionsApi = source("src/dialogs.ts");

test("new editor and decision dialogs inherit one modal token contract", () => {
  const required = {
    "--modal-title-size": "calc(18px * var(--ui-scale, 1))",
    "--modal-body-size": "calc(13px * var(--ui-scale, 1))",
    "--modal-action-size": "calc(14px * var(--ui-scale, 1))",
    "--modal-decision-action-size": "var(--modal-body-size)",
    "--modal-close-height": "var(--control-compact)",
    "--modal-width": "880px",
    "--modal-decision-width": "560px",
    "--modal-viewport-gutter": "36px",
    "--modal-panel-padding": "16px 18px",
    "--modal-header-gap": "12px",
  };
  for (const [name, value] of Object.entries(required)) {
    assert.ok(tokens.includes(name + ": " + value + ";"),
      "Modal token was removed or drifted: " + name + " = " + value);
  }
  for (const key of ["--modal-title-size", "--modal-body-size",
    "--modal-close-height", "--modal-width", "--modal-viewport-gutter",
    "--modal-panel-padding", "--modal-header-gap"]) {
    assert.ok(modals.includes("var(" + key + ")"), "Modal base CSS no longer consumes " + key);
  }
  for (const key of ["--modal-title-size", "--modal-body-size",
    "--modal-decision-width", "--modal-decision-action-size", "--modal-panel-padding"]) {
    assert.ok(decisions.includes("var(" + key + ")"),
      "Confirmation/prompt CSS no longer consumes " + key);
  }
  assert.match(components, /\.app-modal-layer button\s*\{\s*font-size:\s*var\(--modal-action-size\);/);
  assert.match(modalApi, /className=\{"app-modal-layer"/);
  assert.match(modalApi, /<section className="modal">/);
  assert.match(modalApi, /<fieldset role="presentation" className="modal-fields"/);
  assert.match(decisionsApi, /dialog\.className = "app-action-dialog"/);
});

test("all modal title-size declarations are owned by the common modal stylesheet", () => {
  const report = auditCSS();
  const modalTitles = report.declarations.filter(entry =>
    entry.selector.includes(".app-modal-layer") &&
    entry.selector.includes("header h2") &&
    (entry.property === "font-size" || entry.property === "font"));
  assert.ok(modalTitles.length >= 1, "Shared modal title is missing");
  assert.ok(modalTitles.every(entry =>
    entry.path === "modals.css" && entry.value.includes("var(--modal-title-size)")),
  "Feature-specific modal title sizes must not override the shared token: " +
    JSON.stringify(modalTitles));
  const confirmTitle = report.declarations.filter(entry =>
    entry.selector === ".app-action-dialog h2" &&
    (entry.property === "font-size" || entry.property === "font"));
  assert.deepEqual(confirmTitle.map(entry => entry.path), ["dialogs.css"]);
  assert.ok(confirmTitle[0].value.includes("var(--modal-title-size)"));
  const modalActions = report.declarations.filter(entry =>
    entry.selector === ".app-modal-layer button" && entry.property === "font-size");
  assert.ok(modalActions.length >= 1);
  assert.equal(modalActions.at(-1).path, "components.css");
  assert.equal(modalActions.at(-1).value, "var(--modal-action-size)");
});

test("future native dialogs must use Modal or the confirmation/prompt helpers", () => {
  const matches = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, {withFileTypes:true})) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { walk(path); continue; }
      if (!/\.(?:tsx?|jsx?)$/.test(entry.name)) continue;
      const normalized = relative(new URL("../", import.meta.url).pathname, path)
        .replaceAll("\\", "/");
      if (normalized === "src/ui/Modal.tsx" || normalized === "src/dialogs.ts") continue;
      const content = readFileSync(path, "utf8");
      if (/<dialog\b|document\.createElement\s*\(\s*["']dialog["']/.test(content))
        matches.push(normalized);
    }
  };
  walk(new URL("../src", import.meta.url));
  assert.deepEqual(matches, [],
    "Do not add raw native dialogs with independent CSS. Reuse Modal or dialogs.ts: " + matches.join(", "));
});
