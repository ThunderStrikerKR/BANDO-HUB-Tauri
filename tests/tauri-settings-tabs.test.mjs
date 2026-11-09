import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";

const view = readFileSync(new URL("../src/app/SettingsView.tsx", import.meta.url), "utf8");
const settings = readFileSync(new URL("../src/SettingsPanel.tsx", import.meta.url), "utf8");

test("settings have five tabs and accounts are part of basic settings", () => {
  for (const title of ["기본 설정", "파일 관리", "데이터 관리", "시스템", "개발자 모드"]) {
    assert.ok(view.includes('title: "' + title + '"'));
  }
  assert.equal((view.match(/title: "(기본 설정|파일 관리|데이터 관리|시스템|개발자 모드)"/g) ?? []).length, 5);
  assert.ok(!view.includes('title: "계좌 관리"'));
  assert.ok(settings.includes('<h2 className="settings-help-heading">입금 계좌 <HelpTooltip'));
  assert.ok(settings.includes('<h2 className="settings-help-heading">Excel 보관함 위치 <HelpTooltip'));
});

test("unsaved settings offer save, discard and cancel on tab change", () => {
  for (const text of ['editor.current?.hasUnsavedChanges()', 'setRequestedTab(next)',
    'await editor.current?.save()', '저장 안 함', '취소', '저장하고 이동', 'savingBeforeLeave',
    'key={activeTab}']) {
    assert.ok(view.includes(text), text);
  }
  assert.ok(settings.includes('if (!result.ok) return false'));
  assert.ok(settings.includes('hasUnsavedChanges: () => dirty'));
  assert.ok(!view.includes("localStorage"));
});

test("settings render only the active category and retain guarded operations", () => {
  assert.ok(settings.includes('hidden={section !== "basic"}'));
  assert.ok(settings.includes('hidden={section !== "files"}'));
  assert.ok(view.includes("<BackupPanel"));
  assert.ok(view.includes("<ReceiptArchive"));
  assert.ok(view.includes("<DeveloperLab"));
});
