import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const seed = JSON.parse(read("src-tauri/resources/state-seed.json"));
const normalizeColor = (value) => ({ 블랙:"Black", 검정:"Black" }[value] ?? value).trim();

function load(path, imports) {
  const output = ts.transpileModule(read(path), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exported = {};
  vm.runInNewContext(output, {
    exports: exported,
    structuredClone,
    Date, Map, Set,
    require: (p) => {
      assert.ok(Object.hasOwn(imports, p), "Unexpected module: " + p);
      return imports[p];
    },
  }, { filename: path });
  return exported;
}
const active = (products) => products.filter((p) => p.active !== false && !p.deletedAt && !p.supersededBy);
const split = load("src/sku-split.ts", {
  "./domain": { normalizeColor },
  "./product-models": { normalizeModel: (s) => s.trim(), registeredProducts: active },
  "./model-families": { validateModelSettings: () => {} },
});
const prices = load("src/catalog-price-sync.ts", {
  "./product-models": { registeredProducts: active },
});

test("303-item fixture exposes the expected reviewed multi-option candidates", () => {
  assert.equal(seed.products.length, 303);
  const candidates = split.skuSplitCandidates(seed);
  assert.equal(candidates.filter((p) => p.variants.length > 1).length, 33);
});
test("SKU splitting preserves identifiers and staff prices and does not mutate input state", () => {
  const state = structuredClone(seed);
  const p = state.products.find((p) => p.siteId === "343");
  assert.ok(p);
  p.variants[1].wholesale = 43000;
  p.variants[1].semi = 51000;
  const original = JSON.stringify(state);
  const preview = split.previewSkuSplit(state, p.id);
  assert.equal(preview.blockers.length, 0, preview.blockers.join("\n"));
  const { next, created } = split.applySkuSplit(state, preview);
  assert.equal(created, p.variants.length);
  assert.equal(JSON.stringify(state), original, "Input snapshot must not be modified");
  const archived = next.products.find((item) => item.id === p.id);
  assert.ok(archived?.supersededBy);
  const units = next.products.filter((item) => item.sourceProductId === p.id);
  assert.equal(units.length, p.variants.length);
  for (const unit of units) {
    const prior = p.variants.find((v) => v.id === unit.variants[0].id);
    assert.ok(prior);
    assert.equal(JSON.stringify(unit.variants[0]), JSON.stringify(prior));
    assert.equal(next.productMappings[p.id + "|" + prior.id], unit.id);
    assert.equal(unit.siteId, p.siteId);
  }
  assert.equal(next.products.filter((item) => item.id !== p.id && !item.sourceProductId).length,
    state.products.length - 1);
});
test("Confirmed order records remain archived while draft orders and aliases use exact SKU IDs", () => {
  const state = structuredClone(seed);
  const p = state.products.find((p) => p.siteId === "351");
  const vid = p.variants[1].id;
  const makeOrder = (id, confirmedAt) => ({
    id, confirmedAt, recipients: [{ items: [{ productId:p.id, variantId:vid }] }],
  });
  state.orders.push(makeOrder("confirmed", "2026-01-01T00:00:00.000Z"));
  state.orders.push(makeOrder("draft", undefined));
  state.aliases.push({ id: "alias", clientId:null, text:"A1", productId:p.id, variantId:vid });
  state.sourceLinks = [{
    id:"link", site:"BANDOSTAND", productNo:p.siteId,
    optionId:p.variants[1].siteOptionId, option:"", url:p.variants[1].url,
    productId:p.id, reason:"verified", verifiedAt:"2026-01-01",
  }];
  const preview=split.previewSkuSplit(state,p.id);
  assert.equal(preview.blockers.length,0,preview.blockers.join("\n"));
  const {next}=split.applySkuSplit(state,preview);
  const target=next.productMappings[p.id+"|"+vid];
  assert.equal(next.orders[0].recipients[0].items[0].productId,p.id);
  assert.equal(next.orders[1].recipients[0].items[0].productId,target);
  assert.equal(next.orders[1].recipients[0].items[0].originalProductId,p.id);
  assert.equal(next.aliases[0].productId,target);
  assert.equal(next.sourceLinks[0].productId,target);
});
test("Ambiguous aliases or missing option IDs prevent splitting", () => {
  const state=structuredClone(seed);
  const p=state.products.find((p)=>p.siteId==="351");
  state.aliases.push({ id:"ambiguous",clientId:null,text:"legacy",productId:p.id });
  const preview=split.previewSkuSplit(state,p.id);
  assert.ok(preview.blockers.some((s)=>s.includes("별칭")));
  assert.throws(()=>split.applySkuSplit(state,preview),/SKU 분리를 중단/);
});
test("Catalogue sync matches site product number and option ID, never a Cafe24 P-code", () => {
  const state=structuredClone(seed);
  const p=state.products.find((p)=>p.siteId==="343");
  const reportProduct=structuredClone(p);
  reportProduct.code="P000TEST";  // different code, same authoritative site ID and variant IDs
  reportProduct.variants[1].retail=p.variants[1].retail+3000;
  reportProduct.variants[1].officialRetail=reportProduct.variants[1].retail;
  const report={products:[reportProduct],collectedAt:"2026-12-01T00:00:00.000Z",
    categories:[],failures:[]};
  const preview=prices.previewCatalogPriceSync(state,report);
  const ready=preview.rows.filter((r)=>r.status==="READY");
  assert.equal(ready.length,1);
  assert.equal(ready[0].variantId,p.variants[1].id);
  const {next,updated}=prices.applyCatalogPriceSync(state,report,preview);
  assert.equal(updated,1);
  const newP=next.products.find((x)=>x.id===p.id);
  assert.equal(newP.variants[1].retail,p.variants[1].retail+3000);
  assert.equal(newP.variants[0].retail,p.variants[0].retail);
  assert.equal(newP.variants[1].wholesale,p.variants[1].wholesale);
  assert.equal(newP.variants[1].semi,p.variants[1].semi);
  assert.equal(newP.priceHistory.at(-1).field,p.variants[1].id+".retail");
});
test("Catalogue sync rejects an altered official option ID, stale approval and manual prices", () => {
  const state=structuredClone(seed);
  const p=state.products.find((p)=>p.siteId==="343");
  const reportProduct=structuredClone(p);
  reportProduct.variants[0].retail+=1000;
  reportProduct.variants[0].officialRetail=reportProduct.variants[0].retail;
  reportProduct.variants[0].siteOptionId="ALTERED";
  const report={products:[reportProduct],collectedAt:"2026-12-01T00:00:00.000Z",
    categories:[],failures:[]};
  let preview=prices.previewCatalogPriceSync(state,report);
  assert.equal(preview.rows[0].status,"HOLD");
  reportProduct.variants[0].siteOptionId=p.variants[0].siteOptionId;
  preview=prices.previewCatalogPriceSync(state,report);
  assert.equal(preview.rows[0].status,"READY");
  assert.throws(()=>prices.applyCatalogPriceSync({...state,revision:2},report,preview),
    /데이터가 변경/);
  const manual=structuredClone(state);
  manual.products.find((x)=>x.id===p.id).variants[0].source="MANUAL";
  assert.equal(prices.previewCatalogPriceSync(manual,report).rows[0].status,"HOLD");
});
test("Legacy Rust catalogue approval cannot bypass UI safety checks", () => {
  const native=read("src-tauri/src/lib.rs");
  const ui=read("src/ManagementUI.tsx");
  assert.match(native,/fn catalog_approve\(_db: State<'_, Database>\)/);
  assert.match(native,/이전 방식의 일괄 승인은 안전하지 않아 중지/);
  assert.doesNotMatch(ui,/approveCatalog\(\)/);
  assert.match(ui,/applyCatalogPriceSync\(current, report, review\)/);
  assert.match(ui,/await window\.bando!\.backup\(\)/);
  assert.match(ui,/await onSave\(next\)/);
});
test("SKU split is wired into product synchronization behind review and backup", () => {
  const parent=read("src/ProductManager.tsx");
  const panel=read("src/SkuSplitPanel.tsx");
  assert.match(parent,/<SkuSplitPanel state=\{state\} onSave=\{onSave\}/);
  assert.match(panel,/previewSkuSplit\(state, id\)/);
  assert.match(panel,/applySkuSplit\(latest, preview\)/);
  assert.match(panel,/await window\.bando!\.backup\(\)/);
  assert.match(panel,/await onSave\(next\)/);
});

test("Every variant sharing a duplicate official option ID is held", () => {
  const state = structuredClone(seed);
  const p = state.products.find((x) => x.siteId === "343");
  const incoming = structuredClone(p);
  incoming.variants[1].siteOptionId = incoming.variants[0].siteOptionId;
  incoming.variants[1].retail += 9000;
  incoming.variants[1].officialRetail = incoming.variants[1].retail;
  const report = { products:[incoming], categories:[], failures:[],
    collectedAt:"2026-12-01T00:00:00.000Z" };
  const preview = prices.previewCatalogPriceSync(state,report);
  assert.equal(preview.rows[0].status,"HOLD");
  assert.equal(preview.rows[1].status,"HOLD");
});

test("Existing conflicting option mapping prevents SKU conversion", () => {
  const state=structuredClone(seed);
  const p=state.products.find((x)=>x.siteId==="343");
  state.productMappings = { [p.id+"|"+p.variants[0].id]: "existing-sku-elsewhere" };
  const preview=split.previewSkuSplit(state,p.id);
  assert.ok(preview.blockers.some((reason)=>reason.includes("연결 이력")));
});


test("In-house multi-option products split into SKUs without any homepage linkage", () => {
  const state = structuredClone(seed);
  const original = structuredClone(state.products.find((p) => p.siteId === "343"));
  original.id = "in-house-custom-stand";
  original.name = "자체 제작 보면대";
  original.code = "CUSTOM-STAND";
  original.saleUnit = false;
  delete original.siteId;
  delete original.siteRefs;
  delete original.siteCode;
  original.variants = original.variants.slice(0, 2).map((variant, index) => {
    const v = {
      ...variant,
      id: "internal-option-" + index,
      source: "MANUAL",
      url: "",
      wholesale: index === 0 ? 50000 : 60000,
      semi: index === 0 ? 55000 : 65000,
      retail: index === 0 ? 80000 : 90000,
    };
    delete v.siteOptionId;
    delete v.siteProductId;
    return v;
  });
  state.products.push(original);
  const review = split.previewSkuSplit(state, original.id);
  assert.deepEqual(Array.from(review.blockers), []);
  const { next, created } = split.applySkuSplit(state, review);
  assert.equal(created, 2);
  const products = next.products.filter((p) => p.sourceProductId === original.id);
  assert.equal(products.length, 2);
  assert.ok(products.every((p) => !p.siteId && !p.variants[0].siteOptionId));
  assert.deepEqual(products.map((p) => p.variants[0].wholesale), [50000, 60000]);
  assert.deepEqual(products.map((p) => p.variants[0].retail), [80000, 90000]);
});

test("Manual product UI supports option creation without assigning a website URL", () => {
  const ui = read("src/ProductManager.tsx");
  assert.match(ui, /const manualOptionEditor = !!edit && !edit\.sourceProductId/);
  assert.match(ui, /판매 옵션 추가/);
  assert.match(ui, /source: "MANUAL"/);
  assert.match(ui, /p\.saleUnit = p\.variants\.length === 1/);
  assert.match(ui, /홈페이지 등록 없이 직접 상품과 옵션을 관리/);
  assert.match(ui, /defaultColor: index === 0 \? color : prev\.defaultColor/);
});
