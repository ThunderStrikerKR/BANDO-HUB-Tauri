import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { tsImport } from "tsx/esm/api";

/**
 * Exactly 11 previously audited length-dependent name recognition sites.
 * P01 parser.ts person() bare name; P02 embedded district/road name;
 * P03 address trailing token; E04 standalone institution; E05 parenthesis;
 * E06 labelled name; E07 two-part honorific; E08 product-row remainder;
 * E09 bare name + phone; E10 phone-adjacent name; D11 legacy name fallback.
 * Synthetic samples were authored afresh, never created by replacing words
 * inside real customer orders. Test failure records an unresolved defect.
 * This suite does not test OCR, product master matching, or freight.
 */
const state=JSON.parse(readFileSync(
  new URL("../src-tauri/resources/state-seed.json",import.meta.url),"utf8"));
const {parseEvidence}=await tsImport("../src/parser.ts",import.meta.url);
const {parseLegacy:parseLegacyDomain}=await tsImport("../src/domain.ts",import.meta.url);
const dealer={id:"name11-dealer",name:"합성 거래처",tier:"wholesale",
  active:true,payment:"PREPAID",overrides:{},identifiers:"",
  shippingFeeExcluded:false};

const fixtures=[
  {
    "id": "P01",
    "label": "person() legitimate name ending 호",
    "raw": "BD 709 (블랙) 1개\n김수호\n010-1234-5678\n서울특별시 송파구 석촌호수로 162",
    "names": [
      "김수호"
    ],
    "addresses": [
      "석촌호수로 162"
    ],
    "legacy": false,
    "source": "src/parser.ts"
  },
  {
    "id": "P01-B",
    "label": "ordinary standalone name",
    "raw": "BD 709 (블랙) 1개\n김민수\n010-1234-5678\n서울특별시 송파구 석촌호수로 162",
    "names": [
      "김민수"
    ],
    "addresses": [
      "석촌호수로 162"
    ],
    "legacy": false,
    "source": "src/parser.ts"
  },
  {
    "id": "P02",
    "label": "name embedded between district and road",
    "raw": "BD 709 (블랙) 1개\n서울특별시 송파구 김수호 석촌호수로 162\n010-1234-5678",
    "names": [
      "김수호"
    ],
    "addresses": [
      "석촌호수로 162"
    ],
    "legacy": false,
    "source": "src/parser.ts"
  },
  {
    "id": "P03",
    "label": "five-syllable library at end of address is not name",
    "raw": "BD 709 (블랙) 1개\n김민수\n010-1234-5678\n서울특별시 송파구 석촌호수로 162 중앙도서관",
    "names": [
      "김민수"
    ],
    "addresses": [
      "석촌호수로 162 중앙도서관"
    ],
    "legacy": false,
    "source": "src/parser.ts"
  },
  {
    "id": "P03-B",
    "label": "short church at end of address stays there",
    "raw": "BD 709 (블랙) 1개\n김민수\n010-1234-5678\n서울특별시 송파구 석촌호수로 162 가상교회",
    "names": [
      "김민수"
    ],
    "addresses": [
      "석촌호수로 162 가상교회"
    ],
    "legacy": false,
    "source": "src/parser.ts"
  },
  {
    "id": "E04",
    "label": "standalone six-character church is recipient",
    "raw": "BD 709 (블랙) 1개\n한빛중앙교회\n서울특별시 송파구 석촌호수로 162\n010-1234-5678",
    "names": [
      "한빛중앙교회"
    ],
    "addresses": [
      "석촌호수로 162"
    ],
    "legacy": false,
    "source": "src/order-evidence.ts"
  },
  {
    "id": "E04-B",
    "label": "standalone four-character church is recipient",
    "raw": "BD 709 (블랙) 1개\n가상교회\n서울특별시 송파구 석촌호수로 162\n010-1234-5678",
    "names": [
      "가상교회"
    ],
    "addresses": [
      "석촌호수로 162"
    ],
    "legacy": false,
    "source": "src/order-evidence.ts"
  },
  {
    "id": "E05",
    "label": "four-character parenthesized name before address",
    "raw": "BD 709 (블랙) 1개\n(남궁민수) 서울특별시 송파구 석촌호수로 162\n010-1234-5678",
    "names": [
      "남궁민수"
    ],
    "addresses": [
      "석촌호수로 162"
    ],
    "legacy": false,
    "source": "src/order-evidence.ts"
  },
  {
    "id": "E06",
    "label": "explicit recipient name ending 호 with inline contact",
    "raw": "BD 709 (블랙) 1개\n수령자: 김수호 연락처: 010-1234-5678\n서울특별시 송파구 석촌호수로 162",
    "names": [
      "김수호"
    ],
    "addresses": [
      "석촌호수로 162"
    ],
    "legacy": false,
    "source": "src/order-evidence.ts"
  },
  {
    "id": "E06-B",
    "label": "explicit institution name with inline contact",
    "raw": "BD 709 (블랙) 1개\n수취인명: 한빛중앙교회 연락처: 010-1234-5678\n서울특별시 송파구 석촌호수로 162",
    "names": [
      "한빛중앙교회"
    ],
    "addresses": [
      "석촌호수로 162"
    ],
    "legacy": false,
    "source": "src/order-evidence.ts"
  },
  {
    "id": "E07",
    "label": "two-part name with honorific",
    "raw": "BD 709 (블랙) 1개\n남궁 민수님\n서울특별시 송파구 석촌호수로 162\n010-1234-5678",
    "names": [
      "남궁 민수"
    ],
    "addresses": [
      "석촌호수로 162"
    ],
    "legacy": false,
    "source": "src/order-evidence.ts"
  },
  {
    "id": "E08",
    "label": "personal name on product and quantity row",
    "raw": "BD 709 (블랙) 1개 김민수\n010-1234-5678\n서울특별시 송파구 석촌호수로 162",
    "names": [
      "김민수"
    ],
    "addresses": [
      "석촌호수로 162"
    ],
    "legacy": false,
    "source": "src/order-evidence.ts"
  },
  {
    "id": "E09",
    "label": "name ending 호 with same-line phone",
    "raw": "BD 709 (블랙) 1개\n김수호 010-1234-5678\n서울특별시 송파구 석촌호수로 162",
    "names": [
      "김수호"
    ],
    "addresses": [
      "석촌호수로 162"
    ],
    "legacy": false,
    "source": "src/order-evidence.ts"
  },
  {
    "id": "E09-B",
    "label": "institution with same-line phone",
    "raw": "BD 709 (블랙) 1개\n가상교회 010-1234-5678\n서울특별시 송파구 석촌호수로 162",
    "names": [
      "가상교회"
    ],
    "addresses": [
      "석촌호수로 162"
    ],
    "legacy": false,
    "source": "src/order-evidence.ts"
  },
  {
    "id": "E10",
    "label": "name after phone on mixed line",
    "raw": "BD 709 (블랙) 1개\n010-1234-5678 김수호\n서울특별시 송파구 석촌호수로 162",
    "names": [
      "김수호"
    ],
    "addresses": [
      "석촌호수로 162"
    ],
    "legacy": false,
    "source": "src/order-evidence.ts"
  },
  {
    "id": "E10-B",
    "label": "name before phone with trailing memo",
    "raw": "BD 709 (블랙) 1개\n김민수 010-1234-5678 / 메모: 문앞\n서울특별시 송파구 석촌호수로 162",
    "names": [
      "김민수"
    ],
    "addresses": [
      "석촌호수로 162"
    ],
    "legacy": false,
    "source": "src/order-evidence.ts"
  },
  {
    "id": "D11",
    "label": "legacy parser bare name ending 호",
    "raw": "BD 709 (블랙) 1개\n김수호\n010-1234-5678\n주소: 서울특별시 송파구 석촌호수로 162",
    "names": [
      "김수호"
    ],
    "addresses": [
      "석촌호수로 162"
    ],
    "legacy": true,
    "source": "src/domain.ts"
  },
  {
    "id": "D11-B",
    "label": "legacy parser explicit institution name",
    "raw": "BD 709 (블랙) 1개\n수취인명: 한빛중앙교회\n010-1234-5678\n주소: 서울특별시 송파구 석촌호수로 162",
    "names": [
      "한빛중앙교회"
    ],
    "addresses": [
      "석촌호수로 162"
    ],
    "legacy": true,
    "source": "src/domain.ts"
  }
];

const coreIds=[...new Set(fixtures.map(c=>c.id.split("-")[0]))].sort();
assert.deepEqual(coreIds,[
  "D11","E04","E05","E06","E07","E08","E09","E10","P01","P02","P03"
].sort(),"The 11 audited conditions must be covered");
for(const fixture of fixtures){
  test("NAME11_"+fixture.id+" "+fixture.label,()=>{
    const recipients=fixture.legacy
      ? parseLegacyDomain(fixture.raw,dealer,state)
      : parseEvidence(fixture.raw,dealer,state).recipients;
    const result={
      id:fixture.id,source:fixture.source,
      expectedDeliveries:fixture.names.length,
      actualDeliveries:recipients.length,
      expectedNames:fixture.names,
      actualNames:recipients.map(r=>r.name),
      addresses:recipients.map(r=>r.address),
      contacts:recipients.map(r=>[r.phone,r.mobile].filter(Boolean)),
      items:recipients.map(r=>r.items.map(i=>({name:i.name,quantity:i.quantity}))),
    };
    console.log("NAME11_RESULT "+JSON.stringify(result));
    assert.equal(recipients.length,fixture.names.length,
      "Unexpected shipping split caused by a name-like token");
    assert.deepEqual(recipients.map(r=>r.name),fixture.names,
      "Recipient identity must not be decided from length alone");
    for(let i=0;i<recipients.length;i++){
      assert.ok(recipients[i].address.includes(fixture.addresses[i]),
        "Destination address must preserve an institution/building");
      assert.ok(recipients[i].phone||recipients[i].mobile,
        "Recipient must retain a contact number");
    }
  });
}
