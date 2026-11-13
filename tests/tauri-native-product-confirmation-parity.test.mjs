/** Original TypeScript product-confirmation oracle against the compiled Rust domain. */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tsImport } from "tsx/esm/api";

const { resolveProduct, confirmProposedProduct } =
  await tsImport("../src/issue-actions.ts", import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));
const cargo = fileURLToPath(new URL("../tests/rust-migration/integration/Cargo.toml", import.meta.url));
const now = "2026-11-13T12:00:00.000Z";
const itemId = "native-new-item";
const aliasId = "native-new-alias";

function originalWithFixedInputs(fn) {
  const DateBefore = globalThis.Date;
  const cryptoBefore = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  let id = 0;
  class FixedDate extends DateBefore {
    constructor(...args) { super(args.length ? args[0] : now); }
    static now() { return new DateBefore(now).getTime(); }
  }
  Object.defineProperty(globalThis, "Date", { configurable: true, value: FixedDate });
  Object.defineProperty(globalThis, "crypto", {
    configurable: true, value: { randomUUID: () => {
      const next = [itemId, aliasId][id++];
      if (!next) throw Error("Unexpected TypeScript UUID call");
      return next;
    } },
  });
  try { return fn(); }
  finally {
    Object.defineProperty(globalThis, "Date", { configurable: true, value: DateBefore });
    if (cryptoBefore) Object.defineProperty(globalThis, "crypto", cryptoBefore);
    else delete globalThis.crypto;
  }
}
const clone = (value) => structuredClone(value);
function base() {
  const product = {
    id:"p1",code:"709",name:"BD 709 / 보면대",category:"보면대",origin:"FACTORY",
    active:true,defaultColor:"Black",catalog:"BANDOSTAND",
    variants:[{id:"v1",color:"Black",source:"MANUAL",wholesale:30000,
      semi:35000,retail:40000,url:""}],
  };
  const client = {id:"c1",name:"가상 거래처",tier:"wholesale",payment:"PREPAID",
    shippingFeeExcluded:false,overrides:{}};
  const item = {
    id:"i1",productId:null,variantId:null,raw:"709 2개",name:"보면대",color:"",
    quantity:2,quantityConfirmed:true,unitPrice:null,origin:"FACTORY",
    defaulted:false,issues:["기존 오류"],url:"",
    sources:[{start:0,end:3,text:"709",field:"product",targetId:"i1"}],
  };
  const order = {id:"o1",clientId:"c1",raw:"709 2개",orderType:"AGENCY",
    recipients:[{id:"r1",name:"홍길동",address:"서울특별시 강남구 테헤란로 1",
      phone:"01012345678",mobile:"",note:"",items:[item]}]};
  const state = {products:[product],clients:[client],aliases:[],
    settings:{operatorName:"가상 직원"},orders:[],queue:[],
    exports:[],workflow:{sources:[],groups:[],shipments:[],
      events:[],queue:[],changeRequests:[],payments:[],deliveries:[]}};
  return {state,order};
}
const cases = [];
function add(name,action,modify,scope="once",needsCustomer=false,variantId="v1",groupId) {
  const {state,order} = base();
  modify?.(state,order);
  const payload = {state,order,action,recipientId:"r1",itemId:"i1",
    productId:"p1",scope,needsCustomer,variantId,
    defaultColorGroupId:groupId,now,newItemId:itemId,aliasId};
  cases.push({name,payload,source:() => action === "confirm_proposed_product"
    ? confirmProposedProduct(state,order,"r1","i1")
    : resolveProduct(state,order,"r1","i1","p1",scope,
        needsCustomer,variantId,groupId)});
}
add("select independent SKU once", "resolve_product");
add("save client-scoped alias", "resolve_product", undefined, "client");
add("save common-scoped alias", "resolve_product", undefined, "common");
add("hold new alias pending customer confirmation", "resolve_product", undefined, "client", true);
add("customer confirmation requested, without alias", "resolve_product", undefined, "once", true);
add("existing alternate item and quantity approval", "resolve_product", (_s,o) => {
  const i = o.recipients[0].items[0];
  i.productId = "other"; i.variantId = "old";
  i.quantityApproval = {at:now,actor:"가상 직원",quantity:1};
}, "once");
add("reject unregistered product", "resolve_product", s => {s.products[0].deletedAt = now;});
add("reject unknown variant", "resolve_product", undefined, "once",false,"bad-option");
add("reject conflict with existing alias", "resolve_product", s => {
  s.aliases.push({id:"existing",clientId:"c1",text:"709",productId:"other",variantId:"old"});
}, "client");
add("select representative model only with explicit group membership",
  "resolve_product", (s) => {
    s.products.push({...clone(s.products[0]),id:"p2",name:"BD 709-2 / 보면대"});
    s.settings.colorGuidanceGroups = {
      group1:{name:"709 모음",productIds:["p1","p2"],representativeProductId:"p1"},
    };
  }, "once",false,"v1","group1");
add("reject mismatched representative model",
  "resolve_product", (s) => {
    s.products.push({...clone(s.products[0]),id:"p2",name:"BD 709-2 / 보면대"});
    s.settings.colorGuidanceGroups = {
      group1:{name:"709 모음",productIds:["p1","p2"],representativeProductId:"p2"},
    };
  }, "once",false,"v1","group1");
add("confirm customer-approved product", "confirm_proposed_product", (s,o) => {
  const i=o.recipients[0].items[0];
  i.productId="p1";i.variantId="v1";
  i.modelProposal={original:"709 2개",required:true};
  i.issues.push("추천 상품 고객 확인 필요");
  i.pendingAlias={id:"pending",text:"보면대",productId:"p1",variantId:"v1",
    clientId:"c1",createdAt:now,actor:"가상 직원"};
});
add("reject confirm without pending customer approval","confirm_proposed_product");
add("reject pending alias conflicting with registered product",
  "confirm_proposed_product", (s,o) => {
    const i=o.recipients[0].items[0];
    i.modelProposal={original:"709",required:true};
    i.pendingAlias={id:"pending",text:"709",clientId:"c1",
      productId:"p1",variantId:"v1"};
    s.aliases.push({id:"existing",text:"709",clientId:"c1",
      productId:"other",variantId:"old"});
  });
add("uppercase EA text trims alias like original regex", "resolve_product",
  (_s,o) => {o.recipients[0].items[0].raw="보면대 2EA";
    o.recipients[0].items[0].sources=[];}, "client");
add("NFKC fullwidth model normalized before alias conflict detection",
  "resolve_product", (s,o) => {
    o.recipients[0].items[0].raw="７０９ 2개";
    o.recipients[0].items[0].sources=[];
    s.aliases.push({id:"other-alias",clientId:"c1",text:"709",
      productId:"p1",variantId:"v1"});
  }, "client");
const requests = cases.map(c => ({
  domain:"rules",operation:"apply_product_action",payload:c.payload,
}));
const result = spawnSync("cargo",["run","--quiet","--manifest-path",cargo,
  "--bin","reception_runner"],{cwd:root,input:JSON.stringify(requests),
    encoding:"utf8",timeout:900000,maxBuffer:64*1024*1024});
if(result.error) throw result.error;
assert.equal(result.status,0,result.stderr);
const output = JSON.parse(result.stdout);
assert.equal(output.length,cases.length);
function actualBaseline(caseItem) {
  try {
    return {ok:true,value:JSON.parse(JSON.stringify(originalWithFixedInputs(caseItem.source)))};
  }catch(error){return {ok:false,error:String(error?.message ?? error)};}
}
cases.forEach((c,i) => test("product TS-Rust parity: "+c.name,() => {
  assert.deepEqual(output[i],actualBaseline(c),JSON.stringify(output[i]));
}));
