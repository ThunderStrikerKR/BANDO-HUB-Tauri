import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL("../" + path, import.meta.url), "utf8");
const css = read("src/styles/patch-v0808.css");
const desk = read("src/OrderDesk.tsx");
const freight = read("src/WorkflowFooter.tsx");
const messages = read("src/MessageWorkspace.tsx");

const block = (selector) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = [...css.matchAll(new RegExp(escaped + "\\s*\\{([^}]*)\\}", "g"))];
  assert.ok(matches.length, "missing CSS block " + selector);
  return matches[matches.length - 1][1];
};

test("quantity and amount columns preserve maximum room for product names", () => {
  assert.match(block(".items-freight-panel .compact-items th:first-child"), /width: auto;/);
  assert.match(block(".items-freight-panel .compact-items th:nth-child(2)"), /width: 78px;/);
  assert.match(block(".items-freight-panel .compact-items th:nth-child(3)"), /width: 108px;/);
  const quantity = block('.items-freight-panel .compact-items input[type="number"]');
  assert.match(quantity, /width: 56px;/);
  assert.match(quantity, /flex: 0 0 56px;/);
  assert.doesNotMatch(quantity, /width: 100%;/);
  assert.match(desk, /value=\{i\.quantity \?\? ""\}/);
  assert.match(desk, /won\(i\.unitPrice \* i\.quantity\)/);
  assert.doesNotMatch(desk, /max="100"/);
});

test("freight controls spread out without width changes between factory and store", () => {
  assert.match(block(".items-freight-panel .freight-line"), /justify-content: space-between;/);
  assert.match(block(".items-freight-panel .freight-line > select"), /width: 68px;/);
  assert.match(block(".items-freight-panel .freight-money > input"), /width: 84px;/);
  assert.match(block(".items-freight-panel .freight-line > .freight-inquiry"), /margin-left: 0;/);
  assert.match(freight, /visibility: b\.origin === "FACTORY" \? "visible" : "hidden"/);
});

test("message link checkbox is right aligned and VAT is inset", () => {
  assert.match(block(".messages-pane > .pane-heading h2"), /flex: 1 1 auto;/);
  assert.match(block(".messages-pane .message-link-toggle"), /margin-left: auto;/);
  assert.match(messages, /<label className="message-link-toggle">/);
  assert.match(block(".items-freight-panel .shipment-vat"), /padding: 0 12px;/);
});

test("error descriptions are not clickable and only their action buttons navigate", () => {
  const checks=read("src/StaffChecks.tsx");
  assert.match(checks, /<div className="issue-heading">/);
  assert.doesNotMatch(checks, /<button className="issue-heading"/);
  assert.match(checks, /<div className="issue-actions">/);
  assert.doesNotMatch(checks, /원문 정정/);
});
