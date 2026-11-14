// Actual Windows Tauri EXE + real WebView2 + real Rust IPC, no mocked commands.
// CI audit binary uses the same source with a temporary Tauri window CDP flag.
// Production tauri.conf.json contains no remote-debugging argument.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { dirname, resolve, join, basename } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright";

if (process.platform !== "win32") throw Error("Native reception audit requires Windows");
const exe = resolve(process.env.BANDO_NATIVE_EXE || "");
assert.match(exe,/\.exe$/i);
await fs.access(exe);
const out=resolve(process.env.BANDO_NATIVE_OUT || "native-reception-evidence");
await fs.mkdir(out,{recursive:true});
const root=await fs.mkdtemp(join(tmpdir(),"bando-native-reception-"));
const port=19651;
const binCommit=process.env.BANDO_NATIVE_BIN_COMMIT || "";
// The developer TEST DB clones the master records from an existing DB.
// This disposable CI VM has no user data. First let the actual Tauri EXE
// initialize a synthetic master database. Never overwrite an existing DB.
assert.equal(process.env.GITHUB_ACTIONS,"true","Synthetic bootstrap is CI-only");
const baseline=resolve(process.env.APPDATA||"",
  "com.bandostand.bandohub.tauri","bando-hub-v001.sqlite");
try{
  await fs.access(baseline);
  throw Error("Refusing to use an existing baseline DB");
}catch(e){if(e?.code!=="ENOENT")throw e;}
console.log("CI_BASELINE_PATH",JSON.stringify({
  expected:baseline,APPDATA:process.env.APPDATA,USERPROFILE:process.env.USERPROFILE,
  root,exe,
}));
const bootstrap=spawn(exe,[],{
  cwd:dirname(exe),windowsHide:false,stdio:["ignore","pipe","pipe"],
  env:{...process.env,WEBVIEW2_USER_DATA_FOLDER:join(root,"bootstrap-webview2")},
});
let bootstrapOut="",bootstrapErr="";
bootstrap.stdout?.on("data",part=>bootstrapOut+=part.toString());
bootstrap.stderr?.on("data",part=>bootstrapErr+=part.toString());
try{
  let ready=false;
  for(let n=0;n<120;n++){
    if(bootstrap.exitCode!==null)throw Error("Native baseline exited "+bootstrap.exitCode);
    // SQLite uses WAL mode: the main file may stay at 4096 bytes while
    // the schema/data live in -wal until the process closes.
    try{if((await fs.stat(baseline)).size>0){ready=true;break;}}
    catch{/* opening */}
    await sleep(300);
  }
  if(!ready){
    console.error("NATIVE_BOOTSTRAP_DIAGNOSTICS",JSON.stringify({
      expected:baseline,exitCode:bootstrap.exitCode,
      stderr:bootstrapErr.slice(-5000),stdout:bootstrapOut.slice(-3000),
    }));
    try{
      const report=execFileSync("pwsh.exe",[
        "-NoProfile","-ExecutionPolicy","Bypass",
        "-File",resolve("scripts/stage9-windows-desktop-probe.ps1"),
        "-ProcessId",String(bootstrap.pid),"-OutDir",out,
      ],{encoding:"utf8",timeout:30000});
      await fs.writeFile(join(out,"native-bootstrap-probe.json"),report,"utf8");
      console.log("NATIVE_BOOTSTRAP_PROBE",report.slice(0,3000));
    }catch(error){console.error("NATIVE_BOOTSTRAP_PROBE_ERROR",String(error));}
  }
  assert.ok(ready,"Native Tauri did not initialize disposable CI baseline");
  await sleep(1700);
}finally{
  if(bootstrap.exitCode===null){
    // CI-audit WebView2 CDP flags are also baked into the bootstrap EXE.
    // Kill the whole Windows process tree BEFORE its parent exits; merely
    // killing the Tauri parent can leave an orphan WebView2 CDP port open.
    try{
      execFileSync("taskkill.exe",["/PID",String(bootstrap.pid),"/T","/F"],
        {stdio:"pipe",timeout:12000});
    }catch(error){
      console.error("NATIVE_BOOTSTRAP_TREE_CLEANUP",String(error));
      bootstrap.kill();
    }
  }
  await sleep(1100);
  // The CDP port must belong exclusively to the subsequent TEST workspace.
  let busy=[];
  for(let n=0;n<15;n++){
    try{
      busy=execFileSync("netstat.exe",["-ano"],
        {encoding:"utf8",timeout:8000}).split(/\r?\n/)
        .filter(line=>line.includes(":"+port)&&/LISTENING/i.test(line));
    }catch{busy=[];}
    if(!busy.length)break;
    await sleep(250);
  }
  assert.equal(busy.length,0,"Bootstrap held the CI WebView2 CDP port");
}
console.log("NATIVE_CI_BASELINE_CREATED",baseline);

const report={
  type:"real-Windows-Tauri-WebView2-IPC",
  automationCommit:process.env.GITHUB_SHA || "",
  sourceBinaryCommit:binCommit,exe:basename(exe),
  testWorkspace:true,usesMockIPC:false,
  started:new Date().toISOString(),status:"STARTED",
  screens:[],checks:[],issues:[],diagnostics:{},
};
const persist=()=>fs.writeFile(join(out,"native-reception-audit.json"),
  JSON.stringify(report,null,2),"utf8");
await persist();
let stderr="",stdout="",browser;
const app=spawn(exe,["--bando-developer-test"],{
  cwd:dirname(exe),windowsHide:false,stdio:["ignore","pipe","pipe"],
  env:{
    ...process.env,
    WEBVIEW2_USER_DATA_FOLDER:join(root,"webview2"),
  },
});
app.stderr?.on("data",b=>stderr+=b.toString());
app.stdout?.on("data",b=>stdout+=b.toString());
report.pid=app.pid;
const record=(name,payload={})=>{report.checks.push({name,...payload});console.log("NATIVE_RECEPTION_CHECK",name,JSON.stringify(payload));};
const snap=async(page,name)=>{
  const file=name+".png";
  await page.screenshot({path:join(out,file),animations:"disabled",timeout:30000});
  report.screens.push({name,file,viewport:await page.evaluate(()=>({
    width:innerWidth,height:innerHeight
  }))});
  await persist();
};
try{
  let target;
  for(let n=0;n<160;n++){
    if(app.exitCode!==null)throw Error("Native EXE terminated early "+app.exitCode+": "+stderr.slice(-1500));
    try{
      const response=await fetch("http://127.0.0.1:"+port+"/json/list",
        {signal:AbortSignal.timeout(850)});
      if(response.ok){
        const targets=await response.json();
        report.diagnostics.targets=targets.map(x=>({
          type:x.type,title:x.title,url:x.url
        }));
        target=targets.find(x=>x.type==="page"&&/tauri|localhost/i.test(x.url||""))
          ?? targets.find(x=>x.type==="page");
        if(target)break;
      }
    }catch{/* startup */}
    await sleep(350);
  }
  if(!target){
    // Retain forensic evidence for CDP failures; never fake an IPC result.
    report.diagnostics.cdp={
      port,appPid:app.pid,appExitCode:app.exitCode,
      stdoutTail:stdout.slice(-2000),stderrTail:stderr.slice(-3000),
      portConnections:[],
    };
    try {
      report.diagnostics.cdp.portConnections=execFileSync("netstat.exe",["-ano"],
        {encoding:"utf8",timeout:10000}).split(/\r?\n/).filter(x=>x.includes(":"+port));
    }catch(e){report.diagnostics.cdp.portError=String(e);}
    try {
      const processes=execFileSync("pwsh.exe",["-NoProfile","-Command",
        "Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'msedgewebview2|bando_hub' } | Select-Object Name,ProcessId,ParentProcessId | ConvertTo-Json -Depth 3"],
        {encoding:"utf8",timeout:12000});
      report.diagnostics.cdp.processes=JSON.parse(processes);
    }catch(e){report.diagnostics.cdp.processError=String(e);}
    console.error("NATIVE_CDP_NOT_FOUND",JSON.stringify(report.diagnostics.cdp));
    await persist();
    // UIAutomation-only fallback cannot prove the new P1/P2 Rust IPC actions.
    if (process.env.BANDO_P1P2_AUDIT === "true") {
      throw Error("P1/P2 native audit requires real WebView2 CDP and Rust IPC; UIA-only is not sufficient");
    }
    try{
      const outText=execFileSync("pwsh.exe",[
        "-NoProfile","-ExecutionPolicy","Bypass",
        "-File",resolve("scripts/stage9-windows-desktop-probe.ps1"),
        "-ProcessId",String(app.pid),"-OutDir",out,
      ],{encoding:"utf8",timeout:35000});
      report.diagnostics.desktopProbe=JSON.parse(outText);
    }catch(e){report.diagnostics.desktopProbeError=String(e);}
    const nativeUia=execFileSync("pwsh.exe",[
      "-NoProfile","-Sta","-ExecutionPolicy","Bypass",
      "-File",resolve("scripts/migration03-reception-native-uia.ps1"),
      "-ProcessId",String(app.pid),"-OutDir",out,
    ],{encoding:"utf8",timeout:150000,maxBuffer:8*1024*1024});
    report.diagnostics.uiaLogTail=nativeUia.slice(-2500);
    const uia=JSON.parse(await fs.readFile(
      join(out,"native-reception-uia.json"),"utf8"));
    report.diagnostics.uia={
      status:uia.status,checks:uia.checks,captures:uia.captures,
      initialNodes:uia.initialNodes,finalNodes:uia.finalNodes,
    };
    assert.equal(uia.status,"NATIVE_RECEPTION_UIA_PASSED",
      "WebView2 CDP unavailable and actual Windows UIAutomation failed");
    report.status="NATIVE_RECEPTION_UIA_PASSED_CDP_UNAVAILABLE";
    report.limitations=[
      "Real Tauri screen and UIAutomation passed; no fake browser or IPC",
      "CDP unavailable: direct per-operation native IPC trace unverified",
      "Only GitHub Windows runner 1024x768 geometry verified"
    ];
    console.log("NATIVE_RECEPTION_UIA_PASS",JSON.stringify(report.diagnostics.uia));
    await persist();
  } else {
  browser=await chromium.connectOverCDP("http://127.0.0.1:"+port,{timeout:20000});
  const context=browser.contexts()[0];
  const page=context?.pages().find(x=>/tauri|localhost/i.test(x.url()))??context?.pages()[0];
  assert.ok(page,"Real Tauri WebView2 page missing");
  page.setDefaultTimeout(30000);
  page.on("pageerror",e=>report.issues.push("pageerror: "+e.message));
  page.on("console",m=>{if(m.type()==="error")report.issues.push("console: "+m.text())});
  await page.locator("nav[aria-label='업무 메뉴']").waitFor({timeout:60000});
  const native=await page.evaluate(async()=>{
    if(!window.bando || !window.__TAURI_INTERNALS__?.invoke)
      throw Error("Actual native Tauri bridge missing");
    return {
      href:location.href,userAgent:navigator.userAgent,
      testWorkspace:window.bando.isTestWorkspace,
      workspaceMode:await window.bando.workspaceMode(),
      startup:await window.bando.startupStatus(),
      before:await window.bando.load(),
    };
  });
  report.diagnostics.native={
    href:native.href,userAgent:native.userAgent,
    testWorkspace:native.testWorkspace,workspaceMode:native.workspaceMode,
    startup:native.startup,
    initialOrders:native.before.orders?.length??null,
  };
  assert.ok(!native.href.startsWith("http://127.0.0.1:517"),"Vite page is not native");
  assert.equal(native.workspaceMode,true,"Must be an isolated developer TEST DB");
  assert.equal(native.startup.phase,"READY");
  record("actual Windows EXE and TEST SQLite started",report.diagnostics.native);
  await snap(page,"01-real-tauri-reception-initial");

  // Tauri defines __TAURI_INTERNALS__.invoke as nonwritable and nonconfigurable.
  // CI-only bridge instrumentation records actual React-bound calls immediately
  // before forwarding them to that unmodified real Rust IPC dispatcher.
  await page.evaluate(()=>{
    window.__bandoNativeCalls=[];
    const descriptor=Object.getOwnPropertyDescriptor(window.__TAURI_INTERNALS__,"invoke");
    if(descriptor?.writable!==false || descriptor?.configurable!==false){
      throw Error("Unexpected Tauri native invoke descriptor; audit bridge contract changed");
    }
  });

  if (process.env.BANDO_P1P2_AUDIT === "true") {
    // This branch builds the *exact HEAD binary* and tests these same Rust
    // commands through its actual Windows WebView2 Tauri IPC, not fake JS.
    await page.getByRole("button",{name:"운임 관리",exact:true}).click();
    await page.locator(".shipping-product-list").waitFor({timeout:60000});
    await page.waitForFunction(()=>
      (window.__bandoNativeCalls||[]).some(call=>
        call.command==="business_core_call"&&call.domain==="rules"&&
        call.operation==="apply_shipping_action"&&
        call.action==="product_freight_view"),null,{timeout:60000});
    await snap(page,"04-native-p1p2-product-freight");
    const probes=await page.evaluate(async()=>{
      const call=(operation,payload)=>window.__TAURI_INTERNALS__.invoke(
        "business_core_call",{domain:"rules",operation,payload});
      const before=await window.bando.load();
      const product={
        id:"p1-probe",name:"BD 709",origin:"FACTORY",defaultColor:"Black",
        shippingGroupId:"probe-group",variants:[{
          id:"v1",color:"Black",wholesale:30000,retail:40000,semi:35000
        }]
      };
      const client={id:"dealer-probe",tier:"wholesale"};
      const shipping={
        epoch:1,groups:[{id:"probe-group",name:"가상 운임 그룹",history:[],
          current:{version:"v1",at:"2026-11-15T00:00:00Z",
            fees:{"1":null},perItem:3000,maxBundle:1,maxConfirmed:true,notes:"검수"} }],
        productRules:{},combinations:[]
      };
      const state={
        products:[product],shipping,
        settings:{provisionalProductNotices:{"p1-probe":"가상 안내문"}},
        factoryReplies:[
          {id:"review-1",rows:[{row:5,applied:false}]},
          {id:"review-resolution",resolves:{id:"review-1",row:5},
            rows:[{row:5,applied:true}]}
        ]
      };
      const item=await call("create_catalog_item",{
        product,client,newItemId:"native-probe-item",variantId:"v1",
        color:"Black",quantity:1});
      if(item.item?.unitPrice!==30000||item.item?.variantId!=="v1"){
        throw Error("Native catalog item creation is inconsistent");
      }
      const freight=await call("apply_shipping_action",{
        action:"product_freight_view",state
      });
      if(freight.views?.["p1-probe"]?.group?.id!=="probe-group"||
        freight.views?.["p1-probe"]?.editableRule?.fees?.["1"]!==3000){
        throw Error("Native effective/editable freight projection is inconsistent");
      }
      const review=await call("factory_reply_review_statuses",{state});
      const original=review.reviews.find(x=>x.id==="review-1");
      if(original?.needsReview!==false||original?.resolvedRows?.[0]?.resolved!==true){
        throw Error("Native factory row resolution failed");
      }
      const allowed=await call("validate_provisional_product_notices",{state});
      if(allowed.valid!==true)throw Error("Native provisional notice validation failed");
      let invalidRejected=false;
      try {
        await call("validate_provisional_product_notices",{state:{
          ...state,settings:{provisionalProductNotices:{"missing-product":"안내"}}
        }});
      } catch {invalidRejected=true;}
      if(!invalidRejected)throw Error("Native notice validator allowed unknown product");
      const reset=await call("apply_shipping_action",{
        action:"reset_product_freight_rule",state,productId:"p1-probe",
        versionId:"v2",now:"2026-11-15T01:00:00Z"
      });
      if(reset.state?.shipping?.groups?.[0]?.current?.version!=="v2"||
        reset.state?.shipping?.groups?.[0]?.history?.[0]?.version!=="v1"||
        shipping.groups[0].current.version!=="v1"){
        throw Error("Native freight change did not preserve previous tariff");
      }
      const after=await window.bando.load();
      if(after.revision!==before.revision||
        JSON.stringify(after.orders)!==JSON.stringify(before.orders)){
        throw Error("Pure P1/P2 Rust probes changed persisted test orders");
      }
      return {itemPrice:item.item.unitPrice,
        effectiveFee:freight.views["p1-probe"].editableRule.fees["1"],
        historicalTariff:reset.state.shipping.groups[0].history[0].version,
        savedTariff:reset.state.shipping.groups[0].current.version,
        resolvedFactoryRow:original.resolvedRows[0].resolved,
        noticeValidated:allowed.valid,invalidNoticeRejected:invalidRejected,
        databaseRevisionUnchanged:true};
    });
    record("real Windows EXE P1/P2 business rules, native IPC and SQLite preservation",probes);
    await page.getByRole("button",{name:"접수",exact:true}).click();
    await page.locator(".source-pane").waitFor({timeout:60000});
  }

  const raw=[
    "김가상","010-1234-5678","경기도 의정부시 시민로 100",
    "709 2개","박가상","010-2345-6789",
    "서울특별시 마포구 월드컵로 20","GT-1 1개"
  ].join("\n");
  await page.evaluate(async text=>window.bando.copy(text),raw);
  await page.getByRole("button",{name:"대리발송",exact:true}).click();
  try {
    await page.waitForFunction(()=>{
      const calls=window.__bandoNativeCalls||[];
      return calls.some(x=>x.command==="business_core_call"&&
        x.domain==="recognition"&&x.operation==="analyze_order");
    },null,{timeout:18000});
  }catch(error){
    // Native reception may be blocked by a stale UI request before analysis.
    // Capture real calls and visible source state instead of misclassifying
    // this as a WebView2 or Rust compiler error.
    const detail=await page.evaluate(()=>({
      calls:window.__bandoNativeCalls||[],
      sourceText:document.querySelector(".source-document")?.textContent?.slice(0,600),
      sourcePane:document.querySelector(".source-pane")?.textContent?.slice(0,1000),
      reviewText:document.querySelector(".review-pane")?.textContent?.slice(0,800),
      alerts:[...document.querySelectorAll('[role="alert"],.source-error,.form-error')]
        .map(e=>e.textContent?.slice(0,300)),
      path:location.href,
    }));
    report.diagnostics.receptionAfterPaste=detail;
    console.error("NATIVE_RECEPTION_PASTE_DIAGNOSTIC",JSON.stringify(detail));
    await persist();
    try{await snap(page,"05-native-reception-paste-diagnostic");}catch(e){
      console.error("NATIVE_RECEPTION_DIAGNOSTIC_SCREENSHOT",String(e));
    }
    throw error;
  }
  await page.waitForFunction(()=>{
    const el=document.querySelector(".source-document");
    return el && el.querySelectorAll(".linked-token").length>=5 &&
      document.querySelector(".review-pane")?.textContent?.includes("김가상") &&
      document.querySelector(".review-pane")?.textContent?.includes("박가상");
  },null,{timeout:50000});
  const details=await page.evaluate(async()=>{
    const invoke=window.__bandoNativeCalls || [];
    const linked=[...document.querySelectorAll(".source-document .linked-token")]
      .map(e=>({text:e.textContent,link:e.getAttribute("data-link-key")}));
    const review=document.querySelector(".review-pane");
    const snapshot=await window.bando.load();
    const clipped=window.__bandoNativeCalls.some(c=>c.command==="clipboard_read");
    return {
      invoke,linked,reviewText:(review?.textContent||"").slice(0,5000),
      clipped,orders:snapshot.orders?.length||0,
    };
  });
  assert.ok(details.invoke.some(c=>c.command==="business_core_call"&&
    c.domain==="recognition"&&c.operation==="analyze_order"),
    "React must actually invoke native Rust recognition");
  assert.ok(details.clipped,"Native clipboard read must be used");
  assert.ok(details.linked.some(x=>x.text?.includes("709")));
  assert.ok(details.linked.some(x=>x.text?.includes("GT-1")));
  assert.equal(details.orders,native.before.orders?.length??0,
    "Viewing an unconfirmed order must not write to SQLite");
  assert.ok(!details.invoke.some(x=>x.command==="state_save"),
    "Unconfirmed analysis must not persist a draft");
  record("actual Rust recognize_order reached from rendered reception UI",{
    nativeIPC:details.invoke.filter(x=>x.command==="business_core_call"),
    linkedEvidence:details.linked.length,readClipboard:details.clipped,
    persistedOrders:details.orders,
  });
  await snap(page,"02-native-rust-recognized-two-shipments");

  // Validate the reception UI at compact viewport without claiming a true
  // physical monitor reconfiguration. Record exact CSS geometry / overflow.
  await page.setViewportSize({width:1024,height:768});
  await sleep(350);
  const geometry=await page.evaluate(()=>{
    const selectors=[".source-pane",".source-heading",".source-heading-actions",
      ".source-document",".review-pane"];
    const visible=(el)=>!!el&&getComputedStyle(el).display!=="none"&&
      el.getBoundingClientRect().width>0;
    return {
      viewport:[innerWidth,innerHeight],
      documentWidth:document.documentElement.scrollWidth,
      items:selectors.map(selector=>{
        const el=document.querySelector(selector);
        if(!visible(el))return {selector,missing:true};
        const rect=el.getBoundingClientRect();
        return {selector,x:rect.x,y:rect.y,width:rect.width,height:rect.height,
          font:getComputedStyle(el).fontSize,
          scrollWidth:el.scrollWidth,clientWidth:el.clientWidth};
      }),
    };
  });
  report.diagnostics.compactGeometry=geometry;
  assert.ok(geometry.items.find(x=>x.selector===".source-pane"&&!x.missing));
  assert.ok(geometry.items.find(x=>x.selector===".source-document"&&!x.missing));
  record("compact WebView2 reception layout",geometry);
  await snap(page,"03-native-reception-compact-1024");

  assert.equal(report.issues.length,0,
    "Browser UI errors: "+report.issues.join("\n"));
  report.status="REAL_NATIVE_RECEPTION_SMOKE_PASSED";
  console.log("NATIVE_RECEPTION_PASS",JSON.stringify({
    binaryCommit:binCommit,checks:report.checks.length,
    screenshots:report.screens.length,status:report.status,
  }));
  }
}catch(e){
  report.status="FAILED";
  report.failure=e?.stack||String(e);
  console.error("NATIVE_RECEPTION_FAILED",report.failure);
  process.exitCode=1;
}finally{
  report.stderrTail=stderr.slice(-2000);
  report.stdoutTail=stdout.slice(-2000);
  await persist();
  await browser?.close().catch(()=>{});
  if(app.exitCode===null)app.kill();
}
