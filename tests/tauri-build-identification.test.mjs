import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = (path) => readFileSync(new URL("../" + path, import.meta.url), "utf8");

test("Settings displays only executable version and build commit ID", () => {
  const settings = src("src/app/SettingsView.tsx");
  assert.match(settings, /현재 버전: v\{__BANDO_VERSION__\}/);
  assert.match(settings, /빌드 ID: \{__BANDO_BUILD_ID__\}/);
  assert.doesNotMatch(settings, /빌드 시각|Working Tree|Build Time/);
});

test("Vite embeds the checked-out commit at build time and does not invent an ID", () => {
  const vite = src("vite.config.ts");
  assert.match(vite, /rev-parse/);
  assert.match(vite, /--short=7/);
  assert.match(vite, /__BANDO_BUILD_ID__: JSON\.stringify\(buildId\)/);
  assert.match(vite, /__BANDO_VERSION__: JSON\.stringify\(version\)/);
  assert.match(vite, /확인 불가/);
});
