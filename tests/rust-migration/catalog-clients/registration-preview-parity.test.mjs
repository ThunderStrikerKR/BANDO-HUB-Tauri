/** Real XLSX -> real TS registration preview vs compiled Rust row algorithm.
 * The raw XLSX parsing is deliberately identical. Random UUIDs and execution
 * timestamps alone are normalized, never decision fields or error messages.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {File} from "node:buffer";
import {webcrypto} from "node:crypto";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {tsImport} from "tsx/esm/api";
import ExcelJS from "exceljs";
const {previewRegistrationWorkbook,REGISTRATION_HEADERS}=
  await tsImport("../../../src/product-registration-xlsx.ts",import.meta.url);
const manifest=fileURLToPath(new URL("./Cargo.toml",import.meta.url));
const root=fileURLToPath(new URL("../../../",import.meta.url));
const base=()=>({
  revision:7,orders:[{id:"historic-order",status:"EXPORTED"}],
  products:[],deletedProductKeys:[],registrationBatches:[],
  categories:[
    {id:"leaf",name:"보면대",parentId:"catalog-root:BANDOSTAND",active:true},
    {id:"mall-leaf",name:"액세서리",parentId:"catalog-root:BANDOMALL",active:true}
  ],
  brands:[{id:"b1",name:"반도",korean:"반도스탠드",aliases:["BANDO"],evidenceUrl:"https://bandostand.com"}],
  settings:{operatorName:"검토자"},
});
const row=(name="BD 709 블랙 기본")=>[
  name,"반도","블랙","기본","","개","반도스탠드",
  "반도스탠드 / 보면대","10000","12000","15000","","",
];
const trials=[];
function add(name,edit=()=>{}){
  const state=base(),list=[row()];
  const opts={state,list,formula:false,legacy:false};
  edit(opts);
  trials.push({name,...opts});
}
add("valid independent sale product");
add("missing product name",x=>{x.list[0][0]="";});
add("missing selling unit",x=>{x.list[0][5]="";});
add("missing product catalog",x=>{x.list[0][6]="기타";});
add("missing category path",x=>{x.list[0][7]="반도스탠드 / 잘못된경로";});
add("wrong catalog with old category",x=>{x.list[0][6]="반도몰";});
add("valid BANDOMALL catalog and leaf",x=>{
  x.list[0][6]="반도몰";x.list[0][7]="반도몰 / 액세서리";
});
add("malformed wholesale price",x=>{x.list[0][8]="10.5";});
add("invalid negative price",x=>{x.list[0][9]="-1";});
add("unsafe integer cost",x=>{x.list[0][10]="9007199254740992";});
add("zero means unregistered price",x=>{x.list[0][10]="0";});
add("blank tier price accepted",x=>{x.list[0][8]="";});
add("comma thousands price",x=>{x.list[0][8]="1,200";});
add("incorrect grouping price",x=>{x.list[0][8]="12,00";});
add("valid official URL",x=>{x.list[0][11]="https://www.bandostand.com/product/709";});
add("untrusted URL",x=>{x.list[0][11]="https://evil.example/product/709";});
add("wrong official URL scheme",x=>{x.list[0][11]="http://www.bandostand.com/product/709";});
add("brand missing",x=>{x.list[0][1]="알수없는브랜드";});
add("brand alias accepted",x=>{x.list[0][1]="BANDO";});
add("ambiguous brand",x=>{x.state.brands.push({
  id:"b2",name:"BANDO",korean:"기타",aliases:["반도"],evidenceUrl:"https://example.com"
});});
add("configuration not in name is on hold",x=>{x.list[0][3]="가방 포함";});
add("valid cosmetic color translated",x=>{x.list[0][2]="검정";});
add("two identical rows in one workbook",x=>{x.list.push(row());});
add("two distinct products in one workbook",x=>{
  const second=row("BD 708 블랙 기본");x.list.push(second);
});
add("same ID but different sale color still distinct",x=>{
  const second=row("BD 709 로즈골드 기본");second[2]="로즈골드";x.list.push(second);
});
add("bad second row with valid first",x=>{const b=row("BD 708 블랙 기본");b[10]="bad";x.list.push(b);});
add("formula cell blocked",x=>{x.formula=true;});
add("legacy worksheet headers",x=>{x.legacy=true;});
add("inactive leaf held",x=>{x.state.categories[0].active=false;});
add("multiple brand names for same ID rejected",x=>{
  x.state.brands.push({id:"b2",name:"반도",korean:"",aliases:[],evidenceUrl:"https://a.example"});
});

const textCell=(cell)=>{
  const value=cell.value;
  if(value===null||value===undefined)return "";
  if(typeof value==="object"){
    if("text" in value)return String(value.text??"").trim();
    if("richText" in value)return value.richText.map(item=>item.text).join("").trim();
    return "";
  }
  return String(value).trim();
};
async function caseFor(t){
  const wb=new ExcelJS.Workbook();
  const sheet=wb.addWorksheet("상품 등록");
  const headers=t.legacy ? ["최종 등록명","제조사 모델코드",...REGISTRATION_HEADERS.slice(1)] :
    [...REGISTRATION_HEADERS];
  sheet.addRow(headers);
  for(const one of t.list)sheet.addRow(t.legacy?[one[0],"",...one.slice(1)]:one);
  if(t.formula)sheet.getCell("J2").value={formula:"1+1",result:2};
  const bytes=Buffer.from(await wb.xlsx.writeBuffer());
  const file=new File([bytes],"등록시험.xlsx");
  const digest=Buffer.from(await webcrypto.subtle.digest("SHA-256",bytes)).toString("hex");
  const rows=[];
  for(let i=2;i<=sheet.rowCount;i++){
    const cells=headers.map((_,j)=>sheet.getRow(i).getCell(j+1));
    const data=cells.map(textCell);
    if(!data.some(Boolean))continue;
    const values={};
    headers.forEach((header,j)=>{values[header]=data[j]});
    rows.push({row:i,values,
      unsafeCells:cells.some(cell=>cell.isMerged ||
        typeof cell.value==="object" && cell.value!==null && "formula" in cell.value)});
  }
  const generated=rows.map((r,i)=>({
    productId:"00000000-0000-4000-8000-"+String(i+1).padStart(12,"0"),
    variantId:"00000000-0000-4000-9000-"+String(i+1).padStart(12,"0"),
    at:"2026-11-13T14:00:00.000Z",
  }));
  let oracle;
  try{
    oracle={ok:true,value:await previewRegistrationWorkbook(t.state,file)};
  }catch(error){
    oracle={ok:false,error:error instanceof Error?error.message:String(error)};
  }
  return {name:t.name,oracle,payload:{state:t.state,rows,generated,fingerprint:digest}};
}
function stable(output){
  const clone=JSON.parse(JSON.stringify(output));
  if(!clone.ok)return clone;
  const generatedIds=new Map(clone.value.rows.filter(row=>row.product)
    .map(row=>[row.product.id, "GENERATED-ID-ROW-"+row.row]));
  for(const entry of clone.value.rows){
    entry.duplicateIds=entry.duplicateIds.map(id=>generatedIds.get(id)??id);
    if(!entry.product)continue;
    const product=entry.product;
    product.id="PRODUCT-ID";
    product.code="PRODUCT-ID";
    product.familyKey="PRODUCT-ID";
    product.variants[0].id="VARIANT-ID";
    product.createdAt="TIMESTAMP";
    product.updatedAt="TIMESTAMP";
  }
  return clone;
}
test("30 real XLSX registration previews match compiled Rust in rows, holds and error strings",async()=>{
  const cases=await Promise.all(trials.map(caseFor));
  const run=spawnSync("cargo",["run","--quiet","--manifest-path",manifest,
    "--bin","parity_runner"],{
      cwd:root,encoding:"utf8",input:JSON.stringify(
        cases.map(x=>({operation:"preview_registration_rows",payload:x.payload}))),
      maxBuffer:16*1024*1024,timeout:180000
  });
  assert.equal(run.status,0,run.stderr||run.error?.message);
  const results=JSON.parse(run.stdout);
  assert.equal(results.length,cases.length);
  cases.forEach((item,i)=>{
    assert.deepEqual(stable(results[i]),stable(item.oracle),
      item.name+": Rust registration preview differs from the original TS");
  });
});
