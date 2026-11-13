import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const content = (path) => readFileSync(new URL("../" + path, import.meta.url), "utf8");
const view = content("src/MessageWorkspace.tsx");
const nativeProjection = content("src/native-automatic-message.ts");
const nativeRenderer = content("src-tauri/src/business_core/output/automatic_full.rs");
const css = content("src/styles/patch-v0808.css");

test("optional product link toggle appears next to auto message heading", () => {
  assert.match(view, /<h2>복사용 자동 메시지<\/h2>[\s\S]*?<label className="message-link-toggle">/);
  assert.match(view, /type="checkbox"[\s\S]*?checked=\{includeLinks\}/);
  assert.match(view, /링크 포함/);
  assert.match(css, /\.messages-pane \.message-link-toggle/);
});
test("payment preview and clipboard use the optional link flag, default off", () => {
  assert.match(view, /useState\(false\)/);
  assert.match(view, /nativeAutomaticMessage\(state, gid, includeLinks\)/);
  assert.match(nativeProjection, /includeLinks = false/);
  assert.match(nativeProjection, /"output", "render_automatic_message"/);
  assert.match(nativeRenderer, /let include_links=is_true\(payload,"includeLinks"\)/);
  assert.match(nativeRenderer, /if include_links\{payment_with_links\.clone\(\)\}/);
  assert.doesNotMatch(view, /\bautomaticMessage\(state, gid,/);
  assert.match(view, /window\.bando!\.copy\(greeting \? withGreeting\(text\) : text\)/);
});
test("request drafts exclude optional links when edited and avoid duplicates", () => {
  assert.match(view, /automatic\.validRequestLinks/);
  assert.match(view, /!baseText\.includes\(entry\.split\("\\n"\)\.at\(-1\) \?\? ""\)/);
  assert.match(nativeRenderer, /let valid_links=distinct\(/);
  assert.match(view, /optionalSuffix && value\.endsWith\(optionalSuffix\)/);
  assert.match(view, /setIncludeLinks\(false\)/);
});
