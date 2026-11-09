import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const text = (name) => readFileSync(new URL("../" + name, import.meta.url), "utf8");
const footer = text("src/WorkflowFooter.tsx");
const css = text("src/styles/patch-v0808.css");

test("freight input stays 84px regardless of dispatch origin or inquiry visibility", () => {
  const money = css.match(/\.items-freight-panel \.freight-line > \.freight-money\s*\{([^}]*)\}/)?.[1];
  const input = css.match(/\.items-freight-panel \.freight-money > input\s*\{([^}]*)\}/)?.[1];
  assert.ok(money && input);
  assert.match(money, /flex: 0 0 auto;/);
  assert.doesNotMatch(money, /flex: 1/);
  for (const line of ["width: 84px;", "min-width: 84px;", "max-width: 84px;"]) {
    assert.ok(input.includes(line), line);
  }
});
test("factory-only inquiry remains a hidden layout placeholder for store dispatch", () => {
  assert.match(footer, /className="freight-inquiry"/);
  assert.match(footer, /aria-hidden=\{b\.origin !== "FACTORY"\}/);
  assert.match(footer, /visibility: b\.origin === "FACTORY" \? "visible" : "hidden"/);
  assert.doesNotMatch(footer, /\s+hidden=\{b\.origin !== "FACTORY"\}/);
  assert.match(css, /\.freight-line > \.freight-inquiry\s*\{[^}]*flex: 0 0 112px;/);
});
test("factory/store dispatch buttons have compact spacing and padding", () => {
  assert.match(css, /\.recipient-row-actions > \.dispatch-origin\s*\{[^}]*gap: 3px;/);
  assert.match(css, /\.recipient-row-actions \.dispatch-origin button\s*\{[^}]*height: 28px;/);
  assert.match(css, /\.recipient-row-actions \.dispatch-origin button\s*\{[^}]*padding: 3px 6px !important;/);
});
