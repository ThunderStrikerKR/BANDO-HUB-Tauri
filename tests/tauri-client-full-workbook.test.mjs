import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { webcrypto } from "node:crypto";

const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const output = ts.transpileModule(read("src/client-workbook.ts"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const mod = {};
vm.runInNewContext(output, { exports: mod, crypto: webcrypto, structuredClone },
  { filename: "client-workbook.ts" });

const baseClient = (id, overrides = {}) => ({
  id, name: "기존 대리점", displayName: "", address: "서울 종로구 1",
  phone: "02-123-4567", mobile: "", person: "", contact: "",
  identifiers: "", shortNames: "", tier: "wholesale", payment: "PREPAID",
  shippingFeeExcluded: false, active: true, overrides: { "test-option": 13500 },
  ...overrides,
});
const baseState = () => ({
  revision: 7, products: [], clients: [
    baseClient("client-A"),
    baseClient("client-B", { name: "다른 대리점", phone: "02-999-8888" }),
  ],
  aliases: [], orders: [{ id: "order-keep", recipients: [] }],
  settings: { accounts: [{ id: "acc1", bank: "은행", holder: "반도" }] },
});
const values = (id, name, options = {}) => {
  const cells = new Array(mod.CLIENT_HEADERS.length).fill("");
  cells[0] = id;
  cells[1] = name;
  cells[3] = options.address ?? "";
  cells[5] = options.phone ?? "";
  cells[9] = options.tier ?? "";
  cells[10] = options.payment ?? "";
  cells[11] = options.shipping ?? "";
  cells[12] = options.vat ?? "";
  cells[13] = options.active ?? "";
  cells[15] = options.identifiers ?? "";
  return cells;
};

test("client workbook has a stable non-editable key and exports all business fields", () => {
  assert.equal(mod.CLIENT_HEADERS[0], "__거래처ID");
  assert.ok(mod.CLIENT_HEADERS.includes("거래처 별칭"));
  assert.ok(mod.CLIENT_HEADERS.includes("주 사용 계좌 ID"));
  assert.ok(mod.CLIENT_HEADERS.includes("보관 상태"));
  assert.match(read("src/client-workbook.ts"), /for \(const client of state\.clients\) sheet\.addRow/);
  assert.match(read("src/client-workbook.ts"), /for \(const \[variantId, amount\] of Object\.entries\(client\.overrides/);
});

test("same-ID update and ID-less addition retain orders, prior prices and IDs", () => {
  const state = baseState();
  const original = JSON.stringify(state);
  const preview = mod.previewClientRows(state, 7, [
    { row: 2, cells: values("client-A", "기존 대리점", { address: "서울 종로구 7" }) },
    { row: 3, cells: values("client-B", "다른 대리점") },
    { row: 4, cells: values("", "새로운 대리점", { address: "인천 남동구 3", phone: "032-111-2222" }) },
  ]);
  assert.deepEqual(Array.from(preview.rows, (row) => row.status), ["UPDATE", "UNCHANGED", "ADD"]);
  assert.equal(preview.missing, 0);
  const { next, created, updated } = mod.applyClientWorkbook(state, preview);
  assert.equal(created, 1);
  assert.equal(updated, 1);
  assert.equal(next.clients.length, 3);
  assert.equal(next.clients[0].id, "client-A");
  assert.equal(next.clients[0].address, "서울 종로구 7");
  assert.equal(next.clients[0].overrides["test-option"], 13500);
  assert.equal(next.orders[0].id, "order-keep");
  assert.equal(JSON.stringify(state), original, "Old DB input should not be mutated");
});

test("omitting an existing client never deletes or deactivates it", () => {
  const state = baseState();
  const preview = mod.previewClientRows(state, 7, [
    { row: 2, cells: values("client-A", "기존 대리점", { address: "서울 종로구 8" }) },
  ]);
  assert.equal(preview.missing, 1);
  const { next } = mod.applyClientWorkbook(state, preview);
  assert.equal(next.clients.length, 2);
  assert.equal(next.clients[1].active, true);
  assert.equal(next.clients[1].name, "다른 대리점");
});

test("duplicate phone, unknown ID, and duplicate IDs block the workbook", () => {
  const state = baseState();
  const duplicated = mod.previewClientRows(state, 7, [
    { row: 2, cells: values("", "의심 거래처", { address: "인천 남동구 3", phone: "02-123-4567" }) },
  ]);
  assert.equal(duplicated.rows[0].status, "HOLD");
  assert.throws(() => mod.applyClientWorkbook(state, duplicated), /중복 또는 오류/);
  const unknown = mod.previewClientRows(state, 7, [
    { row: 2, cells: values("spoofed-ID", "의심 거래처") },
  ]);
  assert.equal(unknown.rows[0].status, "ERROR");
  const repeated = mod.previewClientRows(state, 7, [
    { row: 2, cells: values("client-A", "기존 대리점") },
    { row: 3, cells: values("client-A", "기존 대리점") },
  ]);
  assert.equal(repeated.rows[1].status, "ERROR");
});

test("edited download from stale revision is rejected before commit", () => {
  const state = baseState();
  assert.throws(() => mod.previewClientRows(state, 6, []), /데이터가 바뀌었습니다/);
  const preview = mod.previewClientRows(state, 7, [
    { row: 2, cells: values("client-A", "기존 대리점", { address: "서울 종로구 8" }) },
  ]);
  assert.throws(() => mod.applyClientWorkbook({ ...state, revision: 8 }, preview),
    /검토 후 거래처 데이터가 변경/);
});

test("archived clients and optional legacy undefined fields survive round trips", () => {
  const state = baseState();
  state.clients[0] = baseClient("client-A", { deletedAt: "2026-01-01T00:00:00Z",
    defaultApplyVat: undefined, displayName: undefined });
  const row = values("client-A", "기존 대리점", { active: "거래중" });
  row[17] = "보관";
  const preview = mod.previewClientRows(state, 7, [{ row: 2, cells: row }]);
  assert.equal(preview.rows[0].status, "UNCHANGED", preview.rows[0].errors.join("/"));
  assert.equal(preview.missing, 1);
});

test("blank cells retain existing values; explicit clear marker removes optional fields", () => {
  const state = baseState();
  state.clients[0].shortNames = "별칭1";
  const retain = mod.previewClientRows(state, 7, [
    { row: 2, cells: values("client-A", "기존 대리점", { address: "서울 종로구 9" }) },
  ]);
  assert.equal(retain.rows[0].client.shortNames, "별칭1");
  const clearCells = values("client-A", "기존 대리점", { address: "서울 종로구 9" });
  clearCells[14] = "[비우기]";
  const clear = mod.previewClientRows(state, 7, [{ row: 2, cells: clearCells }]);
  assert.equal(clear.rows[0].client.shortNames, "");
});

test("client Excel is native saved, previewed, backed up, and revision checked", () => {
  const rust = read("src-tauri/src/lib.rs");
  const bridge = read("src/tauri-bridge.ts");
  const manager = read("src/ClientManager.tsx");
  const ui = read("src/ClientWorkbookTools.tsx");
  assert.match(rust, /async fn save_client_workbook/);
  assert.match(rust, /save_client_workbook,\s*save_product_sync_workbook,/);
  assert.match(bridge, /invoke<string \| null>\("save_client_workbook"/);
  assert.match(manager, /<ClientWorkbookTools onSave=\{onSave\}/);
  assert.match(ui, /await exportClientWorkbook\(current\)/);
  const adapter=read("src/native-client-workbook.ts");
  const native=read("src-tauri/src/business_core/catalog_clients/client_preview.rs");
  assert.match(ui, /await previewNativeClientWorkbook\(current, file\)/);
  assert.match(adapter, /"catalog_clients", "preview_client_rows"/);
  assert.match(native, /fn collision\(/);
  assert.match(ui, /await window\.bando!\.backup\(\)/);
  assert.match(ui, /await onSave\(next\)/);
  assert.doesNotMatch(manager, /<BulkTools kind="clients"/);
});

test("address updates remain available for historical shared-phone clients", () => {
  const state = baseState();
  state.clients[1].phone = state.clients[0].phone;
  const preview = mod.previewClientRows(state, 7, [
    { row: 2, cells: values("client-A", "기존 대리점", { address: "서울 종로구 55" }) },
  ]);
  assert.equal(preview.rows[0].status, "UPDATE");
  assert.equal(mod.applyClientWorkbook(state, preview).updated, 1);
});

test("new clients sharing another client's mobile phone are flagged", () => {
  const state = baseState();
  state.clients[0].mobile = "010-5555-2222";
  const cells = values("", "새 지점", { address: "경기 고양시 2", phone: "" });
  cells[6] = "010-5555-2222";
  const preview = mod.previewClientRows(state, 7, [{ row: 2, cells }]);
  assert.equal(preview.rows[0].status, "HOLD");
});

test("unchanged legacy clients missing newly-required contact fields do not block updates", () => {
  const state = baseState();
  state.clients[1].address = "";
  state.clients[1].phone = "";
  const preview = mod.previewClientRows(state, 7, [
    { row: 2, cells: values("client-B", "다른 대리점") },
    { row: 3, cells: values("client-A", "기존 대리점", { address: "서울 종로구 88" }) },
  ]);
  assert.deepEqual(Array.from(preview.rows, (row) => row.status), ["UNCHANGED", "UPDATE"]);
  const { next } = mod.applyClientWorkbook(state, preview);
  assert.equal(next.clients[1].address, "");
});
