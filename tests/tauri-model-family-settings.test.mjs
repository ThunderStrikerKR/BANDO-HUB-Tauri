import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL("../" + path, import.meta.url), "utf8");

test("Model family editor persists only the two edited settings keys", () => {
  const ui = read("src/RepresentativeManager.tsx");
  assert.match(ui, /const fields = \["modelFamilies", "modelRepresentatives"\] as const/);
  assert.match(ui, /changes\[field\] = draft\.settings\[field\] \?\? null/);
  assert.match(ui, /expected\[field\] = baseline\.settings\[field\] \?\? null/);
  assert.match(ui, /window\.bando\.patchSettings\(changes, expected\)/);
  assert.doesNotMatch(ui, /await onSave\(draft\)/);
});

test("Model family changes compare against the editing baseline, not another screen", () => {
  const ui = read("src/RepresentativeManager.tsx");
  assert.match(ui, /useState<State>\(\(\) => structuredClone\(state\)\)/);
  assert.match(ui, /JSON\.stringify\(baseline\.settings\.modelFamilies/);
  assert.match(ui, /JSON\.stringify\(baseline\.settings\.modelRepresentatives/);
  assert.match(ui, /if \(!unsaved\) \{/);
  assert.match(ui, /setBaseline\(structuredClone\(state\)\)/);
});

test("Model family changes validate latest products and create a DB backup", () => {
  const ui = read("src/RepresentativeManager.tsx");
  assert.match(ui, /const latest = await window\.bando\.load\(\)/);
  assert.match(ui, /validateModelSettings\(candidate, latest\)/);
  assert.match(ui, /await window\.bando\.backup\(\)/);
  assert.match(ui, /await onRefresh\(\)/);
  assert.match(ui, /setDraft\(structuredClone\(updated\)\)/);
});

test("The native settings patch protects concurrent changes at the individual key level", () => {
  const rust = read("src-tauri/src/lib.rs");
  assert.match(rust, /"modelRepresentatives", "modelFamilies"/);
  assert.match(rust, /before != &expected\[field\] && before != updated/);
  assert.match(rust, /write_snapshot\(&mut conn, state, revision, true\)/);
  assert.doesNotMatch(read("src/RepresentativeManager.tsx"), /state_save/);
});

test("Product manager refreshes state after the model family patch", () => {
  const pm = read("src/ProductManager.tsx");
  assert.match(pm, /<RepresentativeManager state=\{state\} onRefresh=\{onRefresh\}/);
  assert.doesNotMatch(pm, /<RepresentativeManager state=\{state\} onSave=/);
});
