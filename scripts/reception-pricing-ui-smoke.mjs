import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { setTimeout as pause } from "node:timers/promises";
import { chromium } from "playwright";

// A real React UI test with synthetic, locally mocked Tauri state.
// No business database, remote API, or production carrier is accessed.
const state = JSON.parse(readFileSync(
  new URL("../src-tauri/resources/state-seed.json", import.meta.url), "utf8"));
const product = state.products.find(p => p.variants?.length && p.catalog !== "DEMO");
assert.ok(product, "A real catalogue product fixture is required");
const variant = product.variants[0];
const client = {
  id:"ci-persisted-dealer", name:"CI 과거거래처", displayName:"CI 과거거래처",
  address:"경기도 검증시 과거로 12", phone:"031-0000-0000", mobile:"",
  contact:"검증 담당", tier:"wholesale", payment:"PREPAID",
  shippingFeeExcluded:false, active:true, identifiers:"", overrides:{},
};
const item = {
  id:"ci-price-item", name:product.name, productId:product.id, variantId:variant.id,
  raw:"기존 상품 1개", color:variant.color, quantity:1, origin:"FACTORY",
  unitPrice:17777, sources:[], issues:[],
};
const recipient = {
  id:"ci-price-recipient", name:"과거단가보존", address:"서울특별시 검증로 13",
  phone:"", mobile:"010-0000-0000", note:"", items:[item],
  dispatchOrigin:"FACTORY",
};
const historical = {
  id:"ci-price-order", clientId:client.id, clientSnapshot:client,
  orderType:"AGENCY", raw:"CI 저장된 과거 주문 / 상품 가격 운임 보존",
  recipients:[recipient], createdAt:"2026-11-08T09:00:00Z",
  updatedAt:"2026-11-08T09:00:00Z", status:"REVIEW",
  notified:false, paid:false, postpaidApproved:false,
  shippingFee:7555, shippingMode:"AUTO", shippingVersion:"archived-rule-id",
  pricesLocked:false, applyVat:false, vatAmount:null, freightCode:"010",
};
state.clients.push(client);
state.orders.push(historical);
state.workflow.sources.push({
  id:"ci-price-source", number:500, orderId:historical.id, dealerId:client.id,
  raw:historical.raw, createdAt:historical.createdAt,
});
state.workflow.groups.push({
  id:"ci-price-group", rootGroupId:"ci-price-group",
  sourceId:"ci-price-source", dealerId:client.id,
  createdAt:historical.createdAt, notices:[], needsNotice:false,
});
state.workflow.shipments.push({
  id:"ci-price-shipment", sourceId:"ci-price-source", groupId:"ci-price-group",
  orderId:historical.id, recipientId:recipient.id,
  step:1, transferred:false, completedAt:{},
  recipientSnapshot:structuredClone(recipient), charges:{FACTORY:7555},
  chargeMode:"AUTO", freightVersion:"archived-rule-id",
  infoSignature:"original-price", sender:client,
});
const url="http://127.0.0.1:5174/";
const root = new URL("../",import.meta.url);
const server = spawn(process.execPath,
  ["node_modules/vite/bin/vite.js","--host","127.0.0.1","--port","5174","--strictPort"],
  {cwd:root,stdio:["ignore","pipe","pipe"]});
let serverOutput="";
server.stdout.on("data", c=>{serverOutput+=c.toString()});
server.stderr.on("data", c=>{serverOutput+=c.toString()});
let browser;
try {
  let ready=false;
  for(let n=0;n<90;n++){
    if(server.exitCode!==null)throw Error("Vite startup failed: "+serverOutput);
    try{const response=await fetch(url,{signal:AbortSignal.timeout(1300)});
      if(response.ok){ready=true;break}
    }catch{/* retry */}
    await pause(350);
  }
  assert.ok(ready,"Vite not ready: "+serverOutput);
  browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width:1520,height:1000}});
  page.setDefaultTimeout(15000);
  const errors=[];
  const consoleErrors=[];
  page.on("pageerror",error=>errors.push(error.message));
  page.on("console",msg=>{if(msg.type()==="error")consoleErrors.push(msg.text())});
  await page.addInitScript(({savedState})=>{
    let backend=structuredClone(savedState);
    let reads=0;
    let writes=0;
    window.__historicState=()=>({
      state:structuredClone(backend), reads,writes,
    });
    window.__changeMasterForTest=()=>{
      const old=backend.products[0];
      backend.products[0]={...old,name:old.name+" / NEW MASTER"};
      backend.shipping??={groups:[],productRules:{},combinations:[],epoch:1};
      backend.shipping.epoch=(backend.shipping.epoch??1)+1;
      backend.revision=(backend.revision??0)+1;
    };
    window.__TAURI_INTERNALS__={
      invoke:async(cmd,args={})=>{
        if(cmd==="workspace_mode")return false;
        if(cmd==="startup_status")return {phase:"READY",attempts:1,isTest:false};
        if(cmd==="startup_metrics")return {
          windowShownMs:null,databaseMs:1,dataMs:null,readyMs:1,
        };
        if(cmd==="state_load"){reads++;return structuredClone(backend)}
        if(cmd==="dock_status_native")return {active:false,mode:"ORIGINAL",ratio:0.8};
        if(cmd==="product_image")return null;
        if(cmd==="state_save"){writes++;throw Error("Read-only historical order was unexpectedly saved")}
        throw Error("Unexpected history UI IPC: "+cmd);
      },
    };
  },{savedState:state});

  await page.goto(url);
  const nav=page.getByRole("navigation",{name:"업무 메뉴"});
  await nav.getByRole("button",{name:"주문 내역"}).click();
  await page.getByRole("button",{name:"전체 날짜"}).click();
  await page.getByRole("textbox",{name:"주문 검색"}).fill("CI 저장된 과거 주문");
  const historicalRow=page.locator(".order-history-list tbody tr")
    .filter({hasText:"과거단가보존"});
  await historicalRow.waitFor();
  await historicalRow.getByRole("button",{name:"주문 열기"}).click();
  await pause(350);
  const afterOpen=await page.evaluate(()=>({
    heading:[...document.querySelectorAll("h1,h2")].map(n=>n.textContent?.trim()).slice(0,16),
    visibleWorkspace:[...document.querySelectorAll(".hub-live-workspace")]
      .map(n=>({visible:!!n.getClientRects().length,outer:n.parentElement?.outerHTML.slice(0,350)})),
    notices:[...document.querySelectorAll('[role="alert"], [role="dialog"]')]
      .map(n=>n.textContent?.trim().slice(0,450)),
    body:document.body.innerText.slice(0,2500),
  }));
  console.log("RECEPTION_PRICING_OPEN_DIAG",JSON.stringify({afterOpen,errors,consoleErrors}));
  await page.locator(".hub-live-workspace").waitFor({state:"visible"});
  // Let mounted effects and nested workflow previews settle before navigation.
  await pause(350);
  assert.equal(await page.getByRole("dialog",{name:"변경사항 저장"}).count(),0,
    "Opening a saved order must never request confirmation");

  // Simulate background refresh of product and freight masters without
  // touching the saved order. The app polls native state periodically.
  const initialReads=(await page.evaluate(()=>window.__historicState())).reads;
  await page.evaluate(()=>window.__changeMasterForTest());
  await page.waitForFunction(before=>
    window.__historicState().reads>before, initialReads,{timeout:12000});
  await pause(250);
  await nav.getByRole("button",{name:"상품 관리"}).click();
  await page.getByRole("heading",{name:/상품 가격표/}).waitFor({timeout:8000});
  assert.equal(await page.getByRole("dialog",{name:"변경사항 저장"}).count(),0,
    "Background catalogue refresh must not make a saved order dirty");

  const result=await page.evaluate(()=>window.__historicState());
  const stored=result.state.orders.find(order=>order.id==="ci-price-order");
  assert.equal(stored.recipients[0].items[0].unitPrice,17777);
  assert.equal(stored.shippingFee,7555);
  assert.equal(stored.shippingVersion,"archived-rule-id");
  assert.equal(result.writes,0,"Passive refresh must never write an order");
  assert.deepEqual(errors,[],"React runtime errors: "+errors.join("\n"));
  console.log("PASS: Saved historical order remains clean across opening and master refresh",
    JSON.stringify({reads:result.reads,writes:result.writes,
      unitPrice:stored.recipients[0].items[0].unitPrice,
      freight:stored.shippingFee,freightVersion:stored.shippingVersion}));
  await page.close();
} finally {
  if(browser)await browser.close();
  server.kill("SIGTERM");
}
