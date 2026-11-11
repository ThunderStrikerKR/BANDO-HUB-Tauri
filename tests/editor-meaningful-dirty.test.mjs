import assert from "node:assert/strict";
import test from "node:test";
import { tsImport } from "tsx/esm/api";

const { sameFreightEditor, sameClientEditor, sameProductEditor, sameSettingsEditor } =
  await tsImport("../src/shared/meaningful-changes.ts", import.meta.url);

test("opening an unregistered freight rule never counts generated metadata as an edit", () => {
  const makeRule = (version) => ({
    version, at: version, maxBundle: null, maxConfirmed: false,
    perItem: null, notes: "상품의 최대 묶음 수량과 운임을 확인해 입력하세요.",
    fees: { "1": null, "2": null, "3": null },
  });
  const original = makeRule("random-id-A");
  const freshAgain = { ...makeRule("random-id-B"), fees: {} };
  assert.equal(sameFreightEditor(original, freshAgain), true);
  assert.equal(sameFreightEditor(original, { ...original, notes: original.notes + "!" }), false);
  assert.equal(sameFreightEditor(original, { ...original, maxBundle: 1 }), false);
  assert.equal(sameFreightEditor(original, { ...original, fees: { "1": 0 } }), false,
    "A confirmed zero-won delivery charge is not an unregistered charge");
  assert.equal(sameFreightEditor(original, { ...original, fees: { "1": 3000 } }), false);
  assert.equal(sameFreightEditor(original, structuredClone(original)), true);
});

test("empty optional client fields and the legacy merged tags render the same form", () => {
  const original = {
    id: "client-1", name: "검증악기", tier: "wholesale",
    payment: "PREPAID", shippingFeeExcluded: false,
    active: true, overrides: {}, shortNames: "별칭A", identifiers: "별칭B",
  };
  const displayed = { ...original,
    displayName: "", contact: "", address: "", phone: "", mobile: "",
    shortNames: "별칭A, 별칭B", identifiers: "",
  };
  assert.equal(sameClientEditor(original, displayed), true);
  assert.equal(sameClientEditor(original, { ...displayed, name: "다른 거래처" }), false);
  assert.equal(sameClientEditor(original, { ...displayed, phone: "02-1111-1111" }), false);
  assert.equal(sameClientEditor(original, { ...displayed, shippingFeeExcluded: true }), false);
});

test("optional product display strings are not fake edits but real price changes are", () => {
  const original = {
    id: "product-1", code: "BD 709", name: "BD 709",
    variants: [{ id: "price-1", color: "Black", retail: null, wholesale: 1000 }],
  };
  const displayed = { ...original, subtitle: "", shippingGroupId: "",
    variants: [{ ...original.variants[0], url: "" }] };
  assert.equal(sameProductEditor(original, displayed), true);
  assert.equal(sameProductEditor(original, { ...displayed, subtitle: "설명" }), false);
  assert.equal(sameProductEditor(original,
    { ...displayed, variants: [{ ...displayed.variants[0], retail: 0 }] }), false,
    "Zero is a real price, unlike no price");
});

test("settings compare visible optional values without ignoring real user changes", () => {
  const saved = { accounts: [], uiScale: 100 };
  const displayed = { ...saved, senderName: "반도스탠드", operatorName: "",
    senderAddress: "", senderPostcode: "", senderPhone: "", senderMobile: "",
    excelDirectory: "", factoryReplyDirectory: "", defaultAccountId: "",
    brandAccounts: { BANDOSTAND: "", BANDOMALL: "" },
  };
  assert.equal(sameSettingsEditor(saved, displayed), true);
  assert.equal(sameSettingsEditor(saved, { ...displayed, uiScale: 125 }), false);
  assert.equal(sameSettingsEditor(saved,
    { ...displayed, accounts: [{ id: "a", bank: "", number: "", holder: "" }] }), false);
  assert.equal(sameSettingsEditor(saved, { ...displayed, senderPhone: "02-1234-5678" }), false);
});
