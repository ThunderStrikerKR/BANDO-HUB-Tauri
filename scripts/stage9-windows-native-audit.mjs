import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as pause } from "node:timers/promises";
import { chromium } from "playwright";

// Stage 9 uses the compiled Windows Tauri EXE with native WebView2 and IPC.
// Never replace IPC with a mock or use a Vite browser to claim native success.
if (process.platform !== "win32") throw Error("Requires Windows runner");
const exe = resolve(process.env.BANDO_STAGE9_EXE || "");
assert.ok(exe.endsWith(".exe"), "BANDO_STAGE9_EXE must point to a native EXE");
await fs.access(exe);
const out = resolve(process.env.BANDO_STAGE9_OUT || "stage9-native-evidence");
await fs.mkdir(out, {recursive:true});
const testRoot = await fs.mkdtemp(join(tmpdir(),"bando-stage9-"));
const port = 19649;
const app = spawn(exe,[],{
  cwd:dirname(exe),windowsHide:false,stdio:["ignore","pipe","pipe"],
  env:{...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:"--remote-debugging-port="+port,
    WEBVIEW2_USER_DATA_FOLDER:join(testRoot,"webview2")},
});
let stdout="",stderr="",browser;
app.stdout?.on("data",b=>stdout+=b.toString());
app.stderr?.on("data",b=>stderr+=b.toString());
const report={stage:9,type:"actual-Windows-Tauri-WebView2",
  exe:basename(exe),commit:process.env.GITHUB_SHA||"",
  os:process.env.ImageOS||"Windows",testRoot,
  syntheticFreshRunner:true,usesMockIpc:false,started:new Date().toISOString(),
  results:[],errors:[],status:"STARTED"};
const write=async()=>{
  report.stdoutTail=stdout.slice(-1000);
  report.stderrTail=stderr.slice(-1000);
  await fs.writeFile(join(out,"native-audit.json"),JSON.stringify(report,null,2),"utf8");
};
const fileName=s=>String(s).replace(/[^\p{L}\p{N}-]+/gu,"-").slice(0,55);
try{
  let found=false;
  for(let i=0;i<140;i++){
    if(app.exitCode!==null)throw Error("EXE exited with code "+app.exitCode+": "+stderr.slice(-1000));
    try{
      const r=await fetch("http://127.0.0.1:"+port+"/json/list",{signal:AbortSignal.timeout(850)});
      if(r.ok && (await r.json()).some(x=>x.type==="page"&&/tauri|localhost/i.test(x.url||""))){found=true;break}
    }catch{/* initializing */}
    await pause(300);
  }
  if(!found)throw Error("WebView2 native CDP unavailable on Windows runner; GUI inspection not verified");
  browser=await chromium.connectOverCDP("http://127.0.0.1:"+port,{timeout:15000});
  const ctx=browser.contexts()[0];
  const page=ctx?.pages().find(x=>/tauri|localhost/i.test(x.url()))??ctx?.pages()[0];
  assert.ok(page,"No native WebView2 page");
  page.setDefaultTimeout(14000);
  page.on("pageerror",e=>report.errors.push("pageerror: "+e.message));
  page.on("console",m=>{if(m.type()==="error")report.errors.push("console: "+m.text().slice(0,800))});
  await page.locator("nav[aria-label='업무 메뉴']").waitFor({timeout:40000});
  const native=await page.evaluate(async()=>({
    href:location.href,userAgent:navigator.userAgent,
    hasBando:!!window.bando,isTestWorkspace:!!window.bando?.isTestWorkspace,
    size:{w:innerWidth,h:innerHeight},
  }));
  assert.ok(native.hasBando,"Tauri IPC bridge missing");
  assert.ok(!/^https?:\/\/127\.0\.0\.1:517\d/.test(native.href),"Vite is not native");
  report.native=native;
  console.log("STAGE9_NATIVE_CONNECTED",JSON.stringify(native));

  let i=0;
  const capture=async(kind,name)=>{
    await page.waitForTimeout(200);
    const metrics=await page.evaluate(()=>{
      const visible=el=>{
        const r=el.getBoundingClientRect(),s=getComputedStyle(el);
        return r.width>0&&r.height>0&&s.display!=="none"&&s.visibility!=="hidden";
      };
      const box=el=>{const r=el.getBoundingClientRect();return {
        x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)}};
      const controls=[...document.querySelectorAll("button,input,select,textarea")].filter(visible);
      return {viewport:{w:innerWidth,h:innerHeight},bodyW:document.body.scrollWidth,
        documentW:document.documentElement.scrollWidth,
        titles:[...document.querySelectorAll("h1,h2,h3")].filter(visible)
          .map(el=>({text:el.textContent?.trim().slice(0,90),
            font:parseFloat(getComputedStyle(el).fontSize),rect:box(el)})),
        controls:controls.map(el=>({type:el.tagName.toLowerCase(),
          name:el.getAttribute("aria-label")||el.textContent?.trim().slice(0,65)||"",
          font:parseFloat(getComputedStyle(el).fontSize),rect:box(el)})),
        scrollRegions:[...document.querySelectorAll("*")].filter(el=>{
          const s=getComputedStyle(el);
          return visible(el)&&/(auto|scroll)/.test(s.overflowX+s.overflowY)&&
          (el.scrollWidth>el.clientWidth+5||el.scrollHeight>el.clientHeight+5);
        }).slice(0,40).map(el=>({
          class:String(el.className).slice(0,90),
          scrollW:el.scrollWidth,clientW:el.clientWidth,
          scrollH:el.scrollHeight,clientH:el.clientHeight,rect:box(el)})),
        dialogs:[...document.querySelectorAll("dialog[open],[role='dialog']")]
          .filter(visible).map(el=>({name:el.getAttribute("aria-label")||el.textContent?.trim().slice(0,100),rect:box(el)})),
      };
    });
    const file=String(++i).padStart(2,"0")+"-"+fileName(kind)+"-"+fileName(name)+".png";
    await page.screenshot({path:join(out,file),animations:"disabled",timeout:18000});
    report.results.push({kind,name,file,...metrics});
    console.log("STAGE9_CAPTURE",JSON.stringify({kind,name,file,
      viewport:metrics.viewport,titles:metrics.titles.map(x=>x.text),
      controls:metrics.controls.length,dialogs:metrics.dialogs.length}));
    await write();
  };
  const nav=page.locator("nav[aria-label='업무 메뉴']");
  const menus=["접수","주문 내역","엑셀 관리","일일 결산","상품 관리",
    "운임 관리","거래처 관리","설정"];
  for(const menu of menus){
    await nav.getByRole("button",{name:menu,exact:true}).click();
    await page.waitForTimeout(270);
    assert.equal((await nav.locator("button[aria-current='page']").textContent())?.trim(),
      menu,"Native navigation did not open "+menu);
    await capture("menu",menu);
    const subnav=await page.evaluate(()=>{
      const visible=el=>{
        const r=el.getBoundingClientRect(),s=getComputedStyle(el);
        return r.width>0&&r.height>0&&s.display!=="none"&&s.visibility!=="hidden";
      };
      return [...document.querySelectorAll("nav[aria-label]")]
        .filter(el=>el.getAttribute("aria-label")!=="업무 메뉴"&&visible(el))
        .map(el=>({name:el.getAttribute("aria-label"),
          buttons:[...el.querySelectorAll("button")].filter(visible)
            .map(b=>b.textContent?.trim()).filter(Boolean)}));
    });
    for(const sub of subnav){
      for(const label of sub.buttons.slice(0,15)){
        const b=page.locator("nav[aria-label="+JSON.stringify(sub.name)+"]")
          .getByRole("button",{name:label,exact:true});
        if((await b.count())!==1)continue;
        await b.click();
        await capture("subtab",menu+"-"+sub.name+"-"+label);
      }
    }
  }
  assert.equal(report.results.filter(x=>x.kind==="menu").length,8);
  report.status="NATIVE_CAPTURES_COLLECTED";
  await write();
  console.log("STAGE9_NATIVE_SUMMARY",JSON.stringify({
    pages:report.results.length,menus:8,nativeUrl:native.href,errors:report.errors.length}));
}catch(error){
  report.status="FAILED";
  report.failure=error?.stack||String(error);
  await write();
  console.error("STAGE9_NATIVE_FAILURE",report.failure);
  process.exitCode=1;
}finally{
  await browser?.close().catch(()=>{});
  if(app.exitCode===null)app.kill();
}
