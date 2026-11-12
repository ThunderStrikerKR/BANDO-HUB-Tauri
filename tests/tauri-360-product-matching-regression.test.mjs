import assert from "node:assert/strict";
import test from "node:test";
import {readFileSync} from "node:fs";
import {tsImport} from "tsx/esm/api";

const state=JSON.parse(readFileSync(new URL("../src-tauri/resources/state-seed.json", import.meta.url),"utf8"));
const products=state.products.filter(p=>p.active!==false&&!p.deletedAt&&!p.supersededBy);
const {
  registeredNameCandidates, scoreStandTop, verifiedScoreStandBases,
} = await tsImport("../src/product-name-match.ts", import.meta.url);
const match=raw=>registeredNameCandidates(products,raw);
const one=(raw,prefix)=>{
  const result=match(raw);
  assert.equal(result.length,1,raw+" => "+result.map(p=>p.name).join("; "));
  assert.ok(result[0].name.startsWith(prefix),raw+": "+result[0].name);
};

test("all 358 active catalog names remain findable by registered name",()=>{
  assert.equal(state.products.length,360);
  assert.equal(products.length,358);
  for(const product of products) {
    const candidates=match(product.name);
    assert.ok(candidates.some(candidate=>candidate.id===product.id),
      product.name+" absent from "+candidates.map(p=>p.name).join("; "));
  }
});

test("model boundaries prefer the longest actual model, not a substring",()=>{
  one("BD MIC holder 1개","BD MIC holder");
  one("BD 708 BR 1개","BD 708 BR");
  one("BDBL-1500용 조명 홀더 / 조명 4개 설치 가능","BDBL-1500용 조명 홀더");
  one("BD C-Clip + BTS 1개","BD C-Clip + BTS");
  one("C-Clip + D-BTS 1개","BD C-Clip + D-BTS");
});

test("registered independent SKU options are applied in their original positions",()=>{
  const checks=[
    ["BD GT-10 통기타 전용 평평한 벽용 1개","BD GT-10 / 기타 벽걸이 / 통기타 전용 / 평평한 벽용"],
    ["BD GT-10 일렉 및 베이스 전용 스페이스 벽용 1개","BD GT-10 / 기타 벽걸이 / 일렉 및 베이스 전용 / 스페이스 벽용"],
    ["BD GT-U P형 1개","BD GT-U / P형"],
    ["BD Z-4 상판 1 42×34cm 상판 2 37×29cm 1개","BD Z-4 / 상판 1 42×34cm / 상판 2 37×29cm"],
    ["BD Z-2 바퀴 포함 1개","BD Z-2 / 바퀴 포함"],
    ["BD LP-WA A타입 상판 1개","BD LP-WA / A타입 상판"],
    ["BD 1200A 상판 42×34cm 1개","BD 1200A / 1개 / 상판 42×34cm"],
    ["BD 700S 그레이 1개","BD 700S / 그레이"],
    ["스피커홀더 B형 1개","스피커홀더 / B형"],
    ["케이블홀더 2번 18mm 1개","케이블홀더 / 2번 18mm"],
    ["BD BL-1500용 조명 홀더 조명 8개 설치 가능","BD BL-1500용 조명 홀더 / 조명 8개"],
  ];
  for(const [raw,name] of checks) one(raw,name);
  assert.equal(match("BD GT-10 1개").length,4);
  assert.equal(match("BD Z-4 1개").length,4);
  assert.equal(match("BD 700S 1개").length,4);
});

test("stand top and color must select independent 708/709 registered SKU",()=>{
  const verified=verifiedScoreStandBases(products);
  assert.ok(verified.has("708"));
  assert.ok(verified.has("709"));
  for(const [raw,prefix] of [
    ["709 민판 한개","BD 709-1 / 블랙"],
    ["709 민판 그레이 1개","BD 709-1G / 그레이"],
    ["708 무타공 브라운 1개","BD 708-1BR / 브라운"],
    ["709 타공 그레이 1개","BD 709G / 그레이"],
    ["708 타공 브라운 1개","BD 708 BR / 브라운"],
    ["709 타공 1개","BD 709 / 블랙"],
  ]) one(raw,prefix);
  const oldStand=products.find(p=>p.name==="BD 777 / 고정형 보면대");
  assert.equal(scoreStandTop(oldStand,verified),null);
  for(const code of ["BD GT-1","BD SS-1","BD Desk TS-1"]){
    const item=products.find(p=>p.name.startsWith(code+" /"));
    assert.ok(item,code);
    assert.equal(scoreStandTop(item,verified),null);
  }
});

test("isolated color, dimension and pack-size words are not product identities",()=>{
  for(const raw of [
    "다크 그린 1개","길이 10cm 1개","높이 22cm 1개",
    "Bar 길이 22cm 1개","1조(2개)","2개 거치",
    "조명 8개 설치 가능","상판 각도 조절형",
  ]) assert.equal(match(raw).length,0,raw);
});

test("existing data duplicates stay unresolved without modifying IDs",()=>{
  const same=products.filter(p=>p.name==="마이크물림쇠 세트 / 35cm / 블랙");
  assert.equal(same.length,2);
  assert.equal(match("마이크물림쇠 세트 / 35cm / 블랙 1개").length,2);
  assert.equal(match("마우스트레이 1개").length,2);
});

test("whole-document reception resolves catalog model and option evidence",async()=>{
  const {parseSmart}=await tsImport("../src/parser.ts",import.meta.url);
  const {unassignedClient}=await tsImport("../src/domain.ts",import.meta.url);
  const client={...unassignedClient,id:"audit-recipient",name:"가상 테스트 거래처",tier:"retail",overrides:{}};
  for(const [raw,wanted] of [
    ["709 타공 그레이 1개","BD 709G / 그레이"],
    ["709 민판 그레이 1개","BD 709-1G / 그레이"],
    ["BD GT-10 통기타 전용 평평한 벽용 1개","BD GT-10 / 기타 벽걸이 / 통기타 전용 / 평평한 벽용"],
    ["BD Z-4 상판 1 42×34cm 상판 2 37×29cm 1개","BD Z-4 / 상판 1 42×34cm / 상판 2 37×29cm"],
    ["스피커홀더 B형 1개","스피커홀더 / B형"],
    ["케이블홀더 2번 18mm 1개","케이블홀더 / 2번 18mm"],
  ]){
    const items=parseSmart(raw,client,state).flatMap(recipient=>recipient.items);
    assert.equal(items.length,1,raw+": "+JSON.stringify(items.map(x=>x.name)));
    const product=products.find(p=>p.id===items[0].productId);
    assert.equal(product?.name,wanted,raw+": "+JSON.stringify(items[0]));
    assert.equal(items[0].quantity,1,raw);
  }
});
