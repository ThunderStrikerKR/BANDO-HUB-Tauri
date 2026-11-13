import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import ExcelJS from "exceljs";
import { webcrypto } from "node:crypto";
import { createRequire } from "node:module";

const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const require = createRequire(import.meta.url);
const compiled = ts.transpileModule(read("src/factory-export.ts"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
const exported = {};
const referenceCode = ts.transpileModule(read("src/historical-product-reference.ts"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const referenceExports = {};
vm.runInThisContext("(function(exports) {\n" + referenceCode + "\n})")(referenceExports);
const load = vm.runInThisContext("(function(exports, require, crypto, structuredClone) {\n" + compiled + "\n})");
load(exported, (id) => id === "./historical-product-reference.js" ? referenceExports : require(id),
  webcrypto, structuredClone);
const { previewFactoryExport, createFactoryWorkbook, recordFactoryExport, LOGEN_HEADERS } = exported;

function stateFixture() {
  const sender = { id:"client1", name:"예시대리점", displayName:"예시악기", address:"인천 중구 100",
    postcode:"22300", phone:"032-111-1111", mobile:"", tier:"wholesale", payment:"PREPAID",
    active:true, identifiers:"", contact:"", shippingFeeExcluded:false, overrides:{} };
  const recipient = { id:"r1", name:"김수취", address:"서울 서초구 123", phone:"02-2222-3333",
    mobile:"010-1234-0000", note:"문 앞 배송 요청", items:[
      { id:"item1", productId:"product-709", variantId:"price-709",
        name:"BD 709", color:"블랙", quantity:3, origin:"FACTORY" },
      { id:"item2", productId:"product-900", variantId:"price-900",
        name:"BD 900", color:"화이트", quantity:1, origin:"FACTORY" },
    ] };
  const snap = { recipient, sender, freightCode:"010", total:120000, shipping:4000, vat:0, subtotal:116000 };
  const q = { id:"excel:s1:FACTORY", shipmentId:"s1", origin:"FACTORY", at:"2026-11-07T01:33:00+09:00",
    actor:"직원", status:"QUEUED", snapshot:snap };
  return {
    revision:13, clients:[sender],
    products:[
      {id:"product-709",name:"BD 709",code:"BD 709",variants:[{id:"price-709",color:"블랙"}]},
      {id:"product-900",name:"BD 900",code:"BD 900",variants:[{id:"price-900",color:"화이트"}]},
    ], aliases:[], orders:[
      { id:"order1", clientId:"client1", orderType:"AGENCY", recipients:[recipient] },
    ],
    exports:[], queue:[], settings:{operatorName:"매장 직원"},
    workflow: {
      queue:[q], shipments:[{ id:"s1", orderId:"order1", recipientId:"r1",
        transferred:true, step:4 }],
      events:[], sources:[], groups:[], deliveries:[], payments:[], changeRequests:[],
    },
  };
}

test("factory Logen workbook exports exactly 16 expected columns with preserved freight code 010", async () => {
  const state = stateFixture();
  const report = previewFactoryExport(state, ["excel:s1:FACTORY"]);
  const bytes = await createFactoryWorkbook(report);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(bytes));
  assert.equal(workbook.worksheets.length,1);
  const sheet = workbook.worksheets[0];
  assert.equal(sheet.rowCount,2);
  assert.deepEqual(Array.from({length:16}, (_,i)=>sheet.getRow(1).getCell(i+1).value),
    [...LOGEN_HEADERS]);
  assert.equal(sheet.getCell("A2").value,"김수취");
  assert.equal(sheet.getCell("H2").value,"010");
  assert.equal(sheet.getCell("L2").value,"예시악기");
  assert.equal(sheet.getCell("M2").value,"22300");
  assert.equal(sheet.getCell("I2").value,"◆ BD 709 3개 ◆ BD 900 1개");
  assert.deepEqual([...LOGEN_HEADERS], [
    "수하인명", "수하인우편번호", "수하인주소", "수하인전화번호", "수하인핸드폰번호",
    "택배수량", "택배운임", "운임구분", "품목명", "", "메시지", "송하인명",
    "(송)우편", "(송)주소1", "(송)전화", "(송)핸드폰",
  ]);
  assert.equal(sheet.getCell("J1").value,"");
  assert.equal(sheet.getCell("J2").value,"");
  assert.equal(sheet.getCell("K2").value,"문 앞 배송 요청");
  assert.equal(sheet.getCell("F2").value,"","factory fills package count");
  assert.equal(sheet.getCell("G2").value,"","factory fills postage");
  assert.equal(sheet.getCell("B2").value,"","no guessed recipient postcode");
});

test("after Save As succeeds, mark queue EXPORTED and freeze audit without marking delivered", () => {
  const state = stateFixture();
  const original = JSON.stringify(state);
  const preview = previewFactoryExport(state, ["excel:s1:FACTORY"]);
  const {next,filename,exportId} = recordFactoryExport(state,preview,"C:\\Temp\\BANDO-export-1.xlsx");
  assert.equal(filename,"BANDO-export-1.xlsx");
  assert.equal(next.workflow.queue[0].status,"EXPORTED");
  assert.equal(next.workflow.queue[0].fileOnly,true);
  assert.equal(next.workflow.queue[0].factoryDeliveredAt,undefined);
  assert.equal(next.workflow.queue[0].exportId,exportId);
  assert.equal(next.exports.length,1);
  assert.equal(next.exports[0].snapshots[0].snapshot.recipient.name,"김수취");
  assert.equal(next.exports[0].savedPath,"C:\\Temp\\BANDO-export-1.xlsx");
  assert.equal(next.workflow.events[0].action,"공장 발송 Excel 작성");
  assert.equal(JSON.stringify(state),original);
  assert.throws(()=>previewFactoryExport(next, ["excel:s1:FACTORY"]),/공장 출력 대기 상태/);
});

test("duplicate IDs, legacy IDs, store rows and stale revision are blocked", () => {
  const state=stateFixture();
  const id=state.workflow.queue[0].id;
  assert.throws(()=>previewFactoryExport(state,[id,id]),/중복 선택/);
  assert.throws(()=>previewFactoryExport(state,["order1"]),/이전 방식의 주문/);
  const preview=previewFactoryExport(state,[id]);
  assert.throws(()=>recordFactoryExport({...state,revision:14},preview,"C:\\Temp\\out.xlsx"),/변경되었습니다/);
  state.workflow.queue[0].origin="STORE";
  assert.throws(()=>previewFactoryExport(state,[id]),/공장 출력 대기/);
});

test("recipient, agency sender, tracking prerequisites, and ineligible item quantities are enforced", () => {
  const state=stateFixture();
  const id=state.workflow.queue[0].id;
  state.workflow.queue[0].snapshot.recipient.address="";
  assert.throws(()=>previewFactoryExport(state,[id]),/수취인/);
  state.workflow.queue[0].snapshot.recipient.address="서울 서초구 123";
  state.workflow.queue[0].snapshot.sender.address="";
  assert.throws(()=>previewFactoryExport(state,[id]),/송하인/);
  state.workflow.queue[0].snapshot.sender.address="인천 중구 100";
  state.workflow.queue[0].snapshot.recipient.items[0].quantity=null;
  assert.throws(()=>previewFactoryExport(state,[id]),/품목명과 수량/);
});

test("020 is preserved as a text freight code while factory postal data remains optional", async () => {
  const state=stateFixture();
  state.workflow.queue[0].snapshot.freightCode="020";
  state.workflow.queue[0].snapshot.sender.postcode="";
  const bytes=await createFactoryWorkbook(previewFactoryExport(state,[state.workflow.queue[0].id]));
  const wb=new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(bytes));
  assert.equal(wb.worksheets[0].getCell("H2").value,"020");
  assert.equal(wb.worksheets[0].getCell("M2").value,"");
});

test("Tauri native Save As wired; canceled dialog does not mark export in UI", () => {
  const rust=read("src-tauri/src/lib.rs");
  const bridge=read("src/tauri-bridge.ts");
  const queue=read("src/WorkflowQueue.tsx");
  assert.match(rust,/async fn save_factory_workbook/);
  assert.match(rust,/save_factory_workbook,/);
  assert.match(bridge,/saveFactoryWorkbook: \(bytes\)/);
  assert.match(queue,/const savedPath = await window\.bando!\.saveFactoryWorkbook\(bytes\)/);
  assert.match(queue,/if \(!savedPath\) return;/);
  assert.match(queue,/businessCoreCall<FactoryExportPreview>\("output", "prepare_factory_export", \{ state: latest, ids: preview.ids \}\)/);
  assert.match(queue,/await nativeFinalizeExport\(latest, "FACTORY", preview, savedPath\)/);
  const nativeHistory=read("src-tauri/src/business_core/output/export_history.rs");
  assert.match(nativeHistory,/entry\["status"\]=json!\("EXPORTED"\)/);
  assert.match(nativeHistory,/entry\["fileOnly"\]=json!\(true\)/);
  assert.match(queue,/await onSave\(result\.next\)/);
  assert.match(queue,/await window\.bando!\.backup\(\)/);
  assert.match(queue,/실제 공장 전달은 별도로 확인/);
});

test("factory workbook requires explicit bag and wheel configurations on frozen item names",()=>{
  const original=stateFixture();
  const product={
    id:"p-bag",code:"BD 700",name:"BD 700 / 가방 포함",catalog:"BANDOSTAND",
    variants:[{id:"v-bag",option:"",color:"단일"}],
  };
  original.products.push(product);
  const item=original.workflow.queue[0].snapshot.recipient.items[0];
  item.productId=product.id;
  item.variantId="v-bag";
  item.name="BD 700";
  assert.throws(()=>previewFactoryExport(original,["excel:s1:FACTORY"]),/가방 포함/);
  item.name="BD 700 / 가방 포함";
  let report=previewFactoryExport(original,["excel:s1:FACTORY"]);
  assert.match(report.rows[0].values[8],/◆ BD 700 \/ 가방 포함/);
  product.name="BD 700 / 바퀴 미포함";
  item.name="BD 700";
  assert.throws(()=>previewFactoryExport(original,["excel:s1:FACTORY"]),/바퀴 포함/);
  item.name="BD 700 / 바퀴 미포함";
  report=previewFactoryExport(original,["excel:s1:FACTORY"]);
  assert.match(report.rows[0].values[8],/바퀴 미포함/);
});
test("factory workbook blocks a legacy multi-configuration item instead of selecting an option",()=> {
  const state = stateFixture();
  state.products.push({
    id: "legacy-multi", name: "BD 700", code: "BD 700",
    variants: [
      { id: "v-included", option: "가방 포함", color: "블랙" },
      { id: "v-excluded", option: "가방 미포함", color: "블랙" },
    ],
  });
  const item = state.workflow.queue[0].snapshot.recipient.items[0];
  item.productId = "legacy-multi";
  item.variantId = "v-included";
  item.name = "BD 700 / 가방 포함";
  assert.throws(() => previewFactoryExport(state, ["excel:s1:FACTORY"]), /옛 상품은 공장 발송할 수 없습니다/);
});
test("Order editor chooses a complete standalone product rather than a variant dropdown", () => {
  const source = read("src/OrderItemEditor.tsx");
  assert.match(source, /itemFromProduct\(candidate, client/);
  assert.doesNotMatch(source, /label="옵션"|p\?\.variants\.map/);
});
test("Factory export uses the frozen complete product name without a second color label",()=>{
  const state = stateFixture();
  state.workflow.queue[0].snapshot.recipient.items[0].name = "BD 709 / 블랙 / 타공 상판";
  const report = previewFactoryExport(state,["excel:s1:FACTORY"]);
  assert.match(report.rows[0].values[8], /◆ BD 709 \/ 블랙 \/ 타공 상판 3개/);
  assert.doesNotMatch(report.rows[0].values[8], /블랙 블랙/);
});

test("frozen legacy confirmed orders resolve to a precise sale product without rewriting the factory Excel item",()=>{
  const state=stateFixture();
  const reference=JSON.parse(read("src-tauri/resources/state-seed.json"));
  const oldId="bando-site-351",priceId="bando-351-P00000NN000B";
  const matchedId=reference.productMappings[oldId+"|"+priceId];
  const linked=reference.products.find((p)=>p.id===matchedId);
  assert.ok(linked);
  state.products.push(structuredClone(linked));
  state.productMappings={ [oldId+"|"+priceId]:matchedId };
  state.orders[0].confirmedAt="2026-11-07T01:00:00+09:00";
  const item=state.workflow.queue[0].snapshot.recipient.items[0];
  item.productId=oldId; item.variantId=priceId;
  item.name="BD 707A / 클리어"; item.quantity=3; item.unitPrice=117777;
  const previous=JSON.stringify(state);
  const result=previewFactoryExport(state,["excel:s1:FACTORY"]);
  assert.match(result.rows[0].values[8], /◆ BD 707A \/ 클리어 3개/);
  assert.doesNotMatch(result.rows[0].values[8], /프로스트/);
  assert.equal(JSON.stringify(state),previous);
  assert.equal(item.unitPrice,117777);
});

test("an unresolved or forged legacy product map blocks factory export, never guesses by model",()=>{
  const state=stateFixture();
  const seed=JSON.parse(read("src-tauri/resources/state-seed.json"));
  const legacyId="bando-site-351",goodPrice="bando-351-P00000NN000B";
  const item=state.workflow.queue[0].snapshot.recipient.items[0];
  item.productId=legacyId; item.variantId=goodPrice;
  item.name="BD 707A / 클리어";
  assert.throws(()=>previewFactoryExport(state,["excel:s1:FACTORY"]),/상품 ID와 가격 기록 ID/);
  const linkedId=seed.productMappings[legacyId+"|"+goodPrice];
  const linked=seed.products.find((p)=>p.id===linkedId);
  state.products.push(structuredClone(linked));
  state.productMappings={[legacyId+"|"+goodPrice]:linkedId};
  assert.doesNotThrow(()=>previewFactoryExport(state,["excel:s1:FACTORY"]));
  item.variantId="INVALID";
  assert.throws(()=>previewFactoryExport(state,["excel:s1:FACTORY"]),/상품 ID와 가격 기록 ID/);
  item.variantId=goodPrice;
  state.productMappings={[legacyId+"|"+goodPrice]:"other-product"};
  assert.throws(()=>previewFactoryExport(state,["excel:s1:FACTORY"]),/상품 ID와 가격 기록 ID/);
  state.productMappings={[legacyId+"|"+goodPrice]:linkedId};
  state.products.find((p)=>p.id===linkedId).sourceProductId="not-the-original-parent";
  assert.throws(()=>previewFactoryExport(state,["excel:s1:FACTORY"]),/상품 ID와 가격 기록 ID/);
});

test("legacy wheel configuration mapping does not invent a missing distinction in the frozen item",()=>{
  const state=stateFixture();
  const seed=JSON.parse(read("src-tauri/resources/state-seed.json"));
  const oldId="bando-site-136";
  const mapped=seed.products.find((p)=>p.siteId==="136" && /바퀴 미포함/.test(p.name));
  assert.ok(mapped);
  state.products.push(structuredClone(mapped));
  state.productMappings={[oldId+"|"+mapped.variants[0].id]:mapped.id};
  const item=state.workflow.queue[0].snapshot.recipient.items[0];
  item.productId=oldId;item.variantId=mapped.variants[0].id;item.name="BD Z-2";
  assert.throws(()=>previewFactoryExport(state,["excel:s1:FACTORY"]),/바퀴 포함 \/ 미포함/);
  item.name="BD Z-2 / 바퀴 미포함";
  assert.doesNotThrow(()=>previewFactoryExport(state,["excel:s1:FACTORY"]));
});

test("factory export blocks opposite included/excluded packaging even when both mention the item",()=>{
  const state=stateFixture();
  const product={id:"bag-safe",name:"BD 700 / 가방 포함",code:"BD 700",
    variants:[{id:"price-bag",color:"단일"}]};
  state.products.push(product);
  const item=state.workflow.queue[0].snapshot.recipient.items[0];
  item.productId=product.id;item.variantId="price-bag";item.name="BD 700 / 가방 미포함";
  assert.throws(()=>previewFactoryExport(state,["excel:s1:FACTORY"]),/가방 포함 \/ 미포함/);
  item.name="BD 700 / 가방 포함";
  assert.doesNotThrow(()=>previewFactoryExport(state,["excel:s1:FACTORY"]));
  product.name="BD Z-2 / 바퀴 미포함";
  item.name="BD Z-2 / 바퀴 포함";
  assert.throws(()=>previewFactoryExport(state,["excel:s1:FACTORY"]),/바퀴 포함 \/ 미포함/);
});

test("confirmed frozen factory items must match tabletop construction and type, not just the source ID",()=>{
  const state=stateFixture();
  const product={id:"top-safe",name:"BD 709-1 / 블랙 / 비타공 상판",code:"BD 709-1",
    variants:[{id:"price-top",color:"블랙"}]};
  state.products.push(product);
  const item=state.workflow.queue[0].snapshot.recipient.items[0];
  item.productId=product.id;item.variantId="price-top";
  item.name="BD 709 / 블랙 / 타공 상판";
  assert.throws(()=>previewFactoryExport(state,["excel:s1:FACTORY"]),/타공 \/ 비타공/);
  item.name="BD 709-1 / 블랙 / 비타공 상판";
  assert.doesNotThrow(()=>previewFactoryExport(state,["excel:s1:FACTORY"]));
  product.name="BD LP-WB / B타입 상판";
  item.name="BD LP-WB / A타입 상판";
  assert.throws(()=>previewFactoryExport(state,["excel:s1:FACTORY"]),/A\/B타입/);
});

test("legacy mapped product refuses missing frozen color rather than inventing an attribute",()=>{
  const state=stateFixture();
  const seed=JSON.parse(read("src-tauri/resources/state-seed.json"));
  const old="bando-site-351",price="bando-351-P00000NN000B",target=seed.productMappings[old+"|"+price];
  const product=seed.products.find((p)=>p.id===target);
  state.products.push(structuredClone(product));state.productMappings={[old+"|"+price]:target};
  const item=state.workflow.queue[0].snapshot.recipient.items[0];
  item.productId=old;item.variantId=price;item.name="BD 707A";
  assert.throws(()=>previewFactoryExport(state,["excel:s1:FACTORY"]),/색상 구분/);
  item.name="BD 707A / 클리어";
  assert.doesNotThrow(()=>previewFactoryExport(state,["excel:s1:FACTORY"]));
});

test("frozen factory queue blocks items with no confirmed product or price-record identity",()=>{
  const state=stateFixture();
  const item=state.workflow.queue[0].snapshot.recipient.items[0];
  delete item.productId;
  assert.throws(()=>previewFactoryExport(state,["excel:s1:FACTORY"]),/상품 또는 가격 기록 ID/);
  item.productId="product-709";
  delete item.variantId;
  assert.throws(()=>previewFactoryExport(state,["excel:s1:FACTORY"]),/상품 또는 가격 기록 ID/);
});

test("factory workbook prefixes every item including the first with a diamond and no inter-item slash",()=>{
  const state=stateFixture();
  const goods=previewFactoryExport(state,["excel:s1:FACTORY"]).rows[0].values[8];
  assert.equal(goods,"◆ BD 709 3개 ◆ BD 900 1개");
  assert.equal(goods.split("◆ ").length-1,2);
  state.workflow.queue[0].snapshot.recipient.items.pop();
  assert.equal(previewFactoryExport(state,["excel:s1:FACTORY"]).rows[0].values[8],"◆ BD 709 3개");
});
