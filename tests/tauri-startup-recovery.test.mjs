import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL("../" + path, import.meta.url), "utf8");

test("failed native DB opening keeps Tauri window alive and does not manage a partial database", () => {
  const lib=read("src-tauri/src/lib.rs");
  const recovery=read("src-tauri/src/startup_recovery.rs");
  assert.match(lib,/startup_recovery::initial_open\(app\.handle\(\), &startup\)/);
  assert.match(lib,/app\.manage\(startup\)/);
  assert.match(recovery,/Err\(reason\) => \{/);
  assert.match(recovery,/state\.finish\(Err\(reason\)\)/);
  assert.match(recovery,/pub\(super\) fn initial_open/);
  assert.match(recovery,/pub\(super\) async fn retry_startup/);
  assert.match(recovery,/if !app\.manage\(db\)/);
  assert.match(recovery,/open_checked_sqlite/);
  assert.match(recovery,/PRAGMA quick_check\(1\)/);
  for(const command of ["startup_status","startup_metrics","retry_startup"]){
    assert.match(lib,new RegExp("startup_recovery::"+command));
  }
});

test("React shows native failure status, guards retry and loads saved state only after READY",()=>{
  const app=read("src/App.tsx");
  const model=read("src/app/useAppModel.ts");
  const bridge=read("src/tauri-bridge.ts");
  const screen=read("src/app/StartupRecoveryPanel.tsx");
  assert.match(app,/model\.startup\.phase === "ERROR"/);
  assert.match(app,/<StartupRecoveryPanel/);
  assert.match(model,/if \(status\.phase !== "READY"\) return/);
  assert.match(model,/const next = await api\.retryStartup\(\)/);
  assert.match(model,/if \(next\.phase === "READY"\)/);
  assert.match(bridge,/invoke\("startup_status"\)/);
  assert.match(bridge,/invoke\("startup_metrics"\)/);
  assert.match(bridge,/invoke\("retry_startup"\)/);
  assert.match(screen,/기존 업무 데이터베이스/);
  assert.match(screen,/자동 복원하지 않았습니다/);
  assert.match(screen,/안전하게 다시 시도/);
  assert.doesNotMatch(screen,/resetTestDatabase|backupRestore|removeItem|window\.location\.reload/);
});

test("startup failure is never interpreted as permission to delete or overwrite DB",()=>{
  const native=read("src-tauri/src/startup_recovery.rs");
  assert.doesNotMatch(native, /fs::remove_file\(|DROP TABLE|DELETE FROM app_state|backup_restore\(/);
  assert.match(native,/fn failed_open_never_replaces_existing_user_payload/);
  assert.match(native,/fn retry_is_only_allowed_from_failed_state_and_does_not_reset_mode/);
  assert.match(native,/fn missing_db_uses_seed_but_existing_valid_db_survives_reopen/);
  const mode=read("src-tauri/src/developer_workspace.rs");
  assert.match(mode,/startup: State<'_, startup_recovery::StartupRecovery>/);
  assert.match(mode,/startup\.is_test/);
});
