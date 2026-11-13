// Actual Windows Tauri EXE + real WebView2 + real Rust IPC, no mocked commands.
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
const out=resolve(process.env.BANDO_NATIVE_OUT || "windows-final-gui-evidence");
await fs.mkdir(out,{recursive:true});
const root=await fs.mkdtemp(join(tmpdir(),"bando-native-reception-"));
const port=19679;
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
  if(bootstrap.exitCode===null)bootstrap.kill();
  await sleep(750);
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
const persist=()=>fs.writeFile(join(out,"windows-final-gui-audit.json"),
  JSON.stringify(report,null,2),"utf8");
await persist();
let stderr="",stdout="",browser;
const app=spawn(exe,["--bando-developer-test"],{
  cwd:dirname(exe),windowsHide:false,stdio:["ignore","pipe","pipe"],
  env:{
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:
      "--remote-debugging-port="+port+" --remote-debugging-address=127.0.0.1",
    WEBVIEW2_USER_DATA_FOLDER:join(root,"webview2"),
  },
});
app.stderr?.on("data",b=>stderr+=b.toString());
app.stdout?.on("data",b=>stdout+=b.toString());
report.pid=app.pid;
const record=(name,payload={})=>{report.checks.push({name,...payload});console.log("FINAL_NATIVE_GUI_CHECK",name,JSON.stringify(payload));};
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
        target=targets.find(x=>x.type==="page"&&/tauri|localhost/i.test(x.url||""));
        if(target)break;
      }
    }catch{/* startup */}
    await sleep(350);
  }
  if(!target){
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
    assert.equal(uia.status,"FINAL_NATIVE_GUI_UIA_PASSED",
      "WebView2 CDP unavailable and actual Windows UIAutomation failed");
    report.status="FINAL_NATIVE_GUI_UIA_PASSED_CDP_UNAVAILABLE";
    report.limitations=[
      "Real Tauri screen and UIAutomation passed; no fake browser or IPC",
      "CDP unavailable: direct per-operation native IPC trace unverified",
      "Only GitHub Windows runner 1024x768 geometry verified"
    ];
    console.log("FINAL_NATIVE_GUI_UIA_PASS",JSON.stringify(report.diagnostics.uia));
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

  // Actual app-navigation and persistence acceptance on an isolated developer
  // TEST database. Playwright is a CDP client for WebView2, NOT a fake browser.
  const nav = page.locator("nav[aria-label='업무 메뉴']");
  const allMenus=["접수","주문 내역","엑셀 관리","일일 결산",
    "상품 관리","운임 관리","거래처 관리","설정"];
  let settingsRevision=0,clientId="",clientName="CI-가상거래처-윈도우화면검수";
  for (const menu of allMenus) {
    await nav.getByRole("button",{name:menu,exact:true}).click();
    await page.waitForTimeout(280);
    const active=(await nav.locator("button[aria-current='page']").textContent())?.trim();
    assert.equal(active,menu,"real Windows native top navigation did not move to "+menu);
    await snap(page,"menu-"+String(allMenus.indexOf(menu)+1).padStart(2,"0")+"-"+menu.replaceAll(" ","-"));
    const metrics=await page.evaluate(()=>({
      viewport:[innerWidth,innerHeight],docWidth:document.documentElement.scrollWidth,
      title:[...document.querySelectorAll("h1,h2")].filter(e=>e.getBoundingClientRect().width)
        .slice(0,5).map(e=>e.textContent?.trim().slice(0,80)),
      current:[...document.querySelectorAll("nav[aria-label='업무 메뉴'] button[aria-current='page']")]
        .map(e=>e.textContent?.trim()),
      uiError:!!document.querySelector("[data-screen-error]"),
    }));
    assert.ok(!metrics.uiError,"error boundary on "+menu);
    record("real Windows main screen "+menu,{...metrics});
    if(menu==="상품 관리") {
      const sub=page.locator("nav[aria-label='상품 관리 메뉴']");
      for(const label of ["상품 목록","카테고리 관리","모델군 관리","별칭 관리","브랜드 관리"]){
        await sub.getByRole("button",{name:label,exact:true}).click();
        await page.waitForTimeout(220);
        await snap(page,"products-"+label);
        record("native product subtab "+label);
      }
      await sub.getByRole("button",{name:"상품 목록",exact:true}).click();
      await page.getByRole("button",{name:"상세 관리",exact:true}).first().click();
      await page.locator(".product-detail-modal, [role='dialog']").first().waitFor({timeout:15000});
      await snap(page,"product-detail-native");
      await page.getByRole("button",{name:"닫기",exact:true}).last().click();
      record("product detail opened and closed without changing SQLite");
    }
    if(menu==="운임 관리") {
      const sub=page.locator("[aria-label='배송 관리']");
      for(const label of ["상품별 기본 운임","동급 배송 그룹 지정","동급 그룹 운임표","조합 / 기준 이력"]){
        await sub.getByRole("button",{name:label,exact:true}).click();
        await page.waitForTimeout(200);
        await snap(page,"freight-"+label.replaceAll(" ","-").replaceAll("/",""));
        record("native freight subtab "+label);
      }
    }
    if(menu==="거래처 관리") {
      const sub=page.locator("nav[aria-label='거래처 관리 메뉴']");
      await sub.getByRole("button",{name:"자동 메시지 편집",exact:true}).click();
      await snap(page,"clients-messages");
      const editNav=page.locator("nav[aria-label='자동 메시지 편집 종류']");
      for(const label of ["상황별 공통 안내","잠정 상품 선택 안내"]){
        await editNav.getByRole("button",{name:label,exact:true}).click();
        await snap(page,"clients-messages-"+label);
      }
      await sub.getByRole("button",{name:"거래처 목록",exact:true}).click();
      await page.getByRole("button",{name:/거래처 등록/}).first().click();
      const modal=page.locator(".client-editor-modal");
      await modal.waitFor({timeout:15000});
      await snap(page,"client-registration-empty");
      const sections=modal.locator(".client-editor-section");
      await sections.nth(0).locator("input").nth(0).fill(clientName);
      await sections.nth(1).locator("input").nth(0).fill("서울특별시 가상구 테스트로 123");
      await sections.nth(1).locator("input").nth(1).fill("02-1234-5678");
      await modal.getByRole("button",{name:"거래처 등록",exact:true}).click();
      await page.waitForFunction((name)=>!document.querySelector(".client-editor-modal")
        && document.body.textContent.includes(name),clientName,{timeout:20000});
      const clients=await page.evaluate(async()=>window.bando.load());
      const client=clients.clients.find(x=>x.name==="CI-가상거래처-윈도우화면검수");
      assert.ok(client?.id,"native client editor did not commit to SQLite");
      assert.equal(client.address,"서울특별시 가상구 테스트로 123");
      clientId=client.id;
      record("UI client registration committed into real SQLite",{clientId,revision:clients.revision});
      await snap(page,"client-registration-persisted");
    }
    if(menu==="설정") {
      const before=await page.evaluate(async()=>window.bando.load());
      await page.getByRole("button",{name:"설정 저장",exact:true}).click();
      const noChange=await page.evaluate(async()=>window.bando.load());
      assert.equal(noChange.revision,before.revision,"no-op save must not increment revision");
      record("settings unchanged click does not write",{revision:noChange.revision});
      const operator=page.locator('input[placeholder="진행 / 입금 / 발송 이력에 기록할 이름"]');
      await operator.fill("CI-Windows-격리검수");
      await page.getByRole("button",{name:"설정 저장",exact:true}).click();
      await page.waitForFunction(async()=>(
        await window.bando.load()).settings.operatorName==="CI-Windows-격리검수",
        null,{timeout:20000});
      const saved=await page.evaluate(async()=>window.bando.load());
      assert.ok(saved.revision>noChange.revision,"settings edit did not increment revision");
      settingsRevision=saved.revision;
      record("UI settings saved in native SQLite",{before:before.revision,after:settingsRevision});
      const tabs=page.getByRole("tab");
      for(const label of ["기본 설정","파일 관리","데이터 관리","시스템","개발자 모드"]){
        await page.getByRole("tab",{name:label,exact:true}).click();
        assert.equal(await page.getByRole("tab",{name:label,exact:true}).getAttribute("aria-selected"),"true");
        await snap(page,"settings-"+label.replaceAll(" ","-"));
        record("native settings tab "+label);
      }
      await page.getByRole("tab",{name:"기본 설정",exact:true}).click();
      assert.equal(await operator.inputValue(),"CI-Windows-격리검수");
      record("settings survives native page switch");
    }
  }
  assert.equal(report.screens.filter(x=>x.name.startsWith("menu-")).length,8);
  assert.ok(settingsRevision>0&&clientId,"UI persistence prerequisites did not complete");
  await nav.getByRole("button",{name:"접수",exact:true}).click();
  await page.waitForTimeout(350);
  const currentSaved=await page.evaluate(async()=>window.bando.load());
  const stale=native.before;
  assert.ok(currentSaved.revision>stale.revision);
  let rejected="";
  try {await page.evaluate(async state=>window.bando.save(state),stale);}
  catch(e){rejected=String(e);}
  assert.ok(rejected,"stale SQLite snapshot save was not rejected");
  const preserved=await page.evaluate(async()=>window.bando.load());
  assert.equal(preserved.revision,currentSaved.revision);
  assert.equal(preserved.settings.operatorName,"CI-Windows-격리검수");
  assert.ok(preserved.clients.some(c=>c.id===clientId));
  record("stale snapshot refused; order/product/client/settings preserved",{
    revision:preserved.revision,clientId,reason:rejected.slice(0,250)
  });
  // UI refresh causes Tauri native state_load, not a browser mock.
  await page.reload({waitUntil:"domcontentloaded"});
  await page.locator("nav[aria-label='업무 메뉴']").waitFor({timeout:30000});
  const afterReload=await page.evaluate(async()=>window.bando.load());
  assert.equal(afterReload.settings.operatorName,"CI-Windows-격리검수");
  assert.ok(afterReload.clients.some(c=>c.id===clientId));
  record("settings/client persisted after live WebView2 reload",{
    revision:afterReload.revision,clientId
  });
  await snap(page,"native-webview2-reloaded-persisted");


  // Instrument the genuine Tauri IPC function, but forward every call to the
  // same original native dispatcher. This is NOT a mock or substitute.
  await page.evaluate(()=>{
    window.__bandoNativeCalls=[];
    const api=window.__TAURI_INTERNALS__;
    const original=api.invoke;
    api.invoke=function(command,args,...rest){
      window.__bandoNativeCalls.push({
        command,domain:args?.domain,operation:args?.operation
      });
      return Reflect.apply(original,this,[command,args,...rest]);
    };
  });

  const raw=[
    "김가상","010-1234-5678","경기도 의정부시 시민로 100",
    "709 2개","박가상","010-2345-6789",
    "서울특별시 마포구 월드컵로 20","GT-1 1개"
  ].join("\n");
  await page.evaluate(async text=>window.bando.copy(text),raw);
  await page.getByRole("button",{name:"대리발송",exact:true}).click();
  await page.waitForFunction(()=>{
    const calls=window.__bandoNativeCalls||[];
    return calls.some(x=>x.command==="business_core_call"&&
      x.domain==="recognition"&&x.operation==="analyze_order");
  },null,{timeout:50000});
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
  report.status="REAL_FINAL_NATIVE_GUI_SMOKE_PASSED";
  console.log("FINAL_NATIVE_GUI_PASS",JSON.stringify({
    binaryCommit:binCommit,checks:report.checks.length,
    screenshots:report.screens.length,status:report.status,
  }));
  }
}catch(e){
  report.status="FAILED";
  report.failure=e?.stack||String(e);
  console.error("FINAL_NATIVE_GUI_FAILED",report.failure);
  process.exitCode=1;
}finally{
  report.stderrTail=stderr.slice(-2000);
  report.stdoutTail=stdout.slice(-2000);
  await persist();
  await browser?.close().catch(()=>{});
  if(app.exitCode===null)app.kill();
}
