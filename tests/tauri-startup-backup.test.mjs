import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL("../" + path, import.meta.url), "utf8");

test("automatic backups are checked once at startup, never by a midnight or 30-minute timer", () => {
  const lib = read("src-tauri/src/lib.rs");
  const backup = read("src-tauri/src/backup_manager.rs");
  assert.match(lib, /std::thread::spawn\(move \|\| \{/);
  assert.match(lib, /backup_manager::automatic_backup_if_needed/);
  assert.doesNotMatch(lib, /std::thread::spawn\(move \|\| loop/);
  assert.doesNotMatch(lib, /from_secs\(1800\)/);
  assert.match(backup, /day_has_automatic\(&dir, today\)/);
  assert.match(backup, /month_has_permanent\(&dir, today\)/);
  assert.match(backup, /prune_automatic\(&dir, today\)/);
});
