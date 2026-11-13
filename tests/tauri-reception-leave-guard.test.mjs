import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
const source = readFileSync(new URL("../src/app/useAppModel.ts",import.meta.url),"utf8");
test("reception drafts are checked before navigation and selecting other orders",()=>{
 assert.match(source,/const confirmReceptionDraftLeave = async \(\): Promise<boolean>/);
 assert.match(source,/askSaveChanges\("접수 화면에 저장하지 않은 변경사항이 있습니다/);
 assert.match(source,/if \(!leave\.handledDraft && !\(await confirmReceptionDraftLeave\(\)\)\) return;/);
 assert.match(source,/else if \(!leave\.handledDraft && !\(await confirmReceptionDraftLeave\(\)\)\) return false;/);
 assert.match(source,/주문 확인 완료 후 저장할 수 있습니다/);
 assert.match(source,/setDraft\(persisted \? clone\(persisted\) : newReception\(\)\)/);
});
