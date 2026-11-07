import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const source = readFileSync(new URL("../BUILD_WINDOWS_TAURI.cmd", import.meta.url), "utf8");

test("Windows build checks both running EXE names before npm or cargo build", () => {
  const preflight = source.indexOf("call :ensure_bando_closed");
  const install = source.indexOf("call npm install");
  const compile = source.indexOf("call npm run build:windows");
  assert.ok(preflight >= 0 && preflight < install && install < compile);
  assert.match(source, /tasklist \/FI "IMAGENAME eq bando_hub\.exe"/);
  assert.match(source, /tasklist \/FI "IMAGENAME eq bando_hub_tauri\.exe"/);
  assert.match(source, /:app_running\r?\n[\s\S]*BUILD NOT STARTED/);
  assert.doesNotMatch(source, /taskkill(?:\.exe)?\s/i);
});

test("Windows build stages new binary and rechecks before replacing published executable", () => {
  const stage = source.indexOf('"release\\bando_hub.exe.pending" >nul');
  const secondGuard = source.indexOf("call :ensure_bando_closed", source.indexOf("call npm run build:windows"));
  const rename = source.indexOf('move /Y "release\\bando_hub.exe.pending" "release\\bando_hub.exe"');
  const cleanup = source.indexOf('del /Q "release\\BANDO-HUB-v*.exe"');
  assert.ok(stage > 0 && secondGuard > stage && rename > secondGuard);
  assert.ok(cleanup > rename, "Old versions can only be deleted after a successful rename");
  assert.match(source, /if errorlevel 1 goto copy_failed/);
  assert.match(source, /:app_running_after_build[\s\S]*Existing release\\bando_hub\.exe was not changed/);
  assert.match(source, /:copy_failed[\s\S]*Existing release\\bando_hub\.exe was not changed/);
});
