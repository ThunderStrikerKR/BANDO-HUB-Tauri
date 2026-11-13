import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const source=(path)=>readFileSync(new URL("../"+path,import.meta.url),"utf8");
test("headings, tabs, and searchable tools follow the shared business hierarchy",()=>{
  for(const p of ["src/ProductManager.tsx","src/ClientManager.tsx"]){
    const s=source(p);
    assert.ok(s.indexOf("<PageHeading")<s.indexOf('<nav className="product-subnav'));
    assert.ok(s.indexOf('<nav className="product-subnav')<s.indexOf('<ManagementSearch'));
    assert.ok(s.indexOf('<PageHeading')<s.indexOf('<ManagementSearch'));
  }
  const excel=source("src/WorkflowQueue.tsx");
  assert.match(excel,/<PageHeading title="엑셀 관리"/);
  assert.ok(excel.indexOf('className="workflow-queue-tabs')<excel.indexOf('label="엑셀 목록 검색"'));
  assert.match(excel,/<ManagementSearch label="엑셀 목록 검색"/);
  assert.match(source("src/ShippingManager.tsx"),/title="운임 관리"/);
});
test("product search belongs only to searchable subtab content",()=>{
  const s=source("src/ProductManager.tsx");
  const productTab=s.indexOf('{section === "상품 목록" && (');
  const search=s.indexOf('<ManagementSearch label="상품 검색"');
  const categoryTab=s.indexOf('{section === "카테고리 관리" && (');
  const colorTab=s.indexOf('{section === "모델군 관리" &&');
  assert.ok(productTab>0&&search>productTab&&categoryTab>search&&colorTab>categoryTab);
  assert.match(s,/<CategoryManager[\s\S]*?query=\{search\} onQueryChange=\{setSearch\}/);
  assert.match(s,/<ColorGuidanceManager[\s\S]*?query=\{search\} onQueryChange=\{setSearch\}/);
  assert.match(source("src/CategoryManager.tsx"),/<ManagementSearch label="상품 검색"/);
  assert.match(source("src/ColorGuidanceManager.tsx"),/<ManagementSearch label="상품 검색"/);
});
