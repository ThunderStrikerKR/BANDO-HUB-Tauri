/** Production Rust factory-review projection vs original TS UI business rules.
 * Compare exactly the review status, resolved row and confirmation text.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tsImport } from "tsx/esm/api";

const { replyNeedsReview } =
  await tsImport("../../../src/factory-replies.ts", import.meta.url);
const { factoryConflictConfirmation } =
  await tsImport("../../../src/factory-conflict-review.ts", import.meta.url);
const manifest = fileURLToPath(new URL("./Cargo.toml", import.meta.url));
const root = fileURLToPath(new URL("../../../", import.meta.url));
const clone = structuredClone;
const state = () => ({
  orders: [{id:"o1", recipients:[{
    id:"r1", name:"김민수", actualFreight:2500, items:[],
  }]}],
  workflow: { shipments:[{
    id:"s1", orderId:"o1", recipientId:"r1",
    tracking:{FACTORY:"000012345678"},
    actualFreight:{FACTORY:3000},
  }] },
  factoryReplies: [{
    id:"f1", filename:"회신.xlsx", status:"REVIEW", businessDate:"2026-11-14",
    rows:[{row:2, name:"김민수", shipmentId:"s1", orderId:"o1",
      issue:"실제 운임 충돌", applied:false, tracking:"9988776655", actual:4000}],
  }],
});
const cases = [];
function add(label, mutate = () => {}) {
  const current = state();
  mutate(current);
  const baseline = current.factoryReplies.map((record) => {
    const needsReview = replyNeedsReview(current, record);
    const notificationLabel = !needsReview ? "반영 완료"
      : record.status === "PARTIAL" ? "일부 반영" : "직원 확인 필요";
    return {
      id: record.id, needsReview, notificationLabel,
      rows: record.rows.map((row) => {
        const resolved = current.factoryReplies.some((later) =>
          later.resolves?.id === record.id &&
          later.resolves.row === row.row &&
          later.rows.some((entry) => entry.applied));
        const hasLaterResolution = current.factoryReplies.some((later) =>
          later.resolves?.id === record.id && later.resolves.row === row.row);
        const candidate = !row.applied && !!row.shipmentId &&
          !!row.issue?.includes("충돌") && !hasLaterResolution;
        let confirmation = null, confirmationError = null;
        if (candidate) {
          try {
            confirmation = factoryConflictConfirmation(current, record.id, row.row);
          } catch (error) {
            confirmationError = error.message;
          }
        }
        return {
          row: row.row, resolved, hasLaterResolution,
          confirmation, confirmationError,
        };
      }),
    };
  });
  cases.push({
    label, operation:"project_factory_reply_review",
    payload:{state:current},
    expected:{ok:true,value:{records:baseline}},
  });
}
add("one pending factory row and conflict confirmation");
add("completed source row",s=>{
  s.factoryReplies[0].rows[0].applied=true;
  s.factoryReplies[0].rows[0].issue="";
  s.factoryReplies[0].status="APPLIED";
});
add("record error requires review even if all rows applied",s=>{
  s.factoryReplies[0].rows[0].applied=true;
  s.factoryReplies[0].error="공장 파일 연결 실패";
});
add("partial factory reply state label",s=>{
  s.factoryReplies[0].status="PARTIAL";
});
add("old row resolved by later approved record",s=>{
  s.factoryReplies.push({
    id:"f2",status:"APPLIED",resolves:{id:"f1",row:2},
    rows:[{row:3,applied:true,issue:"",tracking:"0000",actual:3500}],
  });
});
add("unapplied later reference suppresses conflict action but not review",s=>{
  s.factoryReplies.push({
    id:"f2",status:"REVIEW",resolves:{id:"f1",row:2},
    rows:[{row:3,applied:false,issue:"",tracking:"0000",actual:3500}],
  });
});
add("no registered actual freight falls back to recipient",s=>{
  delete s.workflow.shipments[0].actualFreight;
});
add("explicit null actual freight stays unconfirmed",s=>{
  s.workflow.shipments[0].actualFreight.FACTORY=null;
});
add("missing original shipment prevents approval text",s=>{
  s.workflow.shipments=[];
});
add("missing original recipient prevents approval text",s=>{
  s.orders[0].recipients=[];
});
add("bad conflict issue never offers an approval button",s=>{
  s.factoryReplies[0].rows[0].issue="누락된 운송장";
});
add("empty factory reply collection",s=>{
  s.factoryReplies=[];
});
test("native factory review badges, row resolution and approval text match TS",()=>{
  const proc=spawnSync("cargo",[
    "run","--quiet","--manifest-path",manifest,"--bin","parity_runner",
  ],{cwd:root,input:JSON.stringify(cases),encoding:"utf8",
    maxBuffer:8*1024*1024,timeout:240000});
  assert.equal(proc.status,0,proc.stderr);
  const actual=JSON.parse(proc.stdout);
  assert.equal(actual.length,cases.length);
  actual.forEach((entry,i)=>{
    assert.deepStrictEqual(entry,cases[i].expected,cases[i].label);
  });
});
