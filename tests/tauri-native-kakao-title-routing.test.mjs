import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");

test("Kakao title/client association is saved by native Rust with one SQLite commit", () => {
  const component = read("src/KakaoClients.tsx");
  assert.match(component, /"rules", "remember_kakao_title_client"/);
  assert.match(component, /await onSave\(updated\)/);
  assert.doesNotMatch(component, /rememberTitle\(/);
});
test("automatic remembered client lookup and clipboard paste use native read projection", () => {
  const source = read("src/SourceDocument.tsx");
  const calls = source.match(/"rules", "remembered_kakao_title_client"/g) ?? [];
  assert.equal(calls.length, 2);
  assert.doesNotMatch(source, /rememberedTitleClient\(/);
  assert.match(source, /if \(cancelled \|\| !alive\.current \|\| !id\) return/);
  assert.match(source, /latestInputs\.current\.order !== order/);
});
test("production routing and original TypeScript differential scenarios remain available", () => {
  const router = read("src-tauri/src/business_core/rules/mod.rs");
  const native = read("src-tauri/src/business_core/rules/kakao_title.rs");
  const parity = read("tests/rust-migration/rules/parity/compare.mts");
  assert.match(router, /"remember_kakao_title_client" \| "remembered_kakao_title_client"/);
  assert.match(native, /unicode_normalization::UnicodeNormalization/);
  for (const name of ["remember normalized chat", "duplicate normalized titles mark ambiguous",
    "two chat windows are not selected", "inactive dealer blocked"]) {
    assert.ok(parity.includes(name), name);
  }
});
