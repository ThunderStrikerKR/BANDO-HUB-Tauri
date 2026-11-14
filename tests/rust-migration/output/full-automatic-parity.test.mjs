/** End-to-end TS oracle: full automatic-message text, link, phase, invoice issues,
 * and historical payment-copy signature against the compiled Rust state renderer.
 * This is intentionally a production Rust call, not a source-pattern test.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tsImport } from "tsx/esm/api";

const { automaticMessage, paymentSignature, paymentWasCopied, withGreeting } =
  await tsImport("../../../src/automatic-message.ts",import.meta.url);
const { groupOrder, groupMessages } =
  await tsImport("../../../src/workflow.ts",import.meta.url);
const { validProductUrl } =
  await tsImport("../../../src/domain.ts",import.meta.url);
const root=fileURLToPath(new URL("../../../",import.meta.url));
const manifest=fileURLToPath(new URL("./Cargo.toml",import.meta.url));
const gid="group:o1";
const link="https://www.bandostand.com/product/709";

function base(){
  const now="2026-11-13T09:00:00+09:00";
  const item={id:"i1",productId:"p1",variantId:"v1",name:"BD 709",
    raw:"보면대 2개",color:"Black",quantity:2,quantityConfirmed:true,
    unitPrice:50000,origin:"FACTORY",url:link,issues:[]};
  const r={id:"r1",name:"김민수",address:"서울 종로구 청계천로 1",
    addressStatus:"COMPLETE",phone:"01012345678",mobile:"",
    items:[item],note:"",vatDefault:true};
  const o={id:"o1",clientId:"c1",orderType:"AGENCY",recipients:[r],
    raw:"가상 발주서",createdAt:now,updatedAt:now,freightCode:"010",
    shippingFee:3000,applyVat:true,vatAmount:null,pricesLocked:false,
    status:"REVIEW"};
  const c={id:"c1",name:"가상 거래처",displayName:"가상 상호",
    address:"서울 종로구 종로 1",phone:"02-1234-5678",mobile:"",
    tier:"wholesale",payment:"PREPAID",overrides:{},
    preferredAccountId:"a1",shippingFeeExcluded:false};
  return {
    orders:[o],clients:[c],products:[{id:"p1",code:"709",
      name:"BD 709 / 보면대",category:"보면대",origin:"FACTORY",
      colorStatus:"KNOWN",defaultColor:"Black",active:true,catalog:"BANDOSTAND",
      variants:[{id:"v1",color:"Black",wholesale:50000,semi:55000,
        retail:60000,url:link}]}],
    exports:[],queue:[],aliases:[],
    shipping:{epoch:1,groups:[],productRules:{},combinations:[]},
    settings:{operatorName:"직원",accounts:[{
      id:"a1",bank:"국민은행",number:"123-456",holder:"반도",
      memo:"현재 사용 계좌"
    }],defaultAccountId:"a1",
      senderName:"반도스탠드",senderAddress:"서울 종로구 종로 10",
      senderPhone:"02-742-9929",senderMobile:"",provisionalProductNotices:{}},
    workflow:{sources:[{id:"source:o1",orderId:"o1",dealerId:"c1",
      number:1,raw:"가상 발주서",createdAt:now}],
      groups:[{id:gid,sourceId:"source:o1",dealerId:"c1",
        rootGroupId:gid,createdAt:now,notices:[],needsNotice:false}],
      shipments:[{id:"ship1",sourceId:"source:o1",orderId:"o1",
        recipientId:"r1",groupId:gid,step:2,completedAt:{"1":now,"2":now},
        charges:{FACTORY:3000},chargeMode:"MANUAL",infoSignature:"stable",
        transferred:false}],payments:[],queue:[],events:[],deliveries:[],
      changeRequests:[],confirmations:[]},
  };
}
const scenarios=[];
function add(name,change=()=>{},includeLinks=false){
  const state=base();change(state);
  const original=automaticMessage(state,gid,includeLinks);
  const signature=paymentSignature(state,gid);
  const view=groupOrder(state,gid);
  const links=[...new Set(view.recipients.flatMap(r=>r.items)
    .filter(i=>i.url&&validProductUrl(i.url))
    .map(i=>i.name+"\n"+i.url))];
  scenarios.push({
    name,operation:"render_automatic_message",
    payload:{state,groupId:gid,includeLinks,
      accountWire:state.settings.accounts.map(a=>({
        id:a.id,json:JSON.stringify(a)
      }))},
    baseline:{phase:original.phase,text:original.text,
      paymentIssues:original.paymentIssues,signature,
      validRequestLinks:links},
  });
}
add("valid payment preview at stage 2");
add("valid payment preview with product link",()=>{},true);
add("stage 1 inquiry",s=>{s.workflow.shipments[0].step=1;});
add("missing name blocks request",s=>{s.orders[0].recipients[0].name="";});
add("missing contact blocks request",s=>{s.orders[0].recipients[0].phone="";});
add("missing product model blocks request",s=>{
  const i=s.orders[0].recipients[0].items[0];i.productId=null;i.variantId=null;
});
add("quantity unconfirmed",s=>{
  const i=s.orders[0].recipients[0].items[0];
  i.quantityConfirmed=false;i.quantityApproval={quantity:1,actor:"직원",at:"2026-11-13"};
  i.quantity=1;
});
add("custom customer and payment templates",s=>{
  s.orders[0].recipients[0].phone="";
  s.settings.automaticMessageTemplates={
    contactMissing:"{수취인}님 연락처 확인 요청",
    paymentGreeting:"금액 안내드립니다.",
    paymentItem:"{상품명} / {수량}개 / {금액}",
    paymentAccount:"{은행명} / {계좌번호} / {예금주}",
  };
});
add("representative model notice",s=>{
  s.orders[0].recipients[0].items[0].appliedRepresentativeModel={
    groupId:"models",productId:"p1",productName:"BD 709"
  };
});
add("color default notification",s=>{
  s.orders[0].recipients[0].items[0].appliedDefaultColor={
    groupId:"colors",color:"Black"
  };
});
add("conditional employee product notice",s=>{
  const i=s.orders[0].recipients[0].items[0];
  i.selectionEvidence={expression:"보면대",productId:"p1",variantId:"v1"};
  s.settings.provisionalProductNotices={p1:"상판 구멍 여부를 확인하세요."};
});
add("provisional notice suppressed by explicit model",s=>{
  const i=s.orders[0].recipients[0].items[0];
  i.selectionEvidence={expression:"BD 709",productId:"p1",variantId:"v1"};
  s.settings.provisionalProductNotices={p1:"표시되면 안 되는 안내"};
});
add("collect freight",s=>{s.orders[0].freightCode="020";});
add("VAT separately",s=>{s.orders[0].applyVat=false;
  s.orders[0].recipients[0].vatDefault=false;});
add("manual bank account",s=>{s.orders[0].accountMode="MANUAL";
  s.orders[0].accountId="a2";s.settings.accounts.push({
    id:"a2",bank:"농협",number:"555-123",holder:"새 계좌"
  });});
add("missing account",s=>{s.settings.accounts=[];});
add("mixed VAT across two recipients",s=>{
  const next=structuredClone(s.orders[0].recipients[0]);
  next.id="r2";next.name="박민수";next.items[0].id="i2";
  next.vatOverride=false;s.orders[0].recipients.push(next);
  s.workflow.shipments.push({...structuredClone(s.workflow.shipments[0]),
    id:"ship2",recipientId:"r2",charges:{FACTORY:4000}});
},true);
add("customer confirmed proposed product",s=>{
  const i=s.orders[0].recipients[0].items[0];
  i.modelProposal={original:"보면대",required:true};
});
const requests=scenarios.map(({operation,payload})=>({operation,payload}));

test("full TS automatic message and copy signature match compiled Rust",()=>{
  const result=spawnSync("cargo",["run","--quiet","--manifest-path",manifest,
    "--bin","parity_runner"],{cwd:root,input:JSON.stringify(requests),
      encoding:"utf8",timeout:180000,maxBuffer:64*1024*1024});
  if(result.error)throw result.error;
  assert.equal(result.status,0,result.stderr);
  const actual=JSON.parse(result.stdout), mismatches=[];
  assert.equal(actual.length,scenarios.length);
  scenarios.forEach((scenario,i)=>{
    try{assert.deepStrictEqual(actual[i],{ok:true,value:scenario.baseline});}
    catch{mismatches.push({name:scenario.name,ts:scenario.baseline,rust:actual[i]});}
  });
  if(mismatches.length)console.error(JSON.stringify(mismatches,null,2));
  assert.equal(mismatches.length,0,
    mismatches.length+" of "+scenarios.length+" full automatic cases differ");
});
test("Rust immutable workflow payment notices match the full original TS message",()=>{
  // The editable automatic-message preview omits the greeting, but a workflow
  // step-three notice must freeze the complete original payment text.
  const noticeCases=scenarios.map(({name,payload})=>{
    const {state,groupId}=payload;
    let expected;
    try{expected={ok:true,value:{payment:groupMessages(state,groupId).payment}};}
    catch(error){expected={ok:false,error:error instanceof Error?error.message:String(error)};}
    return {name,operation:"render_payment_notice",payload:{state,groupId},expected};
  });
  const run=spawnSync("cargo",["run","--quiet","--manifest-path",manifest,
    "--bin","parity_runner"],{cwd:root,input:JSON.stringify(noticeCases.map(
      ({operation,payload})=>({operation,payload})
    )),encoding:"utf8",timeout:180000,maxBuffer:64*1024*1024});
  if(run.error)throw run.error;
  assert.equal(run.status,0,run.stderr);
  const actual=JSON.parse(run.stdout);
  assert.equal(actual.length,noticeCases.length);
  const differences=noticeCases.flatMap((entry,i)=>{
    try{assert.deepStrictEqual(actual[i],entry.expected);return [];}
    catch{return [{scenario:entry.name,expected:entry.expected,rust:actual[i]}];}
  });
  if(differences.length)console.error(JSON.stringify(differences,null,2));
  assert.equal(differences.length,0,"Rust workflow notice must match TS");
});

test("an already-copied payment uses the identical stored original TS signature",()=>{
  const state=base();
  state.workflow.events.push({id:"copy-1",groupId:gid,
    action:"메시지 복사",after:{type:"PAYMENT",signature:paymentSignature(state,gid)}});
  assert.equal(paymentWasCopied(state,gid),true);
  const input=[{operation:"payment_copy_status",
    payload:{state,groupId:gid,mode:"payment_copy_status",
      accountWire:state.settings.accounts.map(a=>({id:a.id,json:JSON.stringify(a)}))}}];
  const r=spawnSync("cargo",["run","--quiet","--manifest-path",manifest,
    "--bin","parity_runner"],{cwd:root,input:JSON.stringify(input),
      encoding:"utf8",timeout:180000,maxBuffer:64*1024*1024});
  if(r.error)throw r.error;
  assert.equal(r.status,0,r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout),[{ok:true,value:{copied:true}}]);
});

test("Rust optional greeting keeps the original TS behavior on edited copy texts",()=>{
  const texts=[
    "", "받으실 분 연락처 부탁드려요.",
    "안녕하세요 반도스탠드입니다.\n\n받으실 분 연락처 부탁드려요.",
    "  안녕하세요 반도스탠드입니다.\n\n기존 인사말",
    "안녕하세요.\n\n합계 : 10,000원 입니다.",
  ];
  const requests=texts.flatMap(text=>[false,true].map(includeGreeting=>({
    operation:"decorate_automatic_copy",payload:{text,includeGreeting},
  })));
  const r=spawnSync("cargo",["run","--quiet","--manifest-path",manifest,
    "--bin","parity_runner"],{cwd:root,input:JSON.stringify(requests),
      encoding:"utf8",timeout:180000,maxBuffer:64*1024*1024});
  if(r.error)throw r.error;
  assert.equal(r.status,0,r.stderr);
  const actual=JSON.parse(r.stdout);
  assert.deepStrictEqual(actual,texts.flatMap(text=>[false,true].map(includeGreeting=>({
    ok:true,value:{text:includeGreeting?withGreeting(text):text},
  }))));
});


/** Real provisional-quantity flow: production Rust staff approval, not an
 * authored quantityApproval fixture, then the same Rust output used by
 * MessageWorkspace's copy buttons. This protects against a green isolated
 * message parity test while the actual button->draft->copy chain is broken.
 */
const rulesManifest=fileURLToPath(new URL("../rules/Cargo.toml",import.meta.url));
const { approveMissingQuantity, orderIssues } =
  await tsImport("../../../src/validation.ts",import.meta.url);
const { customerModel } =
  await tsImport("../../../src/matching.ts",import.meta.url);

function compiledRules(operations){
  const r=spawnSync("cargo",["run","--quiet","--manifest-path",rulesManifest,
    "--bin","json_rules"],{cwd:root,
    input:operations.map(v=>JSON.stringify(v)).join("\n")+"\n",
    encoding:"utf8",timeout:180000,maxBuffer:64*1024*1024});
  if(r.error)throw r.error;
  assert.equal(r.status,0,r.stderr);
  const rows=r.stdout.trim().split(/\r?\n/).map(JSON.parse);
  assert.equal(rows.length,operations.length);
  return rows;
}
function compiledOutput(cases){
  const r=spawnSync("cargo",["run","--quiet","--manifest-path",manifest,
    "--bin","parity_runner"],{cwd:root,input:JSON.stringify(cases),
    encoding:"utf8",timeout:180000,maxBuffer:64*1024*1024});
  if(r.error)throw r.error;
  assert.equal(r.status,0,r.stderr);
  const rows=JSON.parse(r.stdout);
  assert.equal(rows.length,cases.length);
  return rows;
}
function copyRequest(state,includeLinks=false){
  return {operation:"render_automatic_message",payload:{
    state,groupId:gid,includeLinks,accountWire:state.settings.accounts.map(a=>({
      id:a.id,json:JSON.stringify(a)
    }))
  }};
}
const approvalTime="2026-11-14T14:15:00.000Z";
const actor="검증 담당";

test("real Rust approve_missing_quantity flows to one exact copyable 1-item notice; cancellation and manual fix remove it",()=>{
  const original=base();
  const item=original.orders[0].recipients[0].items[0];
  item.quantity=null;
  item.quantityConfirmed=false;
  const initial=compiledOutput([copyRequest(original)])[0];
  assert.equal(initial.ok,true,JSON.stringify(initial));
  assert.equal(initial.value.phase,"request",
    "Missing quantity should require customer/staff action before provisional approval");
  const reply=compiledRules([{operation:"apply_issue_action",payload:{
    action:"approve_missing_quantity",order:original.orders[0],
    recipientId:"r1",itemId:"i1",actor,now:approvalTime
  }}])[0];
  assert.equal(reply.ok,true,JSON.stringify(reply));
  const approved=reply.value.order;
  const recorded=approved.recipients[0].items[0];
  assert.equal(recorded.quantity,1);
  assert.equal(recorded.quantityConfirmed,false,
    "Provisional quantity must not impersonate actual customer confirmation");
  assert.deepStrictEqual(recorded.quantityApproval,{
    actor,at:approvalTime,quantity:1,
  });
  assert.equal(recorded.manuallyConfirmed,true);
  original.orders[0]=approved;
  const approvedIssue=compiledRules([{operation:"order_issues",payload:{
    order:approved
  }}])[0];
  assert.equal(approvedIssue.ok,true,JSON.stringify(approvedIssue));
  const quantityIssue=approvedIssue.value.issues.find(i=>i.kind==="QUANTITY_MISSING");
  assert.equal(quantityIssue?.resolution,"PROVISIONALLY_APPROVED");
  assert.equal(quantityIssue?.severity,"INFO");
  assert.deepStrictEqual(approvedIssue.value.issues,orderIssues(approved));
  const live=compiledOutput([
    copyRequest(original),copyRequest(original,true),
    {operation:"render_payment_notice",payload:{state:original,groupId:gid}},
  ]);
  live.forEach(result=>assert.equal(result.ok,true,JSON.stringify(result)));
  assert.equal(live[0].value.phase,"payment");
  assert.equal(live[1].value.phase,"payment");
  const note=`김민수님 ${customerModel("BD 709")} 상품은 수량을 1개로 보내드리겠습니다.`;
  for(const result of live){
    const message=result.value.text??result.value.payment;
    assert.equal(message.split(note).length-1,1,
      "One provisional approval must produce exactly one customer notice");
  }
  assert.deepStrictEqual(live[0].value.phase,automaticMessage(original,gid).phase);
  assert.equal(live[0].value.text,automaticMessage(original,gid).text);
  assert.equal(live[1].value.text,automaticMessage(original,gid,true).text);
  assert.equal(live[2].value.payment,groupMessages(original,gid).payment);
  assert.ok(live[0].value.text.indexOf(note)<live[0].value.text.indexOf("합계 :"),
    "Quantity-one notice must appear before the payment total and account");
  assert.doesNotMatch(live[0].value.text,/수량을 확인 부탁드립니다/);

  const cancelled=structuredClone(original);
  delete cancelled.orders[0].recipients[0].items[0].quantityApproval;
  const modified=structuredClone(original);
  modified.orders[0].recipients[0].items[0].quantity=2;
  modified.orders[0].recipients[0].items[0].quantityConfirmed=true;
  delete modified.orders[0].recipients[0].items[0].quantityApproval;
  for(const [name,state,phase] of [
    ["approval cancelled",cancelled,"request"],
    ["actual quantity confirmed",modified,"payment"],
  ]){
    const actual=compiledOutput([copyRequest(state)])[0];
    assert.equal(actual.ok,true,`${name}: ${JSON.stringify(actual)}`);
    assert.equal(actual.value.phase,phase,name);
    assert.equal(actual.value.text,automaticMessage(state,gid).text,name);
    assert.doesNotMatch(actual.value.text,/수량을 1개로 보내드리겠습니다/,
      name+" must not retain a stale provisional promise");
  }
});

test("provisional quantity notice respects custom template, other blockers and multi-recipient grouping",()=>{
  const state=base();
  const item=state.orders[0].recipients[0].items[0];
  item.quantity=null;item.quantityConfirmed=false;
  const reply=compiledRules([{operation:"apply_issue_action",payload:{
    action:"approve_missing_quantity",order:state.orders[0],
    recipientId:"r1",itemId:"i1",actor,now:approvalTime
  }}])[0];
  assert.equal(reply.ok,true,JSON.stringify(reply));
  state.orders[0]=reply.value.order;
  state.settings.automaticMessageTemplates={
    quantityOne:"{수취인}님 {상품명} 1개 발송 예정으로 안내드립니다.",
  };
  const grouped=structuredClone(state.orders[0].recipients[0]);
  grouped.id="r2";grouped.name="이가상";
  grouped.items[0].id="i2";
  grouped.items[0].quantity=3;
  grouped.items[0].quantityConfirmed=true;
  delete grouped.items[0].quantityApproval;
  state.orders[0].recipients.push(grouped);
  state.workflow.shipments.push({
    ...structuredClone(state.workflow.shipments[0]),
    id:"ship2",recipientId:"r2",charges:{FACTORY:4000},
  });
  const message=compiledOutput([copyRequest(state),copyRequest(state,true) ]);
  const note=`김민수님 ${customerModel("BD 709")} 1개 발송 예정으로 안내드립니다.`;
  for(let i=0;i<message.length;i++){
    const output=message[i];
    assert.equal(output.ok,true,JSON.stringify(output));
    assert.equal(output.value.phase,"payment");
    assert.equal(output.value.text.split(note).length-1,1);
    assert.equal(output.value.text,automaticMessage(state,gid,i===1).text);
    assert.doesNotMatch(output.value.text,/이가상님.*1개 발송 예정/);
  }
  // An unresolved address still selects the request phase. A provisional
  // notice must not trick the user into a premature payment copy.
  state.orders[0].recipients[1].name="";
  const blocked=compiledOutput([copyRequest(state)])[0];
  assert.equal(blocked.ok,true,JSON.stringify(blocked));
  assert.equal(blocked.value.phase,"request");
  assert.equal(blocked.value.text,automaticMessage(state,gid).text);
  assert.doesNotMatch(blocked.value.text,/1개 발송 예정/,
    "Payment-only note must not leak into the request phase");
});
