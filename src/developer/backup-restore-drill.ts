import type { Alias, Client, Item, Order, Recipient, State } from "../types";

export interface DrillMutation {
  next: State;
  orderId: string;
  productId: string;
  priceRecordId: string;
  previousPrice: number;
  testPrice: number;
  clientId: string;
  aliasIds: string[];
}
export interface DrillCheck {
  label: string;
  passed: boolean;
  detail: string;
}

/** Pure fixture. Its caller must gate writes to the isolated TEST workspace.
 * Uses the real production reception-validation requirements, rather than
 * editing SQLite directly or bypassing the Rust order boundary.
 */
export function buildDrillMutation(original: State, token: string, timestamp: string): DrillMutation {
  if (!/^[a-zA-Z0-9-]{6,80}$/.test(token)) {
    throw Error("검증 ID가 올바르지 않습니다.");
  }
  if (!Number.isSafeInteger(original.revision) || (original.revision ?? -1) < 0) {
    throw Error("TEST DB의 데이터 리비전을 확인할 수 없습니다.");
  }
  const next = structuredClone(original);
  const product = next.products.find((item) =>
    item.active !== false && !item.deletedAt && item.variants.length === 1 &&
    typeof item.variants[0].retail === "number" && item.variants[0].retail >= 0 &&
    item.variants[0].retail < 1_000_000_000,
  );
  if (!product) throw Error("검증 가능한 독립 상품과 소매가가 없습니다.");
  const price = product.variants[0];
  const previousPrice = price.retail as number;
  const testPrice = previousPrice + 137;
  price.retail = testPrice;
  const prefix = "backup-drill-" + token;
  const clientId = prefix + "-client";
  const orderId = prefix + "-order";
  const aliasIds = [prefix + "-global-alias", prefix + "-client-alias"];
  if (next.clients.some((client) => client.id === clientId) ||
      next.orders.some((order) => order.id === orderId) ||
      next.aliases.some((alias) => aliasIds.includes(alias.id))) {
    throw Error("동일한 검증 데이터가 이미 있습니다. 기존 백업을 복원한 뒤 다시 실행하세요.");
  }
  const client: Client = {
    id: clientId, name: "TEST 백업 검증 거래처", contact: "010-0000-0000",
    tier: "special", shippingFeeExcluded: false, payment: "PREPAID", active: true,
    identifiers: prefix, overrides: { [price.id]: Math.max(0, testPrice - 37) },
    address: "테스트 전용 가상 주소 1", phone: "010-0000-0000", mobile: "",
  };
  next.clients.push(client);
  const aliases: Alias[] = [
    { id: aliasIds[0], clientId: null, text: prefix + " 공통", productId: product.id, variantId: price.id },
    { id: aliasIds[1], clientId, text: prefix + " 거래처 전용", productId: product.id, variantId: price.id },
  ];
  next.aliases.push(...aliases);
  const item: Item = {
    id: prefix + "-item", productId: product.id, variantId: price.id,
    raw: product.name, name: product.name, color: price.color,
    quantity: 2, unitPrice: testPrice, origin: product.origin,
    defaulted: false, issues: [], url: price.url || "",
  };
  const recipient: Recipient = {
    id: prefix + "-recipient", name: "TEST 가상 수취인",
    address: "테스트 전용 가상 배송지 1", phone: "010-0000-0000",
    mobile: "", note: "실제 발송 금지", items: [item],
  };
  const raw = "TEST 전용 가상 발주서 / " + product.name + " 2개";
  const order: Order = {
    id: orderId, clientId, orderType: "DEALER",
    clientSnapshot: structuredClone(client), senderSnapshot: structuredClone(client),
    raw, channel: "TEST", recipients: [recipient],
    shippingFee: 0, applyVat: false, vatAmount: 0,
    status: "STATEMENT", notified: false, paid: false, postpaidApproved: false,
    freightCode: "010", createdAt: timestamp, updatedAt: timestamp,
    receptionVersion: 1, confirmedAt: timestamp,
    receipt: { original: raw, at: timestamp, actor: "TEST 검증", clientId, legacy: false },
    confirmationSnapshot: {
      at: timestamp, raw, client: structuredClone(client),
      recipients: structuredClone([recipient]),
      data: {
        id: orderId, clientId, raw, channel: "TEST",
        recipients: structuredClone([recipient]), orderType: "DEALER",
        shippingFee: 0, applyVat: false, vatAmount: 0, status: "STATEMENT",
        notified: false, paid: false, postpaidApproved: false, freightCode: "010",
        createdAt: timestamp, updatedAt: timestamp,
      },
    },
  };
  next.orders.push(order);
  if (!next.workflow || !Array.isArray(next.workflow.shipments) || !Array.isArray(next.workflow.events)) {
    throw Error("TEST DB의 주문 처리 기록 구조를 확인할 수 없습니다.");
  }
  next.workflow.shipments.push({
    id: prefix + "-shipment", orderId, recipientId: recipient.id, step: 1,
    // Other shipment fields are deliberately absent: this is never placed
    // in the shipping queue, never exported and never sent to a carrier.
  } as (typeof next.workflow.shipments)[number]);
  next.workflow.events.push({
    action: "주문 확인 완료", shipmentIds: [prefix + "-shipment"],
  } as (typeof next.workflow.events)[number]);
  return { next, orderId, productId: product.id, priceRecordId: price.id,
    previousPrice, testPrice, clientId, aliasIds };
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b)).map(([key, v]) => JSON.stringify(key) + ":" + stable(v)).join(",") + "}";
  }
  return JSON.stringify(value) ?? "null";
}
export function comparableState(state: State): string {
  const { revision: _revision, ...persistent } = state;
  return stable(persistent);
}
export function comparableArchive(archive: Awaited<ReturnType<NonNullable<typeof window.bando>["receiptArchive"]>>): string {
  return stable([...archive].sort((a, b) => a.id.localeCompare(b.id)));
}
export function verifyDrillMutation(after: State, sample: DrillMutation): DrillCheck[] {
  const product = after.products.find((p) => p.id === sample.productId);
  const changedPrice = product?.variants[0];
  const order = after.orders.find((o) => o.id === sample.orderId);
  const dealer = after.clients.find((c) => c.id === sample.clientId);
  return [
    { label: "독립 상품 가격 변경", passed: changedPrice?.id === sample.priceRecordId &&
      changedPrice.retail === sample.testPrice,
      detail: "기존 " + sample.previousPrice + "원 → 시험 " + sample.testPrice + "원" },
    { label: "가상 거래처 및 특수 단가", passed: dealer?.overrides[sample.priceRecordId] ===
      Math.max(0, sample.testPrice - 37), detail: "TEST 거래처 1개와 개별 단가" },
    { label: "공통 및 거래처 전용 별칭", passed: sample.aliasIds.every((id) =>
      after.aliases.some((a) => a.id === id && a.productId === sample.productId)),
      detail: "가상 별칭 2건" },
    { label: "가상 확정 주문과 품목", passed: order?.confirmedAt != null &&
      order.recipients[0]?.items[0]?.productId === sample.productId &&
      order.recipients[0]?.items[0]?.unitPrice === sample.testPrice,
      detail: "가상 주문 1건, 실제 발송 없음" },
  ];
}
export function verifyDrillRestore(
  baseline: State, recovered: State,
  archiveBefore: Awaited<ReturnType<NonNullable<typeof window.bando>["receiptArchive"]>>,
  archiveAfter: Awaited<ReturnType<NonNullable<typeof window.bando>["receiptArchive"]>>,
  sample: DrillMutation,
  revisionBeforeRestore: number,
): DrillCheck[] {
  const price = recovered.products.find((p) => p.id === sample.productId)?.variants[0];
  return [
    { label: "전체 업무 데이터 복원", passed: comparableState(baseline) === comparableState(recovered),
      detail: "상품, 거래처, 주문, 별칭, 출고 및 설정 전체 비교" },
    { label: "소매가와 가격 기록 ID", passed: price?.retail === sample.previousPrice &&
      price.id === sample.priceRecordId,
      detail: "가격 " + sample.previousPrice + "원으로 복원" },
    { label: "TEST 가상 주문과 별칭 제거", passed: !recovered.orders.some((o) => o.id === sample.orderId) &&
      !recovered.clients.some((c) => c.id === sample.clientId) &&
      !recovered.aliases.some((a) => sample.aliasIds.includes(a.id)),
      detail: "시험 데이터가 백업 시점으로 복원됨" },
    { label: "접수 감사 기록 복원", passed: comparableArchive(archiveBefore) === comparableArchive(archiveAfter),
      detail: "원본 및 정정 기록의 전체 내용 비교" },
    { label: "복원 후 리비전 증가", passed: typeof recovered.revision === "number" &&
      recovered.revision > revisionBeforeRestore && recovered.revision > (baseline.revision ?? -1),
      detail: "오래된 화면의 저장 충돌 방지" },
  ];
}
