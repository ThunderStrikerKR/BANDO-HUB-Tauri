import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const read = (path) => readFileSync(new URL("../" + path, import.meta.url), "utf8");
const javascript = ts.transpileModule(read("src/official-links.ts"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const api = {};
const invokeModule = vm.runInThisContext("(function(exports, URL){\n" + javascript + "\n})");
invokeModule(api, URL);
const { officialLinksFromSnapshot } = api;
const product = (siteId,name,urls) => ({
  name, siteId, variants: urls.map(url=>({url})),
});
test("bundled official catalog produces distinct usable detail links without claiming freshness",()=>{
  const report=JSON.parse(read("src-tauri/resources/catalog.json"));
  const links=officialLinksFromSnapshot(report);
  assert.ok(links.length > 100);
  assert.ok(links.length <= report.products.length);
  assert.equal(new Set(links.map(x=>x.url)).size, links.length);
  assert.ok(links.every(x=>x.url.startsWith("https://bandostand.com/") ||
    x.url.startsWith("https://www.bandostand.com/") ||
    x.url.startsWith("https://bandomall.co.kr/") ||
    x.url.startsWith("https://www.bandomall.co.kr/")));
  assert.ok(links.every(x=>x.name.trim().length > 0));
});
test("duplicates, unrecognized IDs and unsafe URLs are excluded",()=>{
  const report={products:[
    product("42","상품42",["https://bandostand.com/product/detail.html?product_no=42"]),
    product("42","상품42 다른옵션",["https://bandostand.com/product/detail.html?product_no=42"]),
    product("43","상품43",["https://bandostand.com/product/new/43/"]),
    product("99","불일치",["https://bandostand.com/product/detail.html?product_no=98"]),
    product("51","악성호스트",["https://bandostand.com.evil.test/product/detail.html?product_no=51"]),
    product("52","암호가 포함된 URL",["https://a:b@bandostand.com/product/detail.html?product_no=52"]),
    product("53","비공식 포트",["https://bandostand.com:8443/product/detail.html?product_no=53"]),
    product("54","리다이렉트 우회",["https://bandostand.com/product/detail.html?product_no=54&product_no=55"]),
    product("55","HTTP",["http://bandostand.com/product/detail.html?product_no=55"]),
    product("56","다른 경로",["https://bandostand.com/shopinfo/guide.html"]),
    product("57","없는 링크",[]),
  ]};
  const result=officialLinksFromSnapshot(report);
  assert.deepEqual(result.map(x=>x.name).sort(),["상품42","상품43"]);
});
test("bridge and screen load cached snapshot but fetch live official detail separately",()=>{
  const bridge=read("src/tauri-bridge.ts"), ui=read("src/ProductImports.tsx");
  assert.match(bridge,/officialList: async \(\) => businessCoreCall\("catalog_clients", "official_links"/);
  assert.match(bridge,/fetch_official_product_html/);
  assert.doesNotMatch(bridge,/officialList: async \(\) => notReady/);
  assert.match(ui,/내장 수집본에서 상품 찾기/);
  assert.match(ui,/현재 홈페이지 전체 목록이 아닙니다/);
  assert.match(ui,/setUrl\(link.url\)/);
  assert.match(ui,/matchingLinks.slice\(0, 40\)/);
  assert.match(ui,/window.bando!\.previewImport\(url.trim\(\)\)/);
});
