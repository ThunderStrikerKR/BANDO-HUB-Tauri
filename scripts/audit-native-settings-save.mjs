/** Actual Tauri UIA settings click -> revision-checked SQLite TEST DB -> EXE relaunch.
 * No JS mock, no production writes, and no assumption that native CDP is available.
 */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as pause } from "node:timers/promises";

if(process.platform!=="win32"||process.env.GITHUB_ACTIONS!=="true")
  throw Error("Only a disposable Windows GitHub Actions VM is allowed");
const exe=resolve(process.env.BANDO_NATIVE_EXE||"");
const out=resolve(process.env.BANDO_NATIVE_OUT||"audit-real-native-reception");
assert.match(exe,/\.exe$/i);
await fs.access(exe);
await fs.mkdir(out,{recursive:true});
const dir=join(process.env.APPDATA||"",
  "com.bandostand.bandohub.tauri");
const source=join(dir,"bando-hub-v001.sqlite");
const testDb=join(dir,"developer-test","bando-hub-test.sqlite");
await fs.access(source);
await fs.access(testDb);
const hash=async path=>createHash("sha256").update(await fs.readFile(path)).digest("hex");
const sourceBefore=await hash(source);
const inspect=()=>{
  const code='import json,sqlite3,sys; d=sqlite3.connect("file:"+sys.argv[1].replace(chr(92),"/")+"?mode=ro",uri=True); p=json.loads(d.execute("SELECT payload FROM app_state WHERE id=1").fetchone()[0]); print(json.dumps({"revision":p.get("revision"),"operatorName":p["settings"].get("operatorName")})); d.close()';
  const raw=execFileSync("python",["-c",code,testDb],{encoding:"utf8",timeout:12000});
  return JSON.parse(raw);
};
const initial=inspect();
const expected="BANDO_UIA_TEST_3ECA_20261114";
assert.notEqual(initial.operatorName,expected);
const report={
  type:"actual-windows-UIA-settings-save-restart-SQLite",
  appBinary:"3eca217fe2a045e25c6caf0cbedb0bdd234a9afb",
  syntheticTestDB:true,usedMockIPC:false,sourceDBNeverWritten:true,
  initial,status:"STARTED",checks:[],testDb,testRoot:dirname(testDb)
};
const persist=async()=>fs.writeFile(join(out,"settings-transaction-audit.json"),
  JSON.stringify(report,null,2),"utf8");
const probe=async(verifyOnly)=>{
  const root=await fs.mkdtemp(join(tmpdir(),"bando-native-settings-"));
  const child=spawn(exe,["--bando-developer-test"],{
    cwd:dirname(exe),windowsHide:false,stdio:["ignore","pipe","pipe"],
    env:{...process.env,WEBVIEW2_USER_DATA_FOLDER:join(root,"webview2")}
  });
  let stdout="",stderr="";
  child.stdout?.on("data",b=>stdout+=b.toString());
  child.stderr?.on("data",b=>stderr+=b.toString());
  try{
    await pause(1100);
    if(child.exitCode!==null)throw Error("Native TEST EXE exited "+child.exitCode+" "+stderr.slice(-2500));
    const args=["-NoProfile","-Sta","-ExecutionPolicy","Bypass",
      "-File",resolve("scripts/audit-native-settings-uia.ps1"),
      "-ProcessId",String(child.pid),"-OutDir",out,"-Expected",expected];
    if(verifyOnly)args.push("-VerifyOnly");
    const result=execFileSync("pwsh.exe",args,{
      encoding:"utf8",timeout:140000,maxBuffer:8*1024*1024
    });
    const data=JSON.parse(await fs.readFile(join(out,
      verifyOnly?"settings-reopen.json":"settings-save.json"),"utf8"));
    assert.equal(data.status,verifyOnly?
      "NATIVE_SETTINGS_REOPEN_VERIFIED":"NATIVE_SETTINGS_GUI_SAVE_CLICKED");
    report.checks.push({type:verifyOnly?"reopened native settings UI":"native GUI save click",
      status:data.status,observations:data.observations});
    console.log("NATIVE_SETTINGS_RESULT",result.slice(-450),data.status);
  }finally{
    report.checks.push({type:verifyOnly?"reopen process":"save process",
      pid:child.pid,exitCode:child.exitCode,stderrTail:stderr.slice(-900)});
    if(child.exitCode===null)child.kill();
    await new Promise(resolve=>{
      if(child.exitCode!==null)return resolve();
      child.once("exit",resolve);
      setTimeout(resolve,3500);
    });
    await pause(1000);
  }
};
try{
  await probe(false);
  let after;
  for(let i=0;i<24;i++){
    after=inspect();
    if(after.operatorName===expected&&after.revision>initial.revision)break;
    await pause(400);
  }
  assert.equal(after.operatorName,expected,"UI save never reached the real SQLite TEST DB");
  assert.ok(after.revision>initial.revision,"Revision not advanced by UI save");
  report.afterSave=after;
  report.checks.push({type:"actual SQLite persisted after app exit",passed:true,revision:after.revision});
  await probe(true);
  const reopened=inspect();
  assert.deepEqual(reopened,after,"Reopening Tauri must not rewrite persisted settings");
  report.afterReopen=reopened;
  assert.equal(await hash(source),sourceBefore,"Production baseline SQLite was modified!");
  report.status="NATIVE_SETTINGS_UI_SQLITE_REOPEN_PASSED";
  console.log("NATIVE_SETTINGS_PERSISTENCE_PASSED",JSON.stringify({
    before:initial,after,reopened,sourceUnchanged:true
  }));
}catch(e){
  report.status="FAILED";
  report.failure=e?.stack||String(e);
  console.error("NATIVE_SETTINGS_PERSISTENCE_FAILED",report.failure);
  process.exitCode=1;
}finally{
  await persist();
}
