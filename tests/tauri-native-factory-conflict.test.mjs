import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const read = (p) => readFileSync(new URL("../"+p, import.meta.url),"utf8");

test("native factory conflict IPC is wired through both review surfaces", () => {
  const rust=read("src-tauri/src/factory_conflict.rs");
  const lib=read("src-tauri/src/lib.rs");
  const bridge=read("src/tauri-bridge.ts");
  const history=read("src/FactoryReplyHistory.tsx");
  const notification=read("src/FactoryNotifications.tsx");
  const nativeReview=read("src/native-factory-conflict-review.ts");
  assert.match(nativeReview, /"rules", "factory_conflict_confirmation"/);
  assert.match(lib,/factory_conflict::approve_factory_conflict/);
  assert.match(bridge,/invoke<void>\("approve_factory_conflict", \{ id, row, expectedRevision \}\)/);
  for(const ui of [history,notification]) {
    assert.match(ui,/nativeFactoryConflictConfirmation\(/);
    assert.match(ui,/approveFactoryConflict\(/);
    assert.doesNotMatch(ui,/await onSave\(next\)/);
    assert.doesNotMatch(ui,/await window\.bando!\.backup\(\)/);
  }
  assert.match(rust,/fn correct_state\(/);
  assert.match(rust,/verified_original\(/);
  assert.match(rust,/backup_before_correction\(/);
  assert.match(rust,/write_snapshot\(/);
  assert.match(rust,/expected_revision/);
  assert.match(rust,/Sha256::digest/);
});

test("user sees before and after values with one-row confirmation",()=>{
  const review=read("src/factory-conflict-review.ts");
  assert.match(review,/actualFreightOf/);
  assert.match(review,/기존:/);
  assert.match(review,/회신:/);
  assert.match(review,/이 한 행만 정정할까요/);
});
