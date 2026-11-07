import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const read = (file) => readFileSync(new URL("../" + file, import.meta.url), "utf8");

test("single archive root in settings, 5 category roots and no parallel reply path",()=>{
 const ui=read("src/SettingsPanel.tsx");
 assert.match(ui, /Excel 보관함 위치/);
 assert.match(ui, /excelDirectory: folder/);
 assert.doesNotMatch(ui,/factoryReplyDirectory: folder/);
 const rust=read("src-tauri/src/lib.rs");
 assert.match(rust,/chrono::\{Datelike, Local, DateTime\}/);
 assert.match(rust,/fn archive_daily_directory/);
 assert.match(rust,/format!\("\{\}년", date.year\(\)\)/);
 assert.match(rust,/format!\("\{:02\}월", date.month\(\)\)/);
 assert.match(rust,/format!\("\{:02\}일", date.day\(\)\)/);
 assert.match(rust,/format!\("\{stamp\}\(\{\}\{number\}\)\.xlsx", kind.stem\(\)\)/);
 assert.match(rust,/create_new\(true\)/);
 assert.match(rust,/WorkbookKind::FactoryReply, Local::now\(\), &bytes/);
 for(const [cat,slug] of [["Factory","공장"],["Store","매장"]]){
  assert.match(rust,new RegExp("Self::"+cat+" => \\""+slug+"\\""));
 }
});
test("workbooks only exposed in product, client, factory/store shipping screens",()=>{
 const product=read("src/ProductManager.tsx");
 const registration=read("src/RegistrationManager.tsx");
 const client=read("src/ClientWorkbookTools.tsx");
 const queue=read("src/WorkflowQueue.tsx");
 const orders=read("src/app/OrderHistory.tsx");
 const settlement=read("src/app/DailySettlement.tsx");
 assert.match(product,/상품 Excel 관리/);
 assert.match(product,/<ProductSyncWorkbookTools/);
 assert.match(product,/<RegistrationManager/);
 assert.doesNotMatch(product,/<ProductPriceWorkbookTools/);
 assert.match(client,/saveClientWorkbook/);
 assert.match(queue,/saveFactoryWorkbook/);
 assert.match(queue,/saveStoreWorkbook/);
 assert.doesNotMatch(orders,/Excel 다운로드/);
 assert.doesNotMatch(settlement,/Excel 다운로드/);
 assert.match(registration,/최근 등록 결과/);
 assert.doesNotMatch(registration,/exportRegistrationResults/);
 assert.doesNotMatch(registration,/최근 등록 결과 다운로드/);
});
