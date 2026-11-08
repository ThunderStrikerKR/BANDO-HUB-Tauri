import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import ExcelJS from "exceljs";
import { webcrypto } from "node:crypto";
import { createRequire } from "node:module";

const read = (name) => readFileSync(new URL("../" + name, import.meta.url), "utf8");
const nativeRequire = createRequire(import.meta.url);
const modules = new Map();
function load(path) {
  if (modules.has(path)) return modules.get(path);
  const output = {};
  modules.set(path, output);
  const js = ts.transpileModule(read("src/" + path + ".ts"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
  const run = vm.runInThisContext(
    "(function(exports, require, crypto, structuredClone) {\n" + js + "\n})",
    { filename: path + ".ts" },
  );
  run(output, (name) => name.startsWith("./")
    ? load(name.slice(2).replace(/\.js$/, ""))
    : nativeRequire(name), webcrypto, structuredClone);
  return output;
}
const { processWatchedFactoryReply } = load("factory-reply-auto");

function sample() {
  const recipient = {
    id:"recipient", name:"김수취", address:"경기 의정부시 새길 20",
    phone:"031-111-2222", mobile:"010-2222-3333",
    items:[{id:"item",origin:"FACTORY",quantity:1,name:"709B"}],
  };
  return {
    revision:3,products:[],clients:[],aliases:[],queue:[],exports:[],
    orders:[{id:"order",recipients:[recipient]}],
    factoryReplies:[],settings:{operatorName:"테스트 작업자",accounts:[]},
    workflow:{
      queue:[{id:"q1",origin:"FACTORY",status:"EXPORTED",shipmentId:"shipment",
        snapshot:{recipient}}],
      shipments:[{id:"shipment",orderId:"order",recipientId:"recipient",
        tracking:{},actualFreight:{},transferred:true}],
      events:[],groups:[],sources:[],payments:[],deliveries:[],
      changeRequests:[],confirmations:[],
    },
  };
}
const columns=[
  "수하인명","수하인우편번호","수하인주소","수하인전화번호","수하인핸드폰번호",
  "택배수량","택배운임","운임구분","품목명","","메시지","송하인명",
  "(송)우편","(송)주소1","(송)전화","(송)핸드폰","운송장번호",
];
async function inbox(rows, name="reply.xlsx") {
  const book=new ExcelJS.Workbook();
  const sheet=book.addWorksheet("로젠");
  sheet.addRow(columns);
  rows.forEach(row=>sheet.addRow(row));
  const bytes=Buffer.from(await book.xlsx.writeBuffer());
  const digest=Buffer.from(await webcrypto.subtle.digest("SHA-256",bytes)).toString("hex");
  return {filename:name,id:"factory-reply-"+digest,bytes:[...bytes]};
}
function row(tracking="001122334455", freight="4,000") {
  return ["김수취","","경기 의정부시 새길 20","031-111-2222",
    "010-2222-3333",1,freight,"010","709B","","","반도","","","",
    "",""+tracking];
}
function fakeApi(initial) {
  let value=structuredClone(initial);
  let commits=0;
  return {
    load: async()=>structuredClone(value),
    factoryReplyWatchCommit: async (filename,id,candidate,expectedRevision)=>{
      assert.equal(expectedRevision,value.revision);
      assert.equal(candidate.factoryReplies.at(-1).id,id);
      assert.equal(candidate.factoryReplies.at(-1).filename,filename);
      commits++;
      value=structuredClone(candidate);
      value.revision++;
      return {duplicate:false,applied:candidate.factoryReplies.at(-1).rows.filter(x=>x.applied).length,
        held:candidate.factoryReplies.at(-1).rows.filter(x=>!x.applied).length,archiveWarning:null};
    },
    get value(){return value},
    get commits(){return commits},
  };
}

test("automatic monitor reuses real XLSX matching and saves once",async()=>{
  const api=fakeApi(sample());
  const file=await inbox([row()]);
  const result=await processWatchedFactoryReply(api,file);
  assert.equal(result.applied,1);
  assert.equal(result.held,0);
  assert.equal(result.invalid,false);
  assert.equal(api.value.workflow.shipments[0].tracking.FACTORY,"001122334455");
  assert.equal(api.value.workflow.shipments[0].actualFreight.FACTORY,4000);
  const again=await processWatchedFactoryReply(api,file);
  assert.equal(again.duplicate,true);
  assert.equal(api.commits,1);
});
test("address mismatch is recorded as held without editing shipping data",async()=>{
  const api=fakeApi(sample());
  const mismatch=row();
  mismatch[2]="부산시 잘못된 주소 99";
  const result=await processWatchedFactoryReply(api,await inbox([mismatch]));
  assert.equal(result.applied,0);
  assert.equal(result.held,1);
  assert.equal(api.value.workflow.shipments[0].tracking.FACTORY,undefined);
  assert.equal(api.value.factoryReplies[0].status,"REVIEW");
});
test("invalid workbook is rejected without any SQLite write or audit record",async()=>{
  const api=fakeApi(sample());
  const book=new ExcelJS.Workbook();
  book.addWorksheet("잘못된양식").addRow(["제목이 다름"]);
  const bytes=Buffer.from(await book.xlsx.writeBuffer());
  const digest=Buffer.from(await webcrypto.subtle.digest("SHA-256",bytes)).toString("hex");
  const before=structuredClone(api.value);
  const result=await processWatchedFactoryReply(api,{
    filename:"invalid.xlsx",id:"factory-reply-"+digest,bytes:[...bytes],
  });
  assert.equal(result.invalid,true);
  assert.match(result.reason,/양식 불일치/);
  assert.deepEqual(api.value,before);
  assert.equal(api.commits,0);
});
test("automatic parser keeps conflicting values on hold for manual approval",async()=>{
  const s=sample();
  s.workflow.shipments[0].tracking.FACTORY="008877665544";
  s.workflow.shipments[0].actualFreight.FACTORY=5000;
  const api=fakeApi(s);
  const result=await processWatchedFactoryReply(api,await inbox([row()]));
  assert.equal(result.held,1);
  assert.equal(result.applied,0);
  assert.equal(api.value.workflow.shipments[0].tracking.FACTORY,"008877665544");
  assert.equal(api.value.workflow.shipments[0].actualFreight.FACTORY,5000);
});
test("startup mounting and native wiring keep TEST and production apart",()=>{
  const rust=read("src-tauri/src/factory_reply_watch.rs");
  const app=read("src/App.tsx");
  const settings=read("src/SettingsPanel.tsx");
  const bridge=read("src/tauri-bridge.ts");
  const library=read("src-tauri/src/lib.rs");
  assert.match(rust,/if is_test \{/);
  assert.match(rust,/공장 회신 수신/);
  assert.match(rust,/file_id\(&bytes\)/);
  assert.match(rust,/write_snapshot\(conn, candidate, expected_revision, true\)/);
  assert.match(app,/<FactoryReplyWatcher/);
  assert.match(settings,/수신 폴더 선택/);
  assert.match(bridge,/factoryReplyWatchScan:/);
  assert.match(bridge,/factoryReplyWatchCommit:/);
  assert.match(library,/factory_reply_watch::factory_reply_watch_scan/);
  assert.match(library,/factory_reply_watch::factory_reply_watch_commit/);
});
