import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
const read=(path)=>readFileSync(new URL("../"+path,import.meta.url),"utf8");

test("all management pages reuse one title component and the same final CSS",()=>{
  for(const p of [
    "src/app/OrderHistory.tsx", "src/WorkflowQueue.tsx",
    "src/app/DailySettlement.tsx", "src/ProductManager.tsx",
    "src/ShippingManager.tsx", "src/ClientManager.tsx",
    "src/app/SettingsView.tsx",
  ]) assert.match(read(p),/<PageHeading\b/,p);
  const main=read("src/main.tsx");
  assert.ok(main.lastIndexOf('import "./styles/management-layout.css"') >
    main.lastIndexOf('import "./styles/table-density.css"'));
  assert.match(read("src/styles/management-layout.css"),/\.page-heading h1/);
});

test("every searchable management screen uses the shared freight-style control",()=>{
  const files=[
    "src/app/OrderHistory.tsx", "src/WorkflowQueue.tsx",
    "src/ProductManager.tsx","src/ClientManager.tsx",
    "src/ProductFreightPanel.tsx","src/ShippingManager.tsx",
  ];
  for(const p of files) {
    assert.match(read(p),/<ManagementSearch\b/,p);
    assert.match(read(p),/management-search-toolbar/,p);
  }
  const component=read("src/ui/ManagementSearch.tsx");
  assert.match(component,/className="management-search-field"/);
  assert.match(component,/aria-label=\{label\}/);
  assert.match(component,/onChange\(event\.target\.value\)/);
  const css=read("src/styles/management-layout.css");
  assert.match(css,/\.management-search-field > input/);
  const components=read("src/styles/components.css");
  const tokens=read("src/styles/tokens.css");
  assert.match(components,/background: var\(--surface-input\)/);
  assert.match(tokens,/--manage-toolbar-surface: var\(--surface-panel\)/);
  assert.match(css,/background: var\(--manage-toolbar-surface\)/);
  assert.match(css,/background: var\(--manage-table-head-surface\)/);
  assert.doesNotMatch(css,/background: #191919 !important/);
});

test("client search and client table share a width and scroll owner",()=>{
  const source=read("src/ClientManager.tsx");
  const rail=source.indexOf('"management-scroll client-list-workspace"');
  const search=source.indexOf('<ManagementSearch label="거래처 관리 검색"');
  const table=source.indexOf('<ManagementTable className="client-table">');
  assert.ok(rail>0 && search>rail && table>search);
  const css=read("src/styles/management-layout.css");
  const workflow=read("src/styles/workflow.css");
  assert.match(workflow,/\.management-scroll\s*\{[^}]*padding:\s*16px 0;/);
  assert.doesNotMatch(workflow,/\.management-scroll\s*\{[^}]*padding:\s*16px 20px;/);
  assert.match(source,/className="card client-list-panel"/);
  assert.match(source,/className="client-table-scroll"/);
  assert.match(css,/\.client-list-panel > \.client-table-scroll/);
  assert.match(css,/scrollbar-gutter: stable/);
});

test("Excel, product, and client searches belong to their content sections, not page-level chrome",()=>{
  const excel=read("src/WorkflowQueue.tsx");
  const product=read("src/ProductManager.tsx");
  const client=read("src/ClientManager.tsx");
  const category=read("src/CategoryManager.tsx");
  const color=read("src/ColorGuidanceManager.tsx");
  const css=read("src/styles/management-layout.css");
  assert.ok(excel.indexOf('className="excel-list-panel"') > excel.indexOf('className="workflow-queue-tabs management-tabbar"'));
  assert.ok(excel.indexOf('<ManagementSearch label="엑셀 목록 검색"') > excel.indexOf('className="excel-list-panel"'));
  assert.ok(excel.indexOf('className={"excel-table-scroll"') > excel.indexOf('<ManagementSearch label="엑셀 목록 검색"'));
  assert.match(product,/<PageHeading title="상품 관리" \/>/);
  assert.match(client,/<PageHeading title="거래처 관리" \/>/);
  assert.ok(product.indexOf('className="product-list-subheading"') > product.indexOf('aria-label="상품 관리 메뉴"'));
  assert.ok(product.indexOf('aria-label="상품 목록 작업"') > product.indexOf('className="product-list-subheading"'));
  assert.ok(product.indexOf('<ManagementSearch label="상품 검색" placeholder="모델명 또는 상품명 검색"') > product.indexOf('className="card product-prices"'));
  assert.ok(client.indexOf('aria-label="거래처 목록 작업"') > client.indexOf('aria-label="거래처 관리 메뉴"'));
  assert.ok(client.indexOf('<ManagementSearch label="거래처 관리 검색"') > client.indexOf('className="card client-list-panel"'));
  assert.ok(client.indexOf('<ManagementTable className="client-table"') > client.indexOf('<ManagementSearch label="거래처 관리 검색"'));
  assert.match(category,/className="catalog-panel-header"[\s\S]*<ManagementSearch label="상품 검색"/);
  assert.match(color,/className="family-list-panel"[\s\S]*<ManagementSearch label="상품 검색"/);
  assert.match(css,/\.excel-list-panel > \.excel-table-scroll/);
  assert.match(css,/\.client-list-panel > \.client-table-scroll/);
});

test("tabbed pages put tabs before their search tools",()=>{
  for (const p of ["src/WorkflowQueue.tsx","src/ProductManager.tsx","src/ClientManager.tsx"]) {
    const s=read(p);
    const tabs=s.indexOf("management-tabbar");
    const search=s.indexOf("<ManagementSearch");
    assert.ok(tabs>0 && search>tabs,p);
  }
  const shipping=read("src/ShippingManager.tsx");
  assert.ok(shipping.indexOf("management-tabbar")<shipping.indexOf("<ManagementSearch"));
  assert.match(read("src/app/SettingsView.tsx"),/settings-tab-list management-tabbar/);
});

test("Excel listing keeps its data fields inline and both table types receive suitable columns",()=>{
  const excel=read("src/WorkflowQueue.tsx");
  const css=read("src/styles/management-layout.css");
  assert.match(excel,/<ManagementTable className="excel-history-table">/);
  assert.match(excel,/<ManagementTable className="excel-queue-table">/);
  const table=read("src/ui/ManagementTable.tsx");
  assert.match(table,/<table \{\.\.\.props\} className=/);
  assert.match(table,/\["management-data-table", className\]/);
  assert.match(css,/table\.excel-queue-table th:first-child/);
  assert.match(css,/table\.excel-history-table th:first-child/);
  assert.match(css,/td > small/);
  assert.match(css,/details:not\(\[open\]\)/);
  assert.doesNotMatch(excel,/className="workflow-queue-tabs">/);
});

test("long names and item rows remain visible without reducing the reserved Kakao workspace",()=>{
  const css=read("src/styles/management-layout.css");
  assert.match(css,/table\.management-data-table/);
  assert.match(css,/table-layout: auto/);
  assert.match(css,/\.product-prices table\.management-data-table/);
  assert.doesNotMatch(css,/\.hub-kakao-slot/);
  assert.match(read("src/ProductManager.tsx"),/<ManagementTable>/);
  assert.match(read("src/ClientManager.tsx"),/<ManagementTable className="client-table">/);
  assert.match(read("src/ProductFreightPanel.tsx"),/<ManagementTable>/);
  assert.match(read("src/app/OrderHistory.tsx"),/<ManagementTable>/);
  assert.match(read("src/app/DailySettlement.tsx"),/<ManagementTable>/);
});

test("date controls stay on the same toolbar row instead of changing page heading height",()=>{
  const order=read("src/app/OrderHistory.tsx");
  const daily=read("src/app/DailySettlement.tsx");
  assert.ok(order.indexOf("<PageHeading")<order.indexOf('<div className="management-search-toolbar">'));
  assert.match(order,/DateNavigator label="접수 날짜"/);
  assert.match(daily,/<PageHeading title="일일 결산" \/>/);
  assert.match(daily,/management-search-toolbar management-date-toolbar/);
});
