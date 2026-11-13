import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const content = (path) => readFileSync(new URL("../" + path, import.meta.url), "utf8");
const view = content("src/MessageWorkspace.tsx");
const generator = content("src/automatic-message.ts");
const css = content("src/styles/patch-v0808.css");

test("optional product link toggle appears next to auto message heading", () => {
  assert.match(view, /<h2>복사용 자동 메시지<\/h2>[\s\S]*?<label className="message-link-toggle">/);
  assert.match(view, /type="checkbox"[\s\S]*?checked=\{includeLinks\}/);
  assert.match(view, /링크 포함/);
  assert.match(css, /\.messages-pane \.message-link-toggle/);
});
test("payment preview and clipboard use the optional link flag, default off", () => {
  assert.match(view, /useState\(false\)/);
  assert.match(view, /nativeAutomaticMessage\(latestState\.current, gid, includeLinks\)/);
  assert.doesNotMatch(view, /\bautomaticMessage\(state, gid, includeLinks\)/);
  assert.match(content("src/native-automatic-message.ts"), /"output", "render_automatic_message"/);
  assert.match(view, /window\.bando!\.copy\(greeting \? withGreeting\(text\) : text\)/);
});
test("request drafts exclude optional links when edited and avoid duplicates", () => {
  assert.match(view, /!baseText\.includes\(entry\.slice\(entry\.lastIndexOf\("\\n"\) \+ 1\)\)/);
  assert.match(view, /optionalSuffix && value\.endsWith\(optionalSuffix\)/);
  assert.match(view, /setIncludeLinks\(false\)/);
});
