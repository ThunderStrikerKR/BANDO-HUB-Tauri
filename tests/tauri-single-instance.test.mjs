import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL("../" + path, import.meta.url), "utf8");

test("Windows startup acquires the instance guard before Tauri and SQLite", () => {
  const lib = read("src-tauri/src/lib.rs");
  const acquire = lib.indexOf("single_instance::acquire(");
  const builder = lib.indexOf("tauri::Builder::default()", acquire);
  const setup = lib.indexOf(".setup(move |app|", builder);
  const database = lib.indexOf("initialize_database(", setup);
  assert.ok(acquire > 0 && builder > acquire && setup > builder && database > setup);
  assert.match(lib, /Acquisition::Existing\) => return/);
  assert.match(lib, /single_instance::listen\(instance, app\.handle\(\)\.clone\(\)\)/);
  assert.match(lib, /--bando-developer-test/);
});

test("production and developer TEST have separate Windows instance identities", () => {
  const native = read("src-tauri/src/single_instance.rs");
  assert.match(native, /BANDO_HUB_TAURI_PRODUCTION/);
  assert.match(native, /BANDO_HUB_TAURI_DEVELOPER_TEST/);
  assert.match(native, /CreateMutexW/);
  assert.match(native, /CreateEventW/);
  assert.match(native, /SetEvent\(event\)/);
  assert.match(native, /WaitForSingleObject\(guard\.activate_event, INFINITE\)/);
  assert.match(native, /window\.show\(\)/);
  assert.match(native, /window\.unminimize\(\)/);
  assert.match(native, /window\.set_focus\(\)/);
  for (const testName of [
    "duplicate_launch_is_rejected_and_signals_the_first_window",
    "production_and_developer_modes_have_independent_namespaces",
    "concurrent_launches_only_allow_one_first_instance",
  ]) assert.ok(native.includes("fn " + testName + "()"), testName);
});

test("single-instance integration does not require a new dependency or change app version", () => {
  const cargo = read("src-tauri/Cargo.toml");
  const config = JSON.parse(read("src-tauri/tauri.conf.json"));
  assert.equal(config.version, "0.0.4");
  assert.match(cargo, /version = "0\.0\.4"/);
  assert.doesNotMatch(cargo, /tauri-plugin-single-instance/);
});
