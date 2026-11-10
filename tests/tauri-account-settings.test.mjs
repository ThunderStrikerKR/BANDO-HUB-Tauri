import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const read = (name) => readFileSync(new URL("../" + name, import.meta.url), "utf8");

test("Tauri account settings use isolated Rust patch command", () => {
  const rust = read("src-tauri/src/lib.rs");
  const bridge = read("src/tauri-bridge.ts");
  const screen = read("src/SettingsPanel.tsx");
  assert.match(rust, /fn settings_patch\(/);
  assert.match(rust, /generate_handler![\s\S]*settings_patch/);
  assert.match(rust, /expected\.contains_key\(field\)/);
  assert.match(bridge, /patchSettings: .*invoke<State>\("settings_patch"/);
  assert.match(screen, /settingsChanges\(/);
  assert.match(screen, /onSaveSettings\(changes, expected\)/);
  assert.doesNotMatch(screen, /await onSave\(\{ \.\.\.state/);
});

test("Client per-account preference is stored and affects outbound billing", () => {
  const types = read("src/types.ts");
  const manager = read("src/ClientManager.tsx");
  const domain = read("src/domain.ts");
  const workflow = read("src/workflow.ts");
  assert.match(types, /preferredAccountId\?: string/);
  assert.match(manager, /주 사용 입금계좌/);
  assert.match(manager, /preferredAccountId: value/);
  assert.match(domain, /if \(o\.accountMode === "MANUAL"\)/);
  assert.match(domain, /client\?\.preferredAccountId/);
  assert.match(domain, /recommendAccount\(o, s, products, c\)/);
  // Before confirmation, account recommendations use the live dealer;
  // confirmed orders must keep their captured preferred account setting.
  assert.match(workflow, /orderParty\(active, state\)/);
  assert.match(workflow, /orderParty\(order, state\)/);
});

test("Required sender information is validated at UI and Rust save boundary", () => {
  const manager = read("src/ClientManager.tsx");
  const rust = read("src-tauri/src/lib.rs");
  assert.match(manager, /!edit\.address\?\.trim\(\)/);
  assert.match(manager, /edit\.phone\?\.trim\(\) \|\| edit\.mobile\?\.trim\(\)/);
  assert.match(rust, /fn validate_clients\(/);
  assert.match(rust, /validate_clients\(&current, &state\)\?/);
  assert.match(rust, /validate_accounts\(&state\)\?/);
});
