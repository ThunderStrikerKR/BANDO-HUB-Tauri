import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const source=(path)=>readFileSync(new URL("../"+path,import.meta.url),"utf8");
test("headings, tabs, and searchable tools follow the shared business hierarchy",()=>{
  for(const p of ["src/ProductManager.tsx","src/ClientManager.tsx"]){
    const s=source(p);
    assert.ok(s.indexOf("<PageHeading")<s.indexOf('<nav className="product-subnav"'));
    assert.ok(s.indexOf('<nav className="product-subnav')<s.indexOf('<ManagementSearch'));
    assert.ok(s.indexOf('<PageHeading')<s.indexOf('<ManagementSearch'));
  }
  const excel=source("src/WorkflowQueue.tsx");
  assert.match(excel,/<PageHeading title="엑셀 관리"/);
  assert.ok(excel.indexOf('className="workflow-queue-tabs')<excel.indexOf('label="엑셀 목록 검색"'));
  assert.match(excel,/<ManagementSearch label="엑셀 목록 검색"/);
  assert.match(source("src/ShippingManager.tsx"),/title="운임 관리"/);
});
test("search is not shown in product tabs where it has no effect",()=>{
  const s=source("src/ProductManager.tsx");
  assert.match(s,/\["상품 목록", "카테고리 관리", "대표색상 관리"\]\.includes\(section\)/);
});
