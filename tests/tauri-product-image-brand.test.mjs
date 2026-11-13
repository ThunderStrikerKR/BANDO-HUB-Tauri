import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const read = (path) => readFileSync(new URL("../" + path, import.meta.url), "utf8");

test("Manual images are validated and compressed before entering the product state", () => {
  const optimizer = read("src/product-image-preprocess.ts");
  const manager = read("src/ProductManager.tsx");
  assert.match(optimizer, /MAX_SOURCE_BYTES = 5 \* 1024 \* 1024/);
  assert.match(optimizer, /MAX_SOURCE_PIXELS = 30_000_000/);
  assert.match(optimizer, /"image\/jpeg", "image\/png", "image\/webp"/);
  assert.match(optimizer, /for \(const edge of \[1024, 840, 700, 560\]\)/);
  assert.match(optimizer, /toDataURL\("image\/webp", 0\.8\)/);
  assert.match(optimizer, /MAX_DATA_URL_CHARS = 1_500_000/);
  assert.match(manager, /await optimizeProductImage\(file\)/);
  assert.match(manager, /previous\?\.id === editingId/);
  assert.doesNotMatch(manager, /reader\.readAsDataURL\(file\)/);
});

test("Image preprocessing cleans up temporary object URLs even on decoding failure", () => {
  const optimizer = read("src/product-image-preprocess.ts");
  assert.match(optimizer, /try \{/);
  assert.match(optimizer, /finally \{/);
  assert.match(optimizer, /URL\.revokeObjectURL\(objectUrl\)/);
  assert.match(optimizer, /image\.onerror = \(\) => reject\(Error\("이미지를 열 수 없습니다/);
});

test("Brands are validated for cross-brand aliases and evidence URLs before UI save", () => {
  const manager = read("src/Classification.tsx");
  const registry = read("src/product-registry.ts");
  const native = read("src-tauri/src/business_core/catalog_clients/brands.rs");
  assert.match(manager, /"catalog_clients", "upsert_brand"/);
  assert.doesNotMatch(manager, /validateBrands\(next,\s*state\)/);
  assert.match(manager, /await onSave\(next\)/);
  assert.match(native, /fn registry_key\(/);
  assert.match(native, /fn upsert_brand\(/);
  assert.match(native, /브랜드 공식명, 한글명 또는 검색 별칭이 다른 브랜드와 중복됩니다/);
  assert.match(native, /url\.scheme\(\)=="https"/);
  assert.match(registry, /export function validateBrands/);
  assert.match(registry, /evidence\.protocol !== "https:"/);
});

test("Rust validates changed brands within the same SQLite save transaction", () => {
  const rust = read("src-tauri/src/lib.rs");
  assert.match(rust, /fn validate_brands\(before: &Value, next: &Value\)/);
  assert.match(rust, /validate_brands\(&current, &state\)\?/);
  assert.match(rust, /fn brand_terms/);
  assert.match(rust, /link\.scheme\(\) == "https"/);
  assert.match(rust, /old\["id"\]\.as_str\(\) == Some\(id\) && old == brand/);
});

test("Image and brand fixes keep existing SQLite schema and product references", () => {
  const rust = read("src-tauri/src/lib.rs");
  const manager = read("src/ProductManager.tsx");
  assert.match(rust, /CREATE TABLE IF NOT EXISTS app_state/);
  assert.match(rust, /CREATE TABLE IF NOT EXISTS product_index/);
  assert.match(manager, /imageOverride: "MANUAL"/);
  assert.match(manager, /imageOverride: "HIDDEN"/);
  const native = read("src-tauri/src/business_core/catalog_clients.rs");
  assert.match(manager, /"catalog_clients", "upsert_product"/);
  assert.match(native, /fn validate_product\(/);
  assert.match(native, /fn product_url_ok\(/);
  assert.match(native, /normalized_color\(field\(v, "color"\)\)/);
});
