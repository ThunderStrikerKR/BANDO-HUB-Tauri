import { test } from "node:test";
import assert from "node:assert/strict";
import { tsImport } from "tsx/esm/api";

const { seed, blankOrder } = await tsImport("../src/seed.ts", import.meta.url);
const { initialShipping } = await tsImport("../src/shipping.ts", import.meta.url);
const { reconcileWorkflow, shipmentTotals, groupContext, groupAccount, setShipmentFreight } =
  await tsImport("../src/workflow.ts", import.meta.url);
const { orderParty } = await tsImport("../src/order-types.ts", import.meta.url);
const { orderClient, totals } = await tsImport("../src/domain.ts", import.meta.url);
const { orderHistory } = await tsImport("../src/app/order-history.ts", import.meta.url);
const { dailySettlement } = await tsImport("../src/app/settlement-report.ts", import.meta.url);

function createFixture({ waived = false, vat = false } = {}) {
  const state = seed();
  state.shipping = initialShipping();
  const product = state.products[0];
  product.shippingGroupId = "music";
  const client = state.clients[0];
  client.shippingFeeExcluded = waived;
  client.payment = "PREPAID";
  client.tier = "wholesale";
  client.preferredAccountId = "account-before";
  state.settings.accounts = [
    { id:"account-before",bank:"테스트은행",number:"000-111",holder:"가상상호" },
    { id:"account-after",bank:"테스트은행",number:"000-222",holder:"가상상호" },
  ];
  const order = {
    ...blankOrder(client.id),
    id: "frozen-order",
    raw: "가상 주문 1개",
    orderType: "AGENCY",
    confirmedAt: "2026-11-11T09:00:00+09:00",
    createdAt: "2026-11-11T09:00:00+09:00",
    updatedAt: "2026-11-11T09:00:00+09:00",
    pricesLocked: true,
    clientSnapshot: structuredClone(client),
    status: "STATEMENT",
    shippingFee: waived ? 0 : 3000,
    applyVat: vat,
    recipients: [{
      id:"recipient-1",name:"가상 수취인",address:"서울특별시 가상로 1",
      phone:"02-0000-0000",mobile:"",note:"",vatDefault:vat,
      items:[{
        id:"item-1",productId:product.id,variantId:product.variants[0].id,
        raw:"가상 제품 1개",name:product.name,color:"Black",quantity:1,
        unitPrice:30000,origin:"FACTORY",issues:[],url:"",
      }],
    }],
  };
  const frozen = reconcileWorkflow({ ...state, orders:[order] });
  const ship = frozen.workflow.shipments.find(s => s.orderId === order.id);
  assert.ok(ship, "Shipment must be created before master data changes");
  assert.equal(ship.charges.FACTORY, waived ? 0 : 3000);
  ship.step = 3;
  ship.completedAt = {1:order.confirmedAt,2:order.confirmedAt,3:order.confirmedAt};
  return { frozen, shipId: ship.id, clientId: client.id, productId: product.id, groupId: "group:" + order.id };
}

function updateMaster(fixture, { waiver, payment = "POSTPAID" }) {
  const latest = structuredClone(fixture.frozen);
  const client = latest.clients.find(c=>c.id===fixture.clientId);
  client.shippingFeeExcluded = waiver;
  client.payment = payment;
  client.tier = "retail";
  client.preferredAccountId = "account-after";
  client.name = "거래처 새 이름";
  client.overrides = { [fixture.productId]: 1 };
  latest.shipping.epoch += 1;
  const music = latest.shipping.groups.find(g=>g.id==="music");
  music.current = { ...music.current, version:"new-master-version",
    fees:{...music.current.fees,"1":9000} };
  latest.products.find(p=>p.id===fixture.productId).variants[0].wholesale = 1;
  return latest;
}

test("confirmed order keeps its price, customer freight and payment terms after a new client tariff", () => {
  const fixture = createFixture({vat:true});
  const before = shipmentTotals(fixture.frozen, fixture.frozen.workflow.shipments[0]);
  assert.deepEqual(before, {subtotal:30000,shipping:3000,vat:3300,total:36300});
  const oldVersion = fixture.frozen.workflow.shipments[0].freightVersion;
  const changed = reconcileWorkflow(updateMaster(fixture,{waiver:true}));
  const order = changed.orders.find(o=>o.id==="frozen-order");
  const ship = changed.workflow.shipments.find(s=>s.id===fixture.shipId);
  assert.deepEqual(shipmentTotals(changed, ship), before);
  assert.equal(ship.charges.FACTORY,3000);
  assert.equal(ship.freightVersion,oldVersion);
  assert.equal(ship.step,3,"Later master price changes must not undo workflow progress");
  assert.equal(groupContext(changed, fixture.groupId).client.payment,"PREPAID");
  assert.equal(orderParty(order,changed).shippingFeeExcluded,false);
  assert.equal(orderClient(order,changed).payment,"PREPAID");
  assert.equal(groupAccount(changed,fixture.groupId).id,"account-before");
  assert.equal(order.recipients[0].items[0].unitPrice,30000);
  const history = orderHistory(changed,"","2026-11-11");
  assert.equal(history.length,1);
  assert.equal(history[0].billing.total,36300);
  assert.equal(dailySettlement(changed,"2026-11-11",history).billedKnown,36300);
  assert.equal(order.confirmedAt,"2026-11-11T09:00:00+09:00");
});

test("existing fee waiver remains zero when it is removed for new business", () => {
  const fixture = createFixture({waived:true});
  const changed = reconcileWorkflow(updateMaster(fixture,{waiver:false}));
  const order = changed.orders.find(o=>o.id==="frozen-order");
  const ship = changed.workflow.shipments.find(s=>s.id===fixture.shipId);
  assert.equal(ship.charges.FACTORY,0);
  assert.equal(shipmentTotals(changed,ship).total,30000);
  assert.equal(orderParty(order,changed).shippingFeeExcluded,true);
  assert.equal(groupContext(changed,fixture.groupId).client.payment,"PREPAID");
});

test("unconfirmed new orders use new terms and shipping rates", () => {
  const fixture = createFixture();
  const latest = updateMaster(fixture,{waiver:false});
  const nextOrder = structuredClone(latest.orders[0]);
  nextOrder.id = "next-order";
  nextOrder.recipients[0].id = "next-recipient";
  nextOrder.recipients[0].items[0].id = "next-item";
  nextOrder.pricesLocked = false;
  delete nextOrder.confirmedAt;
  delete nextOrder.clientSnapshot;
  nextOrder.status = "REVIEW";
  nextOrder.recipients[0].shippingCharges = undefined;
  latest.orders.push(nextOrder);
  const current = reconcileWorkflow(latest);
  const newShip = current.workflow.shipments.find(s=>s.orderId==="next-order");
  assert.equal(newShip.charges.FACTORY,9000);
  assert.equal(groupContext(current,"group:next-order").client.payment,"POSTPAID");
});

test("employee's explicit order freight edit still changes that order, without adopting the revised master rate", () => {
  const fixture = createFixture();
  const changed = reconcileWorkflow(updateMaster(fixture,{waiver:false}));
  const edited = setShipmentFreight(changed, fixture.shipId, "FACTORY", 6500);
  const ship = edited.workflow.shipments.find(s=>s.id===fixture.shipId);
  assert.equal(ship.charges.FACTORY,6500);
  assert.equal(ship.chargeMode,"MANUAL");
  assert.equal(shipmentTotals(edited,ship).shipping,6500);
  assert.equal(ship.step,1,"Employee-initiated change still requires freight re-approval");
});
