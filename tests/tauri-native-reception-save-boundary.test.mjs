import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const read = (path) => readFileSync(new URL("../" + path, import.meta.url), "utf8");

// The real React commit must invoke the audited Rust reducer before the only
// SQLite write; a TS oracle in tests is not a production fallback.
test("every ordinary app commit filters reception drafts through native Rust before SQLite save", () => {
  const app = read("src/app/useAppModel.ts");
  const start = app.indexOf("  const commit = async (next: State) => {");
  const end = app.indexOf("  const saveSettings =", start);
  assert.ok(start !== -1 && end > start);
  const commit = app.slice(start, end);
  assert.match(commit, /await businessCoreCall<\{ state: State \}>\(\s*"rules", "apply_reception_action", \{\s*action: "persisted_reception_state", before: state!, state: next/);
  assert.doesNotMatch(commit, /persistedReceptionState\(/);
  assert.ok(commit.indexOf('"persisted_reception_state"') < commit.indexOf("window.bando!.save(persistent)"));
  assert.match(commit, /if \(JSON\.stringify\(persistent\) === JSON\.stringify\(state\)\)/);
  assert.match(commit, /finally \{\s*commitGuard\.current = false;/);
});

test("native reducer has production Rust routing and executable original TS differential fixtures", () => {
  const rules = read("src-tauri/src/business_core/rules/reception_operations.rs");
  const parity = read("tests/rust-migration/rules/parity/compare.mts");
  assert.match(rules, /"persisted_reception_state"\s*=>/);
  assert.match(parity, /receptionOperation\("filter preview "/);
  assert.match(parity, /persistedReceptionState\(input\.before as any,input\.state as any\)/);
  assert.match(parity, /receptionOperation\("no draft is unchanged"/);
});
