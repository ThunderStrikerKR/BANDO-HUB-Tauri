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
  assert.match(css,/background: #191919 !important/);
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
  assert.match(excel,/management-data-table excel-history-table/);
  assert.match(excel,/management-data-table excel-queue-table/);
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
  assert.match(read("src/ProductManager.tsx"),/className="management-data-table"/);
  assert.match(read("src/ClientManager.tsx"),/client-table management-data-table/);
});

test("date controls stay on the same toolbar row instead of changing page heading height",()=>{
  const order=read("src/app/OrderHistory.tsx");
  const daily=read("src/app/DailySettlement.tsx");
  assert.ok(order.indexOf("<PageHeading")<order.indexOf('<div className="management-search-toolbar">'));
  assert.match(order,/DateNavigator label="접수 날짜"/);
  assert.match(daily,/<PageHeading title="일일 결산" \/>/);
  assert.match(daily,/management-search-toolbar management-date-toolbar/);
});
