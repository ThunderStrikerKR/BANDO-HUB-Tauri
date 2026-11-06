import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const read = (path) => readFileSync(new URL("../" + path, import.meta.url), "utf8");

test("Official product URL backend is restricted to HTTPS official hosts and product IDs", () => {
  const rust = read("src-tauri/src/lib.rs");
  assert.match(rust, /fn validate_official_product_url/);
  assert.match(rust, /url\.scheme\(\) != "https"/);
  assert.match(rust, /"bandostand\.com"/);
  assert.match(rust, /"bandomall\.co\.kr"/);
  assert.match(rust, /url\.username\(\)/);
  assert.match(rust, /url\.port\(\)/);
  assert.match(rust, /"product_no"/);
  assert.match(rust, /fn rejects_non_official_and_unsafe_urls/);
  assert.match(rust, /reqwest::redirect::Policy::none\(\)/);
});
test("Official page read is bounded by size and time", () => {
  const rust = read("src-tauri/src/lib.rs");
  assert.match(rust, /const MAX_BODY: usize = 4 \* 1024 \* 1024/);
  assert.match(rust, /from_secs\(15\)/);
  assert.match(rust, /while let Some\(part\) = response\.chunk\(\)\.await/);
  assert.match(rust, /String::from_utf8\(body\)/);
  assert.match(rust, /fetch_official_product_html\s*,?\s*\n/);
});
test("Frontend uses DOMParser, model and site ID, and blocks ambiguous options", () => {
  const parser = read("src/official-product-import.ts");
  assert.match(parser, /new DOMParser\(\)\.parseFromString\(html, "text\/html"\)/);
  assert.match(parser, /siteProductId\(url\)/);
  assert.match(parser, /selectableOptions/);
  assert.match(parser, /matches\.length > 1/);
  assert.match(parser, /variants\.length !== 1/);
  assert.match(parser, /deletedAt/);
  assert.match(parser, /canApply: reasons\.length === 0/);
});
test("Official import saves only after review, backup and revision validation", () => {
  const parser = read("src/official-product-import.ts");
  const component = read("src/ProductImports.tsx");
  assert.match(parser, /state\.revision \?\? 0\) !== preview\.revision/);
  assert.match(parser, /variant\.retail = newPrice/);
  assert.match(parser, /validateProduct\(product, registeredProducts\(next\.products\)\)/);
  assert.match(parser, /catalogFromCategory\(cats, category\.id\)/);
  assert.match(component, /confirmAction\(/);
  assert.match(component, /window\.bando!\.backup\(\)/);
  assert.match(component, /await onSave\(result\.next\)/);
  assert.match(component, /await onRefresh\(\)/);
});
test("Tauri preview replaces previous not-ready bridge and leaves non-product methods untouched", () => {
  const bridge = read("src/tauri-bridge.ts");
  const rust = read("src-tauri/src/lib.rs");
  assert.match(bridge, /parseOfficialProductPage\(url, html, state\)/);
  assert.match(bridge, /fetch_official_product_html/);
  assert.doesNotMatch(bridge, /previewImport: async \(\) => notReady/);
  assert.match(rust, /fetch_official_product_html/);
});
