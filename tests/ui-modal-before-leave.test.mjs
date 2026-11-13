import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
const read=(p)=>readFileSync(new URL("../"+p,import.meta.url),"utf8");
test("confirmation dialogs stack without closing the editor first",()=>{
  const modal=read("src/ui/Modal.tsx"), dialog=read("src/dialogs.ts");
  assert.doesNotMatch(modal,/modalStack\.at\(-1\)\?\.close\(\)/);
  assert.doesNotMatch(modal,/parent\?\.isConnected && !parent\.open\) parent\.showModal/);
  assert.doesNotMatch(dialog,/pauseModalLayer\(\)/);
  assert.match(dialog,/dialog\.showModal\(\)/);
  assert.match(dialog,/finish\("cancel"\)/);
});
test("freight rows use independent compact columns, without obsolete subtitles",()=>{
  const product=read("src/ProductFreightPanel.tsx"), groups=read("src/ShippingManager.tsx");
  assert.match(product,/<th>동급 배송그룹<\/th>/);
  assert.match(product,/<th>운임 등록 상태<\/th>/);
  assert.match(product,/<th>합포장<\/th>/);
  assert.doesNotMatch(product,/<th key=\{n\}>\{n\}개 운임<\/th>/);
  assert.doesNotMatch(groups,/>상품명 \/ 부제</);
  assert.doesNotMatch(read("src/ProductManager.tsx"),/>상품명 \/ 부제</);
  assert.doesNotMatch(groups,/<small>\{p\.subtitle \|\| p\.originalName \|\| p\.name\}<\/small>/);
});
