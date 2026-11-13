import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
const read=(p)=>readFileSync(new URL("../"+p,import.meta.url),"utf8");
test("freight editors add intervals on demand, without redundant fields",()=>{
  const a=read("src/ProductFreightPanel.tsx"),b=read("src/ShippingManager.tsx"),shared=read("src/ShippingFeeRanges.tsx");
  for(const source of [a,b]){
    assert.match(source,/<ShippingFeeRanges /);
    for(const obsolete of ["운임 적용 시작일","운임 적용 종료일","운임 적용 기준","실제 합포장 가능 여부"])
      assert.doesNotMatch(source,new RegExp(obsolete));
  }
  assert.match(shared,/운임 구간 추가/);
  assert.match(shared,/useState<number\[\]>/);
  assert.doesNotMatch(shared,/bundleCounts\(/);
  assert.doesNotMatch(b,/<th key=\{n\}>\{n\}개<\/th>/);
  assert.match(b,/<th>운임 등록 상태<\/th>/);
  assert.match(b,/<th>직원 참고 메모<\/th>/);
});
test("the maximum bundle count is sufficient for packability checks",()=>{
  const source=read("src/shipping.ts");
  assert.doesNotMatch(source,/r\.packable/);
  assert.match(source,/r\.maxBundle === 1/);
  assert.match(source,/return !!rule/);
});
