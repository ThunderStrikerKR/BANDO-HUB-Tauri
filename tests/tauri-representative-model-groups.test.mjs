import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { tsImport } from "tsx/esm/api";

const source = path => readFileSync(new URL("../" + path, import.meta.url), "utf8");
const seed = JSON.parse(source("src-tauri/resources/state-seed.json"));
const byCode = code => seed.products.find(p => p.code === code);
const fixture = (name, products, representative) => {
  const state = structuredClone(seed);
  state.settings.colorGuidanceGroups = {
    staff: { name, productIds: products.map(p => p.id), representativeProductId: representative.id },
  };
  return state;
};

test("709 and 709-1 form one model group even though both are Black", async () => {
  const { validateModelGroups, suggestGroupRepresentative } =
    await tsImport("../src/model-groups.ts", import.meta.url);
  const perforated = byCode("BD 709"), plain = byCode("BD 709-1");
  assert.ok(perforated && plain);
  assert.equal(perforated.variants[0].color, plain.variants[0].color);
  const state = fixture("709 상판 선택", [perforated, plain], perforated);
  const original = JSON.stringify(state.products);
  assert.doesNotThrow(() => validateModelGroups(state));
  assert.equal(JSON.stringify(state.products), original);
  assert.deepEqual(
    suggestGroupRepresentative(state, [perforated, plain]),
    { groupId: "staff", productId: perforated.id, productName: perforated.name },
  );
  assert.equal(suggestGroupRepresentative(state, [plain]), undefined,
    "Unambiguous orders must not be redirected to the representative");
});

test("all cable-holder sizes form one group even with no registered color", async () => {
  const { validateModelGroups } = await tsImport("../src/model-groups.ts", import.meta.url);
  const sizes = seed.products.filter(p => p.name.startsWith("케이블홀더 / "));
  assert.equal(sizes.length, 4);
  assert.ok(sizes.every(p => p.variants[0].color === "색상 미표기"));
  const state = fixture("케이블홀더 크기", sizes, sizes[0]);
  assert.doesNotThrow(() => validateModelGroups(state));
});

test("red, black and glow-in-the-dark microphone wall holders are valid despite prices and missing color", async () => {
  const { validateModelGroups, suggestGroupRepresentative } =
    await tsImport("../src/model-groups.ts", import.meta.url);
  const wall = seed.products.filter(p => p.name.includes("마이크 벽걸이 홀더"));
  assert.equal(wall.length, 3);
  const glow = wall.find(p => p.name.includes("야광"));
  const black = wall.find(p => p.name.includes("블랙"));
  assert.ok(glow && black);
  assert.equal(glow.variants[0].color, "색상 미표기");
  assert.equal(glow.variants[0].retail, 7000);
  assert.equal(black.variants[0].retail, 6000);
  const state = fixture("마이크 벽걸이 홀더", wall, black);
  assert.doesNotThrow(() => validateModelGroups(state));
  assert.equal(suggestGroupRepresentative(state, wall)?.productId, black.id);
});

test("model groups reject unknown or duplicate members, outside representatives and overlaps", async () => {
  const { validateModelGroups } = await tsImport("../src/model-groups.ts", import.meta.url);
  const a = byCode("BD 709"), b = byCode("BD 709-1");
  const state = fixture("보면대", [a, b], a);
  assert.doesNotThrow(() => validateModelGroups(state));
  state.settings.colorGuidanceGroups.staff.representativeProductId = "missing";
  assert.throws(() => validateModelGroups(state), /대표모델/);
  state.settings.colorGuidanceGroups.staff.representativeProductId = a.id;
  state.settings.colorGuidanceGroups.staff.productIds.push(a.id);
  assert.throws(() => validateModelGroups(state), /중복/);
  state.settings.colorGuidanceGroups.staff.productIds.pop();
  state.settings.colorGuidanceGroups.other = {
    name: "다른 모델군", productIds: [a.id, b.id], representativeProductId: b.id,
  };
  assert.throws(() => validateModelGroups(state), /하나의 모델군/);
});

test("old color groups persist without automatically becoming a chosen representative SKU", async () => {
  const { validateModelGroups, suggestGroupRepresentative } =
    await tsImport("../src/model-groups.ts", import.meta.url);
  const a = byCode("BD 709"), b = byCode("BD 709-1");
  const legacy = structuredClone(seed);
  legacy.settings.colorGuidanceGroups = {
    previous: { name: "이전 색상 그룹", productIds: [a.id, b.id], representativeColor: "Black" },
  };
  assert.doesNotThrow(() => validateModelGroups(legacy));
  assert.equal(suggestGroupRepresentative(legacy, [a, b]), undefined);
});

test("representative-model notices are generated only from employee selection evidence", async () => {
  const { appliedRepresentativeModelNotice } =
    await tsImport("../src/model-groups.ts", import.meta.url);
  const a = byCode("BD 709"), b = byCode("BD 709-1");
  const item = { productId: a.id, name: a.name };
  assert.equal(appliedRepresentativeModelNotice(item), "");
  item.appliedRepresentativeModel = { groupId: "staff", productId: a.id, productName: a.name };
  assert.equal(appliedRepresentativeModelNotice(item), a.name + " 모델로 보내드릴게요.");
  assert.equal(appliedRepresentativeModelNotice({ ...item, productId: b.id }), "");
  assert.equal(appliedRepresentativeModelNotice(item,{
    automaticMessageTemplates: { modelRepresentative: "{상품명}으로 출고하겠습니다." },
  }), a.name + "으로 출고하겠습니다.");
});

test("model-group UI, employee resolver, Rust persistence and messages use product IDs", () => {
  const ui = source("src/ColorGuidanceManager.tsx");
  const resolver = source("src/IssueResolver.tsx");
  const native = source("src-tauri/src/lib.rs");
  assert.match(ui, /active\.representativeProductId===id/);
  assert.match(ui, /g\[activeId\]\.representativeProductId=id/);
  assert.match(ui, /대표 지정/);
  assert.match(ui, /className="family-representative-tag"/);
  assert.match(ui, /"catalog_clients","validate_model_groups"/);
  assert.doesNotMatch(ui, /validateModelGroups\(draft\)/);
  assert.doesNotMatch(ui, /id="representative-color"/);
  assert.match(resolver, /"suggest_group_representative"/);
  assert.doesNotMatch(resolver, /suggestGroupRepresentative\(state,/);
  assert.match(resolver, /대표모델.*선택/);
  assert.match(native, /group\.get\("representativeProductId"\)/);
  assert.match(native, /modelRepresentative/);
  assert.match(source("src/issue-actions.ts"), /appliedRepresentativeModel/);
  assert.match(source("src/hub-messages.ts"), /appliedRepresentativeModelNotice/);
  assert.match(source("src/automatic-message.ts"), /appliedRepresentativeModelNotice/);
  assert.match(source("src/ProductManager.tsx"), /"모델군 관리"/);
});

test("model-group editor places group name, add search and members in order with a safe Save / Close flow", () => {
  const ui = source("src/ColorGuidanceManager.tsx");
  const editor = ui.slice(ui.indexOf('className="family-editor-scroll"'));
  const groupName = editor.indexOf('<Field label="그룹 이름">');
  const add = editor.indexOf('<h3>상품 추가</h3>');
  const members = editor.indexOf('<h3>등록한 상품</h3>');
  assert.ok(groupName >= 0 && groupName < add && add < members);
  assert.doesNotMatch(ui, /변경 취소|id="representative-product"/);
  assert.match(ui, /<Button disabled=\{busy\} onClick=\{\(\)=>void closeEditor\(\)\}>닫기<\/Button>/);
  assert.match(ui, /\{unsaved && <Button variant="primary" disabled=\{busy\}/);
  assert.match(ui, /requestEditorLeave\(leaveGuard, setStatus\)/);
  assert.match(ui, /setDraft\(structuredClone\(baseline\)\)/);
  assert.doesNotMatch(ui, /setDraft\(structuredClone\(state\)\);setBaseline\(structuredClone\(state\)\);setSelected\(" "\)/);
  assert.match(ui, /const activeId=selected && groups\[selected\]\?selected:""/);
});

test("employee applying a representative model records exact product identity and a declarative notice", async () => {
  const { parseSmart } = await tsImport("../src/parser.ts", import.meta.url);
  const { resolveProduct } = await tsImport("../src/issue-actions.ts", import.meta.url);
  const { suggestGroupRepresentative, appliedRepresentativeModelNotice } =
    await tsImport("../src/model-groups.ts", import.meta.url);
  const state = structuredClone(seed);
  const black = state.products.find(p => p.siteId === "245");
  const silver = state.products.find(p => p.siteId === "254");
  const client = {
    id: "group-test-client", name: "가상 거래처", contact: "", identifiers: "",
    active: true, tier: "wholesale", shippingFeeExcluded: false,
    payment: "PREPAID", overrides: {},
  };
  state.clients.push(client);
  state.settings.colorGuidanceGroups = {
    staff: { name: "Desk JS-2", productIds: [black.id, silver.id],
      representativeProductId: black.id },
  };
  const recipients = parseSmart("BD Desk JS-2 3개", client, state);
  const item = recipients.flatMap(r => r.items).find(i => i.raw.includes("JS-2"));
  assert.ok(item);
  assert.equal(item.productId, null);
  const candidates = (item.productCandidates ?? [])
    .map(candidate => state.products.find(p => p.id === candidate.productId))
    .filter(Boolean);
  assert.equal(suggestGroupRepresentative(state, candidates)?.productId, black.id);
  const order = { id: "representative-order", clientId: client.id,
    recipients: [{ id: "recipient", items: [item] }] };
  const applied = resolveProduct(state, order, "recipient", item.id, black.id,
    "once", false, black.variants[0].id, "staff");
  const selected = applied.order.recipients[0].items[0];
  assert.equal(selected.productId, black.id);
  assert.equal(selected.variantId, black.variants[0].id);
  assert.equal(selected.appliedRepresentativeModel.productId, black.id);
  assert.equal(selected.appliedDefaultColor, undefined);
  assert.equal(appliedRepresentativeModelNotice(selected), black.name + " 모델로 보내드릴게요.");
  assert.equal(selected.modelProposal, undefined);
  assert.throws(() => resolveProduct(state, order, "recipient", item.id, silver.id,
    "once", false, silver.variants[0].id, "staff"), /대표모델/);
});
