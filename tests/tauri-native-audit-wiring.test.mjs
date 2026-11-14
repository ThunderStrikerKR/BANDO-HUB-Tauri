import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const read = path => readFileSync(new URL("../"+path,import.meta.url),"utf8");

test("CI-only trace cannot bypass real native dispatcher or ship in regular release",()=>{
  const bridge=read("src/tauri-bridge.ts");
  const ci=read(".github/workflows/migration-output.yml");
  const runner=read("scripts/migration03-reception-native-ui.mjs");
  const prod=read("src-tauri/tauri.conf.json");
  assert.match(bridge,/import\.meta\.env\.VITE_BANDO_NATIVE_AUDIT !== "true"/);
  assert.match(bridge,/return invoke<T>\("business_core_call"/);
  assert.match(bridge,/auditNativeCall\("business_core_call"/);
  assert.match(bridge,/auditNativeCall\("clipboard_read"\)/);
  assert.match(bridge,/auditNativeCall\("state_save"\)/);
  assert.match(ci,/VITE_BANDO_NATIVE_AUDIT: "true"/);
  assert.match(ci,/tauri\.ci-cdp\.conf\.json/);
  assert.doesNotMatch(prod,/remote-debugging-port|additionalBrowserArgs/);
  assert.match(runner,/__TAURI_INTERNALS__,"invoke"/);
  assert.doesNotMatch(runner,/api\.invoke\s*=|__TAURI_INTERNALS__\.invoke\s*=/);
});
