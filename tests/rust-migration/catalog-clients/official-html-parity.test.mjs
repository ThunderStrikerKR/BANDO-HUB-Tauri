import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {webcrypto} from "node:crypto";
import {load as loadHtml} from "cheerio";
import ts from "typescript";
import {tsImport} from "tsx/esm/api";
import vm from "node:vm";

const read=(path)=>readFileSync(new URL("../../../"+path,import.meta.url),"utf8");
const {normalizeColor,validProductUrl}=await tsImport("../../../src/domain.ts",import.meta.url);
const {normalizeModel,registeredProducts}=await tsImport("../../../src/product-models.ts",import.meta.url);
const manifest=fileURLToPath(new URL("./Cargo.toml",import.meta.url));
const root=fileURLToPath(new URL("../../../",import.meta.url));

function documentFromHtml(html){
  const $=loadHtml(html);
  const wrap=node=>{
    if(!node)return null;
    const self=$(node);
    return {
      get textContent(){return self.text()},
      get content(){return self.attr("content")??""},
      get value(){return self.attr("value")??""},
      get type(){return self.attr("type")??""},
      get name(){return self.attr("name")??""},
      get disabled(){return self.is(":disabled")||self.attr("disabled")!==undefined},
      get options(){return self.find("option").toArray().map(wrap)},
      get dataset(){return {optionValue:self.attr("data-option-value")??""}},
      getAttribute:key=>self.attr(key)??null,
      querySelector:selector=>wrap(self.find(selector).first().get(0)),
      closest:selector=>wrap(self.closest(selector).get(0)),
    };
  };
  return {
    querySelector:selector=>wrap($(selector).first().get(0)),
    querySelectorAll:selector=>$(selector).toArray().map(wrap),
  };
}
const output={};
const compiled=ts.transpileModule(read("src/official-product-import.ts"),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}
}).outputText;
const deps={
  "./category-tree":{categoryPath:()=>[]},
  "./category-roots":{catalogFromCategory:()=> "BANDOSTAND",withCatalogRoots:s=>s},
  "./domain":{normalizeColor,validProductUrl,normalizeCode:s=>s.toUpperCase().replace(/\s/g,""),validateProduct:()=>{}},
  "./product-models":{normalizeModel,registeredProducts},
};
vm.runInNewContext(compiled,{
  exports:output,require:name=>deps[name]??(()=>{throw Error("Unexpected module "+name)})(),
  DOMParser:class{parseFromString(html){return documentFromHtml(html)}},
  URL,Date,crypto:webcrypto,structuredClone,
});
const parseTS=output.parseOfficialProductPage;
const official="https://bandostand.com/product/detail.html?product_no=259";
const mall="https://bandomall.co.kr/product/detail.html?product_no=259";
const state=()=>({revision:24,products:[],categories:[],orders:[{id:"old",price:15000}]});
const seedProduct=(id,changes={})=>({
  id,name:"BD 700 / 가방 포함",active:true,catalog:"BANDOSTAND",
  siteId:"259",siteRefs:["259"],variants:[{
    id:id+"v",color:"Black",siteProductId:"259"
  }],...changes
});
const html=(p={})=>{
  const title=p.title??"반도스탠드 BD 700 가방포함";
  const price=p.price??"19,000원";
  const model=p.model??"";
  const custom=p.custom??"P00000QL";
  const extra=p.extra??"";
  const titleHead=p.heading??title;
  return [
    "<html><head><meta property=\"og:title\" content=\""+title+"\">",
    "<meta property=\"product:price:amount\" content=\""+(p.ogPrice??"")+"\"></head><body>",
    "<div class=\"headingArea\"><h2>"+titleHead+"</h2></div>",
    "<table><tr><th>상품명</th><td>"+(p.noTitleField?"":title)+"</td></tr>",
    "<tr><th>모델명</th><td>"+model+"</td></tr>",
    "<tr><th>자체 상품코드</th><td>"+custom+"</td></tr>",
    "<tr><th>판매가</th><td>"+price+"</td></tr>",
    ...(p.color?["<tr><th>색상</th><td>"+p.color+"</td></tr>"]:[]),
    "</table>",extra,"</body></html>"
  ].join("");
};
const cases=[];
function add(name,url,body,s=state()){
  let oracle;
  try{oracle={ok:true,value:JSON.parse(JSON.stringify(parseTS(url,body,s)))}}
  catch(error){oracle={ok:false,error:String(error instanceof Error?error.message:error)}}
  cases.push({name,url,html:body,state:s,oracle});
}
add("normal Cafe24 product and website P-code",official,html());
add("bag excluded",official,html({title:"반도스탠드 BD 700 가방 미포함"}));
add("wheel included",official,html({title:"반도스탠드 BD 700 바퀴포함"}));
add("wheel excluded",official,html({title:"반도스탠드 BD 700 바퀴없음"}));
add("official model field takes precedence",official,html({
  title:"반도스탠드 BD 700 성악용 녹음용",model:"BD 803"
}));
add("custom model code",official,html({title:"반도스탠드 보면대",custom:"BD 709"}));
add("title model ambiguity",official,html({title:"반도스탠드 BD 709 / 709-1"}));
add("model field ambiguous comma",official,html({model:"BD 700, BD 701"}));
add("Cafe24 code cannot be model",official,html({model:"P00000AA"}));
add("price range cannot fall back to OG meta",official,html({price:"19,000원 ~ 25,000원",ogPrice:"19000"}));
add("missing visible price uses OG meta",official,html({price:"",ogPrice:"24000"}));
add("no valid price requires human review",official,html({price:"가격 문의"}));
add("explicit Korean color",official,html({color:"검정"}));
add("English color in title",official,html({title:"반도스탠드 BD 700 White"}));
add("radio selection blocks apply",official,html({extra:
  '<div class="xans-product-option"><label><input type="radio" name="size" value="L">큰 것</label></div>'
}));
add("checkbox selection blocks apply",official,html({extra:
  '<div class="xans-product-option"><input type="checkbox" name="bag" value="A" aria-label="가방 포함"></div>'
}));
add("select with two bag configurations",official,html({extra:
  '<div class="xans-product-option"><select id="product_option_id1">'+
  '<option value="*">선택</option><option value="A">가방 포함</option><option value="B">가방 미포함</option></select></div>'
}));
add("empty dynamic select still blocks apply",official,html({extra:
  '<select id="product_option_id1"><option value="*">옵션 선택</option></select>'
}));
add("custom option controls block apply",official,html({extra:
  '<div class="xans-product-option"><button data-option-value="A">A형</button></div>'
}));
add("existing exact source is update",official,html(),{
  ...state(),products:[seedProduct("registered")]
});
add("multiple exact source IDs hold",official,html(),{
  ...state(),products:[seedProduct("p1"),seedProduct("p2")]
});
add("existing multi-option source holds",official,html(),{
  ...state(),products:[seedProduct("registered",{variants:[
    {id:"v1",siteProductId:"259"},{id:"v2",siteProductId:"259"}
  ]})]
});
add("same normalized name without source ID holds",official,html(),{
  ...state(),products:[seedProduct("other",{siteId:"other",siteRefs:[],
    variants:[{id:"v",siteProductId:"other"}]})]
});
add("deleted source candidate cannot revive",official,html(),{
  ...state(),products:[seedProduct("deleted",{deletedAt:"2026-01-01"})]
});
add("separate mall catalog is STORE",mall,html());
add("missing product identifier refused",
  "https://bandostand.com/product/detail.html",html());
add("untrusted http refused",
  "http://bandostand.com/product/detail.html?product_no=259",html());
add("untrusted domain refused",
  "https://bandostand.com.evil.test/product/detail.html?product_no=259",html());
add("product title missing",official,
  "<html><body><div>상품 상세페이지</div></body></html>");
add("new Cafe24 path slug ID",
  "https://bandostand.com/product/bando-bd700/259/",html());
add("metadata description with color",official,html({extra:
  '<section id="prdDetail">Color: Brown</section>'
}));

function canonical(result){
  if(!result.ok)return result;
  const out=structuredClone(result);
  const p=out.value.product;
  p.id="PRODUCT_ID";p.code="PRODUCT_ID";
  p.createdAt="TIME";p.updatedAt="TIME";
  p.variants[0].id="VARIANT_ID";
  p.variants[0].collectedAt="TIME";
  return out;
}

test("Rust parses actual official page HTML with TS-identical SKU and option decisions",()=>{
  const req=cases.map(c=>({operation:"preview_official_product_html",payload:{
    state:c.state,url:c.url,html:c.html,
    productId:"PRODUCT_ID",variantId:"VARIANT_ID",now:"2026-11-13T12:00:00.000Z"
  }}));
  const run=spawnSync("cargo",["run","--quiet","--manifest-path",manifest,
    "--bin","parity_runner"],{
    cwd:root,encoding:"utf8",input:JSON.stringify(req),
    timeout:180000,maxBuffer:32*1024*1024
  });
  assert.equal(run.status,0,run.stderr||run.error?.message);
  const actual=JSON.parse(run.stdout);
  const mismatches=[];
  for(let i=0;i<cases.length;i++){
    try{assert.deepEqual(canonical(actual[i]),canonical(cases[i].oracle))}
    catch{mismatches.push({
      case:cases[i].name,
      expected:canonical(cases[i].oracle),
      actual:canonical(actual[i]),
    })}
  }
  assert.deepEqual(mismatches,[]);
});
