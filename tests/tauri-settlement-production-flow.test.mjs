import { test } from "node:test";
import assert from "node:assert/strict";
import { tsImport } from "tsx/esm/api";

const { orderHistory } = await tsImport("../src/app/order-history.ts", import.meta.url);
const { dailySettlement } = await tsImport("../src/app/settlement-report.ts", import.meta.url);

function realWorkflowFixture() {
  const c = { id:"dealer", name:"거래처A", contact:"", tier:"wholesale", payment:"PREPAID",
    shippingFeeExcluded:false, active:true, identifiers:"", overrides:{} };
  const item = (id, origin) => ({ id,productId:"product",variantId:"option",
    raw:"BD 709",name:"BD 709",color:"블랙",quantity:1,unitPrice:100000,
    origin,defaulted:false,issues:[],url:"" });
  const r1 = { id:"r1",name:"박수취",address:"서울 서초구 1",phone:"02-1234-5555",
    mobile:"",note:"",items:[item("i1","FACTORY")] };
  const r2 = { id:"r2",name:"김수취",address:"인천 미추홀구 7",phone:"032-123-5555",
    mobile:"",note:"",items:[item("i2","STORE")] };
  const order = {
    id:"order",clientId:"dealer",clientSnapshot:c,pricesLocked:true,
    raw:"BD 709 각 1개",channel:"kakao",orderType:"AGENCY",
    createdAt:"2026-11-07T10:00:00+09:00",confirmedAt:"2026-11-07T11:00:00+09:00",
    updatedAt:"2026-11-07T11:00:00+09:00",recipients:[r1,r2],
    shippingFee:null,applyVat:true,vatAmount:null,
    status:"EXPORTED",notified:true,paid:false,postpaidApproved:false,freightCode:"010",
  };
  const shipping = (id, recipientId, origin, cost) => ({
    id,recipientId,orderId:"order",sourceId:"source:order",groupId:"group:order",
    step:4,completedAt:{},transferred:true,legacyArchived:false,charges:{[origin]:cost},
    actualFreight:{[origin]:cost-500},chargeMode:"MANUAL",freightVersion:"1",infoSignature:"x",
  });
  const shipA=shipping("shipment-a","r1","FACTORY",4000);
  const shipB=shipping("shipment-b","r2","STORE",2500);
  const queue = (id, recipient, origin, subtotal, freight, vat, total) => ({
    id:"queue:"+id,shipmentId:id,origin,status:origin==="FACTORY"?"EXPORTED":"STORE_SENT",
    actor:"직원",at:"2026-11-07T11:20:00+09:00",
    snapshot:{recipient,sender:c,freightCode:"010",subtotal,shipping:freight,vat,total},
  });
  const acc={id:"bank1",bank:"우리",holder:"반도",number:"00000"};
  const payment={ id:"pay1",dealerId:c.id,account:acc,amount:70000,
    paidAt:"2026-11-07T15:00:00+09:00",recordedAt:"2026-11-08T09:00:00+09:00",
    actor:"직원",memo:"",allocations:[
      {id:"a1",shipmentId:"shipment-a",amount:50000},
      {id:"a2",shipmentId:"shipment-b",amount:20000},
    ] };
  return {
    revision:1,products:[],clients:[c],aliases:[],orders:[order],
    queue:[],exports:[],settings:{accounts:[acc],operatorName:"직원"},
    workflow:{sources:[],groups:[{id:"group:order",dealerId:c.id,sourceId:"source:order",
      notices:[],needsNotice:false}],shipments:[shipA,shipB],
      payments:[payment],confirmations:[],queue:[
        queue(shipA.id,r1,"FACTORY",100000,4000,10400,114400),
        queue(shipB.id,r2,"STORE",20000,2500,0,22500),
      ],events:[],deliveries:[],changeRequests:[]},
  };
}

test("real domain workflow totals: mixed factory/store snapshots sum once and cash stays separate", () => {
  const state=realWorkflowFixture();
  const before=JSON.stringify(state);
  const history=orderHistory(state,"","2026-11-07");
  assert.equal(history.length,1);
  assert.equal(history[0].billing.subtotal,120000);
  assert.equal(history[0].billing.shipping,6500);
  assert.equal(history[0].billing.vat,10400);
  assert.equal(history[0].billing.total,136900);
  assert.equal(history[0].shipmentIds.length,2);
  const report=dailySettlement(state,"2026-11-07",history);
  assert.equal(report.billedKnown,136900);
  assert.equal(report.paidCash,70000);
  assert.equal(report.allocatedCash,70000);
  assert.equal(report.unallocatedCash,0);
  assert.equal(report.orderRows[0].paidAllocated,70000);
  assert.equal(report.outstandingKnown,66900);
  assert.equal(report.actualFreightKnown,5500);
  assert.equal(JSON.stringify(state),before);
});

test("real domain workflow excludes canceled groups and unconfirmed orders from a day", () => {
  const state=realWorkflowFixture();
  const group=state.workflow.groups[0];
  group.deletedAt="2026-11-08T00:00:00+09:00";
  assert.equal(orderHistory(state,"","2026-11-07").length,0);
  delete group.deletedAt;
  delete state.orders[0].confirmedAt;
  state.orders[0].receptionVersion=1;
  assert.equal(orderHistory(state,"","2026-11-07").length,0);
});
