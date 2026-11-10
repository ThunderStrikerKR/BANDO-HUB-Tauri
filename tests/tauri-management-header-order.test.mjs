import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const source=(path)=>readFileSync(new URL("../"+path,import.meta.url),"utf8");
test("page headings and primary actions are above search and subnavigation",()=>{
  for(const p of ["src/ProductManager.tsx","src/ClientManager.tsx"]){
    const s=source(p);
    assert.ok(s.indexOf("<PageHeading")<s.indexOf('<nav className="product-subnav"'));
    assert.ok(s.indexOf('<div className="management-search">')<s.indexOf('<nav className="product-subnav"'));
  }
  const excel=source("src/WorkflowQueue.tsx");
  assert.match(excel,/<PageHeading title="엑셀 관리"/);
  assert.ok(excel.indexOf('aria-label="엑셀 목록 검색"')<excel.indexOf('className="workflow-queue-tabs"'));
  assert.match(source("src/ShippingManager.tsx"),/title="운임 관리"/);
});
test("search is not shown in product tabs where it has no effect",()=>{
  const s=source("src/ProductManager.tsx");
  assert.match(s,/\["상품 목록", "카테고리 관리", "대표색상 관리"\]\.includes\(section\)/);
});
