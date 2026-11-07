import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { load as loadHtml } from "cheerio";
import { webcrypto } from "node:crypto";

const read=(name)=>readFileSync(new URL("../"+name,import.meta.url),"utf8");

function documentFromHtml(html){
  const $=loadHtml(html);
  const wrap=(node)=>{
    if(!node) return null;
    const self=$(node);
    return {
      get textContent(){return self.text()},
      get content(){return self.attr("content")??""},
      get value(){return self.attr("value")??""},
      get type(){return self.attr("type")??""},
      get name(){return self.attr("name")??""},
      get disabled(){return self.is(":disabled")||self.attr("disabled")!==undefined},
      get options(){return self.children("option").toArray().map(wrap)},
      get dataset(){return {optionValue:self.attr("data-option-value")??""}},
      getAttribute:(key)=>self.attr(key)??null,
      querySelector:(selector)=>wrap(self.find(selector).first().get(0)),
      closest:(selector)=>wrap(self.closest(selector).get(0)),
    };
  };
  return {
    querySelector:(selector)=>wrap($(selector).first().get(0)),
    querySelectorAll:(selector)=>$(selector).toArray().map(wrap),
  };
}
function loadParser(){
  const output={};
  const compiled=ts.transpileModule(read("src/official-product-import.ts"),{
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
  }).outputText;
  const mockDomain={
    normalizeCode:(s)=>String(s).replace(/\s/g,"").toUpperCase(),
    normalizeColor:(s)=>s,
    validateProduct:()=>{},
    validProductUrl:(s)=>/^https:\/\/bandostand\.com\/product\//.test(s),
  };
  const deps={
    "./category-tree":{categoryPath:()=>[]},
    "./category-roots":{catalogFromCategory:()=> "BANDOSTAND",withCatalogRoots:(s)=>s},
    "./domain":mockDomain,
    "./product-models":{
      normalizeModel:(s)=>s.trim().replace(/^BD\s*/i,"BD "),
      registeredProducts:(items)=>items.filter((p)=>!p.deletedAt&&p.active!==false&&!p.supersededBy),
    },
  };
  vm.runInNewContext(compiled,{
    exports:output,require:(name)=>deps[name]??(()=>{throw Error("Unexpected import "+name)})(),
    DOMParser:class {parseFromString(html){return documentFromHtml(html)}},
    URL,Date,crypto:webcrypto,structuredClone,
  });
  return output;
}
const {parseOfficialProductPage,applyOfficialProductPreview}=loadParser();
const url="https://bandostand.com/product/detail.html?product_no=259";
const state=()=>({revision:0,products:[],categories:[]});
function html({title="반도스탠드 BD 700 가방포함",model="",custom="P00000QL",
               price="19,000원",optionMarkup="",ogPrice=""}={}){
  return [
    '<html><head><meta property="og:title" content="'+title+'">',
    '<meta property="product:price:amount" content="'+ogPrice+'"></head><body>',
    '<div class="headingArea"><h2>'+title+'</h2></div>',
    '<table><tr><th>상품명</th><td>'+title+'</td></tr>',
    '<tr><th>모델명</th><td>'+model+'</td></tr>',
    '<tr><th>자체 상품코드</th><td>'+custom+'</td></tr>',
    '<tr><th>판매가</th><td>'+price+'</td></tr></table>',
    optionMarkup,'</body></html>',
  ].join("");
}

test("Cafe24 P-codes stay technical IDs; BD 700 model is recovered from the title",()=>{
  const preview=parseOfficialProductPage(url,html(),state());
  assert.equal(preview.product.code,"BD 700");
  assert.equal(preview.product.siteCode,"P00000QL");
  assert.equal(preview.product.name,"BD 700 / 가방 포함");
  assert.equal(preview.product.subtitle,"");
  assert.equal(preview.product.originalName,"반도스탠드 BD 700 가방포함");
  assert.equal(preview.modelSource,"TITLE");
  assert.equal(preview.canApply,true);
});
test("Bag and wheel include/exclude are always spelled out, never inferred",()=>{
  const inputs=[
    ["반도스탠드 BD 700 가방포함","BD 700 / 가방 포함"],
    ["반도스탠드 BD 700 가방 미포함","BD 700 / 가방 미포함"],
    ["반도스탠드 BD 700 바퀴포함","BD 700 / 바퀴 포함"],
    ["반도스탠드 BD 700 바퀴 미포함","BD 700 / 바퀴 미포함"],
    ["반도스탠드 BD 700 바퀴없음","BD 700 / 바퀴 미포함"],
  ];
  for(const [title,want] of inputs){
    const result=parseOfficialProductPage(url,html({title}),state());
    assert.equal(result.product.name,want,title);
    assert.equal(result.product.variants.length,1,"No invented counterpart SKU");
  }
});
test("Usage notes move to internal description; configuration content never does",()=>{
  const result=parseOfficialProductPage(url,html({
    title:"반도스탠드 BD 803 성악용 녹음용 보면대",model:"BD 803",
  }),state());
  assert.equal(result.product.name,"BD 803");
  assert.match(result.product.subtitle,/성악용 녹음용 보면대/);
});
test("Price ranges cannot fall back to a misleading base meta price",()=>{
  const result=parseOfficialProductPage(url,html({
    price:"19,000원 ~ 25,000원",ogPrice:"19000",
  }),state());
  assert.equal(result.product.variants[0].retail,null);
  assert.equal(result.canApply,false);
  assert.match(result.warnings.join(" "),/판매가를 확인하지/);
});
test("True selectable bag configurations remain review-only and expose both labels",()=>{
  const options='<div class="xans-product-option"><select id="product_option_id1">'+
    '<option value="*">가방 선택</option>'+
    '<option value="A">가방 포함 (+2,000원)</option>'+
    '<option value="B">가방 미포함</option></select></div>';
  const result=parseOfficialProductPage(url,html({optionMarkup:options}),state());
  assert.equal(result.canApply,false);
  assert.equal(result.product.requiresOption,true);
  assert.equal(result.optionEvidence.length,1);
  assert.deepEqual(JSON.parse(JSON.stringify(result.optionEvidence[0].values.map(x=>x.label))),[
    "가방 포함 (+2,000원)","가방 미포함"
  ]);
  assert.equal(result.product.variants.length,1);
  assert.throws(()=>applyOfficialProductPreview(state(),result),/확인이 필요한 옵션/);
});
test("Dynamic unfilled select and multi-model titles are not silently approved",()=>{
  const option='<select id="product_option_id1"><option value="*">옵션 선택</option></select>';
  const a=parseOfficialProductPage(url,html({optionMarkup:option}),state());
  assert.equal(a.canApply,false);
  assert.equal(a.optionEvidence[0].values.length,0);
  const b=parseOfficialProductPage(url,html({title:"반도스탠드 BD 709 / 709-1"}),state());
  assert.equal(b.canApply,false);
});
test("No model in the source means review, not a fake P-code model",()=>{
  const result=parseOfficialProductPage(url,html({
    title:"반도스탠드 보면대 바퀴 4개 1set",model:"P00000NU",custom:"P00000NU",
  }),state());
  assert.equal(result.canApply,false);
  assert.equal(result.product.code,"");
  assert.equal(result.product.name,"보면대 바퀴 4개 1set");
});
