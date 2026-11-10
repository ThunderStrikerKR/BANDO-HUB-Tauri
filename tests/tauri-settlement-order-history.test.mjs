import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import ExcelJS from "exceljs";

const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const compiled = new Map();
const modules = new Map();
function moduleFor(path) {
  if (modules.has(path)) return modules.get(path);
  const source = read("src/app/" + path + ".ts");
  const out = {};
  modules.set(path, out);
  const js = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
    },
  }).outputText;
  const evaluate = vm.runInThisContext("(function(exports, require, structuredClone) {\n" + js + "\n})",
    { filename: path + ".ts" });
  evaluate(out, (name) => {
    if (name === "exceljs") return ExcelJS;
    if (name.startsWith("./")) return moduleFor(name.slice(2).replace(/\.js$/, ""));
    if (name === "../domain") return {
      orderClient: (o, state) => state.clients.find((c) => c.id === o.clientId) ?? o.clientSnapshot,
      totals: (o) => o.fixtureTotals,
      statusNames: { RECEIVED: "접수", APPROVED:"승인", EXPORTED:"출력" },
    };
    if (name === "../workflow") return {
      shipmentTotals: (state, s) => s.fixtureTotals,
      shipmentContext: (state, ship) => ({
        order: state.orders.find((o) => o.id === ship.orderId),
        client: state.clients.find((c) => c.id === state.orders.find((o) => o.id === ship.orderId)?.clientId),
        recipient: state.orders.find((o) => o.id === ship.orderId)?.recipients.find((r) => r.id === ship.recipientId),
      }),
    };
    if (name === "../workspace-selection") return { onlyDeletedGroups: () => false };
    throw Error("Unknown dependency in report test: " + name);
  }, structuredClone);
  return out;
}
const { seoulDate, dailySettlement } = moduleFor("settlement-report");
const { orderHistory } = moduleFor("order-history");
const { exportDailySettlementWorkbook, exportOrderHistoryWorkbook } = moduleFor("report-workbook");
const DAY = "2026-11-07";
const other = "2026-11-06";

function base() {
  const recipient = (id, origin = "FACTORY") => ({
    id, name:"예시 수취인", address:"서울 서초구 10", phone:"02-0000-0000",
    mobile:"", note:"", items:[{id:"item:"+id, origin, quantity:1, name:"BD 709"}],
  });
  const client = (id, payment) => ({
    id, name:id+" 악기점", payment, active:true, tier:"wholesale",
    identifiers:"", contact:"", shippingFeeExcluded:false, overrides:{},
  });
  const orders = [
    { id:"order-a", clientId:"dealer-a", createdAt:"2026-11-07T00:00:00+09:00",
      confirmedAt:"2026-11-07T11:30:00+09:00", status:"APPROVED", raw:"A",
      recipients:[recipient("r-a")], paid:true, orderType:"DEALER",
      fixtureTotals:{subtotal:100000,shipping:10000,vat:11000,total:121000} },
    { id:"order-b", clientId:"dealer-b", createdAt:"2026-11-07T10:00:00+09:00",
      confirmedAt:"2026-11-07T14:00:00+09:00", status:"APPROVED", raw:"B",
      recipients:[recipient("r-b")], orderType:"AGENCY",
      fixtureTotals:{subtotal:50000,shipping:0,vat:0,total:50000} },
    { id:"order-old", clientId:"dealer-a", createdAt:"2026-11-06T15:00:00+09:00",
      confirmedAt:"2026-11-06T15:00:00+09:00", status:"APPROVED", raw:"OLD",
      recipients:[recipient("r-old")],
      fixtureTotals:{subtotal:30000,shipping:0,vat:0,total:30000} },
    { id:"order-retail", clientId:"dealer-a", createdAt:"2026-11-07T10:00:00+09:00",
      confirmedAt:"2026-11-07T11:00:00+09:00", status:"APPROVED",
      raw:"RETAIL", orderType:"RETAIL",
      recipients:[recipient("r-retail","STORE")],
      fixtureTotals:{subtotal:20000,shipping:0,vat:0,total:20000} },
    { id:"order-pending", clientId:"dealer-a", createdAt:"2026-11-07T10:00:00+09:00",
      receptionVersion:1, status:"RECEIVED", raw:"PENDING",
      recipients:[recipient("r-pending")],
      fixtureTotals:{subtotal:1,shipping:0,vat:0,total:1} },
  ];
  const shipment = (id, orderId, recipientId, totals, actual) => ({
    id, orderId, recipientId, sourceId:"source:"+orderId,
    groupId:"group:"+orderId, transferred:true, step:4, charges:{FACTORY:4000},
    ...(actual === undefined ? {} : {actualFreight:{FACTORY:actual}}),
    fixtureTotals: totals,
  });
  const account = { id:"account-1", bank:"우리", holder:"반도", number:"0001234567" };
  const payment = (id, paidAt, amount, allocations) => ({
    id, dealerId:"dealer-a", account, amount, paidAt,
    recordedAt:"2026-11-08T09:00:00+09:00", actor:"직원", memo:"",
    allocations:allocations.map(([shipmentId,amount],index)=>({
      id:id+"-"+index, shipmentId, amount,
    })),
  });
  return {
    revision:14, products:[], aliases:[], queue:[], exports:[],
    settings:{operatorName:"직원", accounts:[account]},
    clients:[client("dealer-a","PREPAID"),client("dealer-b","POSTPAID")],
    orders,
    workflow:{
      sources:[],groups:[],events:[],deliveries:[],changeRequests:[],
      shipments:[
        shipment("s-a","order-a","r-a",orders[0].fixtureTotals,3000),
        shipment("s-b","order-b","r-b",orders[1].fixtureTotals,undefined),
        shipment("s-old","order-old","r-old",orders[2].fixtureTotals,undefined),
        shipment("s-retail","order-retail","r-retail",orders[3].fixtureTotals,undefined),
      ],
      payments:[
        payment("p-old",other+"T14:00:00+09:00",20000,[["s-a",20000]]),
        payment("p-today",DAY+"T12:00:00+09:00",70000,[["s-a",60000]]),
        payment("p-prev-order",DAY+"T13:00:00+09:00",5000,[["s-old",5000]]),
      ],
      confirmations:[{id:"confirmation-a",dealerId:"dealer-a",announcedAccount:account,
        shipmentIds:["s-a"],allocations:[{shipmentId:"s-a",amount:10000}],amount:10000,
        confirmedAt:DAY+"T14:00:00+09:00",actor:"직원",groupId:"group:order-a"}],
    },
  };
}
const get = (state, date=DAY) => dailySettlement(state,date,orderHistory(state,"",date));

test("Seoul calendar day is stable across UTC offsets, midnight and year boundary", () => {
  assert.equal(seoulDate("2026-11-06T15:30:00Z"),"2026-11-07");
  assert.equal(seoulDate("2026-11-07T00:15:00+09:00"),"2026-11-07");
  assert.equal(seoulDate("2026-12-31T16:00:00Z"),"2027-01-01");
  assert.equal(seoulDate("invalid"),"");
  assert.throws(() => get(base(),"2026-02-31"),/날짜/);
});

test("order history matches Korean date and excludes unconfirmed reception drafts", () => {
  const state=base();
  const rows=orderHistory(state,"",DAY);
  assert.deepEqual(rows.map((r)=>r.order.id),["order-a","order-b","order-retail"]);
  assert.deepEqual(orderHistory(state,"",other).map((r)=>r.order.id),["order-old"]);
  assert.equal(rows[0].billing.vat,11000);
  assert.equal(rows[0].billing.total,121000);
  assert.equal(rows[0].shipmentIds[0],"s-a");
});

test("bill totals include VAT and customer shipping exactly once, never as additional cash", () => {
  const report=get(base());
  assert.equal(report.orderRows.length,3);
  assert.equal(report.billedKnown,191000);
  assert.equal(report.productKnown,170000);
  assert.equal(report.shippingKnown,10000);
  assert.equal(report.vatKnown,11000);
  assert.equal(report.paidCash,75000);
  assert.equal(report.allocatedCash,65000);
  assert.equal(report.unallocatedCash,10000);
  assert.notEqual(report.billedKnown+report.paidCash,report.billedKnown);
});

test("payments use paidAt, not order date or recordedAt, including deposits for older orders", () => {
  const state=base();
  const report=get(state);
  assert.deepEqual(report.paymentRows.map((p)=>p.id),["p-today","p-prev-order"]);
  assert.equal(report.orderRows.find((r)=>r.orderId==="order-a").paidAllocated,80000);
  assert.equal(get(state,other).paidCash,20000);
});

test("postpaid billed amount is not considered bank-paid and outstanding is separate", () => {
  const report=get(base());
  assert.equal(report.postpaidKnown,50000);
  const postpaid=report.orderRows.find((r)=>r.orderId==="order-b");
  assert.equal(postpaid.outstanding,50000);
  assert.equal(postpaid.paidAllocated,0);
});

test("approved payment is separate from actual bank cash, and current receivable is capped", () => {
  const report=get(base());
  const a=report.orderRows.find((r)=>r.orderId==="order-a");
  assert.equal(a.paymentApproved,10000);
  assert.equal(a.paidAllocated,80000);
  assert.equal(a.outstanding,31000);
  assert.equal(report.approvedPaymentKnown,10000);
  assert.equal(report.outstandingKnown,81000);
  assert.equal(report.warnings.some((w)=>w.includes("입금 승인 기록")),true);
});

test("factory actual freight is current recorded cost, never counted as customer charge or cash-out", () => {
  const report=get(base());
  const a=report.orderRows.find((r)=>r.orderId==="order-a");
  assert.equal(a.freightCost,3000);
  assert.equal(report.actualFreightKnown,3000);
  assert.equal(report.freightUnknown,2);
  assert.equal(a.shippingCharge,10000);
  assert.equal(report.paidCash,75000);
});

test("unknown prices remain unknown instead of silently turning into zero", () => {
  const state=base();
  state.workflow.shipments[1].fixtureTotals={
    subtotal:50000,shipping:null,vat:null,total:null,
  };
  const report=get(state);
  assert.equal(report.billedUnknown,1);
  assert.equal(report.billedKnown,141000);
  assert.equal(report.orderRows.find((r)=>r.orderId==="order-b").total,null);
  assert.equal(report.orderRows.find((r)=>r.orderId==="order-b").outstanding,null);
  assert.equal(report.warnings.some((w)=>w.includes("미확정")),true);
});

test("retail orders and legacy paid flags do not fabricate bank payments", () => {
  const state=base();
  const report=get(state);
  const retail=report.orderRows.find((r)=>r.orderId==="order-retail");
  assert.equal(retail.paymentTerms,"소매");
  assert.equal(retail.outstanding,null);
  assert.equal(retail.paidAllocated,0);
  // Paid flag is only a historical status, not verified as a bank transaction.
  const a=report.orderRows.find((r)=>r.orderId==="order-a");
  assert.equal(a.cashEvidenceMissing,false);
  state.workflow.payments=[];
  const missing=get(state);
  assert.equal(missing.orderRows.find((r)=>r.orderId==="order-a").cashEvidenceMissing,true,
    "An approval does not count as a verified bank receipt");
  state.workflow.confirmations=[];
  assert.equal(get(state).orderRows.find((r)=>r.orderId==="order-a").cashEvidenceMissing,true);
  assert.equal(get(state).paidCash,0);
});

test("duplicate payment IDs and over-allocated cash are rejected rather than double-counted", () => {
  const state=base();
  state.workflow.payments.push({...state.workflow.payments[1]});
  assert.throws(()=>get(state),/입금 기록 ID가 중복/);
  state.workflow.payments.pop();
  state.workflow.payments[1].allocations[0].amount=90000;
  assert.throws(()=>get(state),/실제 입금액보다 큽니다/);
});

test("actual xlsx roundtrip retains separate dated order billing and account receipts", async () => {
  const state=base();
  const report=get(state);
  const bytes=await exportDailySettlementWorkbook({date:DAY,revision:state.revision,report});
  const book=new ExcelJS.Workbook();
  await book.xlsx.load(Buffer.from(bytes));
  assert.deepEqual(book.worksheets.map((s)=>s.name),["일일 결산","접수 주문","실제 입금"]);
  const summary=book.getWorksheet("일일 결산");
  assert.equal(summary.getCell("B4").value,191000);
  assert.equal(summary.getCell("B9").value,75000);
  assert.equal(summary.getCell("B11").value,10000);
  const orders=book.getWorksheet("접수 주문");
  assert.equal(orders.rowCount,4);
  assert.equal(orders.getCell("I2").value,121000);
  assert.equal(orders.getCell("H2").value,11000);
  const receipts=book.getWorksheet("실제 입금");
  assert.equal(receipts.rowCount,3);
  assert.equal(receipts.getCell("E2").value,70000);
  assert.equal(receipts.getCell("G2").value,10000);
});

test("real XLSX history export uses current filtered rows and never changes state", async () => {
  const state=base();
  const before=JSON.stringify(state);
  const selected=orderHistory(state,"",DAY);
  const bytes=await exportOrderHistoryWorkbook(state,selected);
  const book=new ExcelJS.Workbook();
  await book.xlsx.load(Buffer.from(bytes));
  assert.equal(book.getWorksheet("주문 내역").rowCount,4);
  assert.equal(book.getWorksheet("주문 내역").getCell("I2").value,121000);
  assert.equal(book.getWorksheet("안내").getCell("A2").value,"작성 기준");
  assert.equal(JSON.stringify(state),before);
});

test("report screens keep live read-only views while Excel export buttons are deferred", () => {
  const app=read("src/App.tsx");
  const daily=read("src/app/DailySettlement.tsx");
  const history=read("src/app/OrderHistory.tsx");
  const native=read("src-tauri/src/lib.rs");
  const bridge=read("src/tauri-bridge.ts");
  assert.match(app,/<DailySettlement state=\{state\}/);
  assert.match(daily,/dailySettlement\(state, date, orderHistory\(state, "", date\)\)/);
  // Keep actual daily settlement and order-history queries, filters and warnings.
  assert.match(daily, /report\.orderRows\.map/);
  assert.match(daily, /report\.paymentRows\.map/);
  assert.match(daily, /report\.warnings\.map/);
  assert.match(history, /orderHistory\(state, query, date\)/);
  assert.match(history, /value=\{query\} onChange=\{onQuery\}/);
  assert.match(history, /onOpen\(row\.order\)/);
  // Excel export is intentionally deferred: no actionable download control or handler.
  assert.doesNotMatch(daily, /현재 결산 Excel 다운로드|saveSettlementWorkbook|exportDailySettlementWorkbook/);
  assert.doesNotMatch(history, /조회 결과 Excel 다운로드|saveOrderHistoryWorkbook|exportOrderHistoryWorkbook/);
  // The generation and native export plumbing are retained for later reactivation.
  const workbook = read("src/app/report-workbook.ts");
  assert.match(workbook, /exportDailySettlementWorkbook/);
  assert.match(workbook, /exportOrderHistoryWorkbook/);
  assert.match(history,/소매 주문 \/ 결제 증빙 별도 확인/);
  assert.match(native,/async fn save_settlement_workbook/);
  assert.match(native,/async fn save_order_history_workbook/);
  assert.match(bridge,/saveSettlementWorkbook: \(bytes\)/);
  assert.match(bridge,/saveOrderHistoryWorkbook: \(bytes\)/);
});
