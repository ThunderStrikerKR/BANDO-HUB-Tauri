import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { File } from "node:buffer";
import { webcrypto } from "node:crypto";
import { createRequire } from "node:module";
import vm from "node:vm";
import ts from "typescript";
import ExcelJS from "exceljs";

const read = (path) => readFileSync(new URL("../" + path, import.meta.url), "utf8");
const nodeRequire = createRequire(import.meta.url);
const exports = {};
const compiled = ts.transpileModule(read("src/product-registration-xlsx.ts"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
const execution = vm.runInThisContext(
  "(function(exports,require,crypto,structuredClone){\n" + compiled + "\n})",
  { filename: "src/product-registration-xlsx.ts" },
);
const root = { id: "catalog", name: "반도스탠드", parentId: null, active: true };
const leaf = { id: "leaf", name: "보면대", parentId: "catalog", active: true };
const normalize = (text) => text.trim().toUpperCase().replace(/\s/g,"");
const key = (text) => text.normalize("NFKC").trim().toLocaleLowerCase().replace(/\s+/g," ");
execution(exports, (path) => {
  if(path === "./category-tree") return {
    categoryPath: (all, id) => id === "leaf" ? [root,leaf] : [root],
  };
  if(path === "./category-roots") return {
    withCatalogRoots: (categories) => categories,
    catalogFromCategory: (_all, id) => ["catalog","leaf"].includes(id) ? "BANDOSTAND" : undefined,
  };
  if(path === "./domain") return {
    normalizeCode:normalize, normalizeColor:(c)=>c.trim(),
    validProductUrl:(url)=> /^https:\/\/(?:www\.)?bandostand\.com\//.test(url),
    validateProduct:(p,products)=>{
      if(!p.name || !p.code || p.variants.length!==1) throw Error("제품 정보 확인");
      if(products.some(old=>old.registrationIdentity===p.registrationIdentity)) throw Error("중복 상품");
    },
  };
  if(path === "./product-models") return {
    normalizeModel:(s)=>normalize(s),
    productKey:(p)=>p.registrationIdentity ?? p.code,
    registeredProducts:(products)=>products.filter((p)=>!p.deletedAt && p.active!==false),
  };
  if(path === "./product-registry") return {
    registryKey:key,
    registryIdentity:(values)=>["제조사 모델코드","색상","규격","판매 단위"].map(k=>key(values[k]||"")).join("|"),
  };
  return nodeRequire(path);
}, webcrypto, structuredClone);

const state = ()=>({
  revision:8, products:[], deletedProductKeys:[], categories:[root,leaf],
  brands:[], registrationBatches:[], settings:{operatorName:"검증 직원"},
});
const makeRow = (model="BD123",name="반도스탠드 신규 보면대")=>[
  name,model,"","블랙","기본","","개","반도스탠드","반도스탠드 / 보면대",
  "10000","12000","15000","",""
];
async function workbook(rows) {
  const book=new ExcelJS.Workbook();
  const sheet=book.addWorksheet("상품 등록");
  sheet.addRow([...exports.REGISTRATION_HEADERS]);
  for(const row of rows)sheet.addRow(row);
  const bytes=await book.xlsx.writeBuffer();
  return new File([Buffer.from(bytes)],"신규상품.xlsx",{type:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"});
}

test("real XLSX one new product, duplicate and invalid row are separated without changing prices",async()=>{
 const s=state(),original=JSON.stringify(s);
 const file=await workbook([
   makeRow(),makeRow(),makeRow("","모델코드 누락 상품"),
 ]);
 const preview=await exports.previewRegistrationWorkbook(s,file);
 assert.deepEqual(preview.rows.map(r=>r.status),["READY","DUPLICATE","ERROR"]);
 const {next,batch,created,skipped}=exports.prepareRegistrationCommit(s,preview,"검증 직원");
 assert.equal(created,1);
 assert.equal(skipped,2);
 assert.equal(next.products.length,1);
 assert.equal(next.products[0].variants[0].retail,15000);
 assert.equal(next.registrationBatches.length,1);
 assert.equal(next.registrationBatches[0].id,batch.id);
 assert.equal(JSON.stringify(s),original);
 const bytes=await exports.exportRegistrationResults(batch);
 const book=new ExcelJS.Workbook();
 await book.xlsx.load(Buffer.from(bytes));
 const sheet=book.getWorksheet("등록 결과");
 assert.equal(sheet.rowCount,4);
 assert.deepEqual([2,3,4].map(row=>sheet.getRow(row).getCell(16).value),
   ["등록 완료","중복","오류"]);
 assert.equal(sheet.getRow(2).getCell(18).value,next.products[0].id);
});

test("stale revision and already-created product cannot be committed twice",async()=>{
 const s=state();
 const preview=await exports.previewRegistrationWorkbook(s,await workbook([makeRow()]));
 const {next}=exports.prepareRegistrationCommit(s,preview,"검증 직원");
 assert.throws(()=>exports.prepareRegistrationCommit({...s,revision:9},preview,"검증 직원"),/다시 검증/);
 assert.throws(()=>exports.prepareRegistrationCommit({...next,revision:8},preview,"검증 직원"),/중복 상품/);
});

test("invalid XLSX formulas and unrecognized header block registration",async()=>{
 const s=state(), file=await workbook([makeRow()]);
 const book=new ExcelJS.Workbook();
 await book.xlsx.load(Buffer.from(await file.arrayBuffer()));
 book.getWorksheet("상품 등록").getCell("J2").value={formula:"1+1",result:2};
 const bad=new File([Buffer.from(await book.xlsx.writeBuffer())],"수식상품.xlsx");
 const preview=await exports.previewRegistrationWorkbook(s,bad);
 assert.equal(preview.rows[0].status,"ERROR");
 assert.match(preview.rows[0].errors.join(" "),/수식/);
 book.getWorksheet("상품 등록").getCell("A1").value="다른 항목";
 const malformed=new File([Buffer.from(await book.xlsx.writeBuffer())],"잘못된양식.xlsx");
 await assert.rejects(()=>exports.previewRegistrationWorkbook(s,malformed),/열 이름 또는 순서/);
});
