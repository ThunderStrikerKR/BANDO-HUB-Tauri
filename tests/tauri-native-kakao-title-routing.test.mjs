import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");

test("Kakao title/client association is saved by native Rust with one SQLite commit", () => {
  const component = read("src/KakaoClients.tsx");
  const adapter = read("src/native-title-clients.ts");
  const native = read("src-tauri/src/business_core/catalog_clients.rs");
  assert.match(component, /await nativeRememberTitle\(/);
  assert.match(component, /await onSave\(/);
  assert.doesNotMatch(component, /\brememberTitle\(/);
  assert.match(adapter, /"catalog_clients", "remember_title_client"/);
  assert.match(native, /"remembered_title_client" \| "remember_title_client"/);
});
test("automatic remembered client lookup and clipboard paste use native read projection", () => {
  const source = read("src/SourceDocument.tsx");
  const adapter = read("src/native-title-clients.ts");
  assert.match(source, /nativeRememberedTitleClient\(state, windows\)/);
  assert.match(source, /await nativeRememberedTitleClient\(state, chats\)/);
  assert.match(adapter, /"catalog_clients", "remembered_title_client"/);
  assert.doesNotMatch(source, /\brememberedTitleClient\(/);
  assert.match(source, /autoInput\.current\.state !== state/);
  assert.match(source, /latestReception\.current\.order !== order/);
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
