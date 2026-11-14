/** Compiled Rust title-to-dealer logic compared with the exact original TS oracle. */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tsImport } from "tsx/esm/api";

const { rememberedTitleClient, rememberTitle, titleKey } =
  await tsImport("../../../src/title-clients.ts", import.meta.url);
const manifest = fileURLToPath(new URL("./Cargo.toml", import.meta.url));
const root = fileURLToPath(new URL("../../../", import.meta.url));
const now = "2026-11-15T00:00:00.000Z";
const initial = () => ({
  revision: 3,
  settings: { operatorName: "직원", kakaoTitleMappings: {
    [titleKey(" 악기사 ")]: { clientId: "c1", updatedAt: now, actor: "직원", ambiguous: false },
  }},
  clients: [
    { id: "c1", name: "악기사", active: true },
    { id: "c2", name: "종로 매장", active: true },
  ],
  orders: [{ id: "immutable-order", pricesLocked: true }],
});
const chat = (handle, title, kind = "CHAT") => ({ handle, title, kind });
const cases = [];
function recall(label, change = () => {}) {
  const state = initial(), windows = [chat("1", "악기사")];
  change(state, windows);
  cases.push({
    label, operation: "remembered_title_client", payload: { state, windows },
    expected: { ok: true, value: { clientId: rememberedTitleClient(state, windows) ?? null } },
  });
}
recall("single remembered dealer");
recall("NFKC title key, trim and spaces", (_, windows) => {
  windows[0].title = "  악  기 사  ";
});
recall("duplicate title windows", (_, windows) => {
  windows.push(chat("2", "악기사"));
});
recall("unrelated second chat disables implicit client selection", (_, windows) => {
  windows.push(chat("2", "다른 대화창"));
});
recall("dock status window excluded", (_, windows) => {
  windows.push(chat("3", "악기사", "OTHER"));
});
recall("ambiguous saved mapping", (state) => {
  state.settings.kakaoTitleMappings["악기사"].ambiguous = true;
});
recall("archived dealer cannot be auto-selected", (state) => {
  state.clients[0].deletedAt = "2026-11-01";
});
recall("inactive dealer cannot be auto-selected", (state) => {
  state.clients[0].active = false;
});
recall("missing saved mapping", (state) => {
  state.settings.kakaoTitleMappings = {};
});
function store(label, mutate = () => {}) {
  const state = initial(), windows = [chat("1", "악기사")];
  const handle = "1", clientId = "c2", actor = "담당 직원";
  mutate(state, windows);
  let expected;
  try {
    const value = rememberTitle(state, windows, handle, clientId, actor);
    const key = titleKey(windows.find((w) => w.handle === handle)?.title ?? "");
    if (value.settings.kakaoTitleMappings?.[key])
      value.settings.kakaoTitleMappings[key].updatedAt = now;
    expected = { ok: true, value: { state: value } };
  } catch (error) {
    expected = { ok: false, error: error.message };
  }
  cases.push({
    label, operation: "remember_title_client",
    payload: { state, windows, handle, clientId, actor, now }, expected,
  });
}
store("explicit dealer selection records mapping");
store("duplicate normalized title records ambiguity", (_, windows) => {
  windows.push(chat("2", " 악기사 "));
});
store("unrelated second chat does not create ambiguity", (_, windows) => {
  windows.push(chat("2", "다른악기"));
});
store("missing selected window", (_, windows) => {
  windows[0].handle = "other";
});
store("missing selected dealer", (state) => {
  state.clients = state.clients.filter((c) => c.id !== "c2");
});
store("archived selected dealer", (state) => {
  state.clients[1].deletedAt = "2026-11-12";
});
test("original Kakao mapping and automatic dealer identity match compiled Rust", () => {
  const result = spawnSync("cargo", [
    "run", "--quiet", "--manifest-path", manifest, "--bin", "parity_runner",
  ], {
    cwd: root, input: JSON.stringify(cases), encoding: "utf8",
    timeout: 240000, maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr);
  const actual = JSON.parse(result.stdout);
  assert.equal(actual.length, cases.length);
  actual.forEach((entry, index) => {
    assert.deepStrictEqual(entry, cases[index].expected, cases[index].label);
  });
});
