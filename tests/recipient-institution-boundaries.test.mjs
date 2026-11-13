import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { tsImport } from "tsx/esm/api";

const { parseEvidence } = await tsImport("../src/parser.ts", import.meta.url);
const state = JSON.parse(readFileSync(
  new URL("../src-tauri/resources/state-seed.json", import.meta.url), "utf8"));
const client = {
  id: "ci-recipient", name: "합성 거래처", active: true, tier: "wholesale",
  payment: "PREPAID", identifiers: "", overrides: {}, shippingFeeExcluded: false,
};

// Do not mistake an organization appended to a street address for another
// recipient. Keep the organization as part of the original address.
for (const institution of ["가상교회", "가상학교", "가상성당", "가상병원", "가상학원"]) {
  test("address institution stays with the named recipient: " + institution, () => {
    const raw = [
      "BD 709 (블랙) 1개",
      "김가상",
      "010-1234-5678",
      "서울특별시 송파구 석촌호수로 162 " + institution,
    ].join("\n");
    const { recipients } = parseEvidence(raw, client, state);
    assert.equal(recipients.length, 1, "An address must not split a delivery");
    assert.equal(recipients[0].name, "김가상");
    assert.ok(recipients[0].address.includes(institution),
      "Keep the institution in the delivery address");
    assert.equal(recipients[0].mobile, "010-1234-5678");
    assert.deepEqual(recipients[0].items.map(item => item.quantity), [1]);
  });

  test("explicit standalone institution can still receive a delivery: " + institution, () => {
    const raw = [
      "BD 709 (블랙) 1개",
      institution,
      "서울특별시 송파구 석촌호수로 162",
      "010-1234-5678",
    ].join("\n");
    const { recipients } = parseEvidence(raw, client, state);
    assert.equal(recipients.length, 1);
    assert.equal(recipients[0].name, institution,
      "Do not drop valid institution-only recipients");
    assert.ok(recipients[0].address.includes("석촌호수로"));
    assert.equal(recipients[0].mobile, "010-1234-5678");
    assert.deepEqual(recipients[0].items.map(item => item.quantity), [1]);
  });
}
