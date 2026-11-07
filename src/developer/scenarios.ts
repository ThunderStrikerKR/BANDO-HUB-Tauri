import { itemFromProduct, unassignedClient } from "../domain.js";
import { newReception } from "../orders/reception.js";
import { parseEvidence } from "../parser.js";
import { orderIssues } from "../validation.js";
import type { Client, DeveloperTestReport, Item, Order, Recipient, State } from "../types.js";

export type CaseId =
  | "normal" | "missing-name" | "missing-address" | "missing-contact"
  | "invalid-contact" | "unknown-model" | "missing-quantity"
  | "multiple-recipients" | "duplicate-order" | "duplicate-db"
  | "no-client" | "no-recipient" | "quantity-invalid"
  | "price-missing" | "option-unconfirmed" | "alias-conflict"
  | "category-conflict" | "model-choice" | "quantity-link"
  | "candidate-name" | "candidate-address" | "candidate-phone"
  | "candidate-mobile" | "unassigned-evidence" | "model-confirm"
  | "custom";

type Mechanism = "원문 분석" | "구조화 검증" | "테스트 DB 조건" | "직접 입력";
type Case = { id: CaseId; label: string; detail: string; mechanism: Mechanism; batch?: boolean };
export const developerCases: Case[] = [
  { id: "normal", label: "정상 발주", detail: "정상 원문에서 검토 이슈가 남는지 검사", mechanism: "원문 분석" },
  { id: "missing-name", label: "수취인 누락", detail: "원문에서 수취인 이름 누락 감지", mechanism: "원문 분석" },
  { id: "missing-address", label: "주소 누락", detail: "원문에서 상세 주소 누락 감지", mechanism: "원문 분석" },
  { id: "missing-contact", label: "연락처 누락", detail: "원문에서 연락처 누락 감지", mechanism: "원문 분석" },
  { id: "invalid-contact", label: "잘못된 연락처", detail: "유효하지 않은 연락처 감지", mechanism: "원문 분석" },
  { id: "unknown-model", label: "미등록 상품", detail: "모델이 존재하지 않거나 옵션을 찾지 못한 경우", mechanism: "원문 분석" },
  { id: "missing-quantity", label: "수량 미확정", detail: "원문에서 수량 누락 감지", mechanism: "원문 분석" },
  { id: "multiple-recipients", label: "복수 수취인", detail: "수취인별 배송 건 분리 확인", mechanism: "원문 분석" },
  { id: "duplicate-order", label: "동일 원문 중복 모의 시험", detail: "메모리에 동일한 원문 주문을 넣어 중복 비교 로직 확인, DB에 저장하지 않음", mechanism: "구조화 검증" },
  { id: "duplicate-db", label: "테스트 DB의 실제 중복", detail: "격리 DB에 같은 원문 주문을 먼저 입력해야 통과, 기본 일괄 시험에서는 제외", mechanism: "테스트 DB 조건", batch: false },
  { id: "no-client", label: "거래처 미선택", detail: "거래처 없이 접수한 주문의 차단 검사", mechanism: "구조화 검증" },
  { id: "no-recipient", label: "배송 건 없음", detail: "빈 수취인 목록을 검증", mechanism: "구조화 검증" },
  { id: "quantity-invalid", label: "수량 0 또는 잘못된 값", detail: "상품 수량을 0으로 바꾼 뒤 실제 검증 함수 실행", mechanism: "구조화 검증" },
  { id: "price-missing", label: "단가 누락", detail: "연결된 상품의 거래처 판매 단가를 미확정으로 설정", mechanism: "구조화 검증" },
  { id: "option-unconfirmed", label: "색상 및 옵션 불확실", detail: "연결된 상품의 옵션 경고를 검증", mechanism: "구조화 검증" },
  { id: "alias-conflict", label: "별칭 충돌", detail: "상품 별칭 충돌을 구조화 검증 함수로 확인", mechanism: "구조화 검증" },
  { id: "category-conflict", label: "상품 종류 충돌", detail: "제품 종류와 모델 충돌 처리 확인", mechanism: "구조화 검증" },
  { id: "model-choice", label: "모델 선택 필요", detail: "모델 후보를 확정하지 않은 상태 검증", mechanism: "구조화 검증" },
  { id: "quantity-link", label: "수량과 품목 연결 오류", detail: "상품에 연결되지 않은 수량 검증", mechanism: "구조화 검증" },
  { id: "candidate-name", label: "수취인 후보 충돌", detail: "서로 다른 수취인명 후보를 판별", mechanism: "구조화 검증" },
  { id: "candidate-address", label: "주소 후보 충돌", detail: "서로 다른 주소 후보를 판별", mechanism: "구조화 검증" },
  { id: "candidate-phone", label: "전화번호 후보 충돌", detail: "서로 다른 일반전화 후보를 판별", mechanism: "구조화 검증" },
  { id: "candidate-mobile", label: "휴대전화 후보 충돌", detail: "서로 다른 휴대전화 후보를 판별", mechanism: "구조화 검증" },
  { id: "unassigned-evidence", label: "원문 귀속 불명확", detail: "배송 건에 귀속되지 못한 원문 정보 감지", mechanism: "구조화 검증" },
  { id: "model-confirm", label: "추천 모델 고객 확인", detail: "추천 모델의 고객 재확인 경고", mechanism: "구조화 검증" },
  { id: "custom", label: "직접 입력", detail: "원문, 거래처 및 기대 오류를 직접 선택해 실제 파서로 검사", mechanism: "직접 입력", batch: false },
];

const fakeClient: Client = {
  ...unassignedClient,
  id: "test-simulated-dealer",
  name: "[가상] 검증악기사",
  address: "서울특별시 강남구 테헤란로 123",
  phone: "02-0000-0000",
  mobile: "",
};

function sampleProduct(state: State) {
  const ready = state.products.filter((product) =>
    !product.deletedAt && product.active !== false && product.catalog !== "DEMO" &&
    product.variants.length > 0 && product.variants.every((v) => v.source !== "DEMO"));
  return ready.find((product) =>
    product.variants.length === 1 && /black|블랙|검정/i.test(product.defaultColor) &&
    product.variants[0].wholesale !== null && /(?:BD\s*)?\d{3}/i.test(product.code)) ??
    ready.find((product) => /(?:BD\s*)?\d{3}/i.test(product.code)) ?? ready[0];
}
export function exampleRaw(id: CaseId, state: State): string {
  const product = sampleProduct(state);
  const model = product?.code || "709";
  const color = product?.defaultColor === "단일" ? "" : product?.defaultColor || "블랙";
  const item = [model, color, "3개"].filter(Boolean).join(" ");
  const who = "김민수";
  const address = "서울특별시 강남구 테헤란로 123";
  const contact = "010-1234-5678";
  const whole = [item, who, address, contact].join("\n");
  switch (id) {
    case "missing-name": return [item, address, contact].join("\n");
    case "missing-address": return [item, who, contact].join("\n");
    case "missing-contact": return [item, who, address].join("\n");
    case "invalid-contact": return [item, who, address, "010-12"].join("\n");
    case "unknown-model": return ["BD 99999 2개", who, address, contact].join("\n");
    case "missing-quantity": return [[model, color].filter(Boolean).join(" "), who, address, contact].join("\n");
    case "multiple-recipients":
      return [item, who, address, contact, "", [model,color,"1개"].filter(Boolean).join(" "),
        "이영희", "부산광역시 해운대구 센텀중앙로 48", "010-9999-8888"].join("\n");
    default: return whole;
  }
}
const expectedKinds: Partial<Record<CaseId, string[]>> = {
  "missing-name": ["NAME"],
  "missing-address": ["ADDRESS"],
  "missing-contact": ["CONTACT"],
  "invalid-contact": ["CONTACT"],
  "missing-quantity": ["QUANTITY_MISSING"],
  "unknown-model": ["MODEL", "ITEM", "MODEL_CHOICE"],
  "no-client": ["CLIENT"],
  "no-recipient": ["RECIPIENT"],
  "quantity-invalid": ["QUANTITY_INVALID"],
  "price-missing": ["PRICE"],
  "option-unconfirmed": ["OPTION"],
  "alias-conflict": ["ALIAS_CONFLICT"],
  "category-conflict": ["CATEGORY_CONFLICT"],
  "model-choice": ["MODEL_CHOICE"],
  "quantity-link": ["QUANTITY_LINK"],
  "candidate-name": ["CANDIDATE_name"],
  "candidate-address": ["CANDIDATE_address"],
  "candidate-phone": ["CANDIDATE_phone"],
  "candidate-mobile": ["CANDIDATE_mobile"],
  "unassigned-evidence": ["UNASSIGNED_EVIDENCE"],
  "model-confirm": ["MODEL_CONFIRM"],
};
export const expectedOptions = [
  { value: "NONE", label: "검토 오류 없음" },
  ...[
    "CLIENT", "RECIPIENT", "NAME", "ADDRESS", "CONTACT",
    "CANDIDATE_name", "CANDIDATE_address", "CANDIDATE_phone", "CANDIDATE_mobile",
    "ITEM", "MODEL", "MODEL_CHOICE", "MODEL_CONFIRM",
    "ALIAS_CONFLICT", "CATEGORY_CONFLICT", "QUANTITY_LINK", "QUANTITY_MISSING",
    "QUANTITY_INVALID", "OPTION", "PRICE", "UNASSIGNED_EVIDENCE",
  ].map((kind) => ({ value: kind, label: kind })),
];

/** The same parser and issue evaluator used by reception, with no persistence. */
export function diagnosticOrder(state: State, raw: string, clientId = ""): Order {
  const source = structuredClone(state);
  const client = source.clients.find((entry) => entry.id === clientId) ?? fakeClient;
  const parsed = parseEvidence(raw, client, {
    ...source,
    products: source.products.filter((product) =>
      product.catalog !== "DEMO" && !product.variants.some((variant) => variant.source === "DEMO")),
  });
  const order = newReception(client.id);
  order.clientSnapshot = client;
  order.raw = raw;
  order.analysisRaw = raw;
  order.recipients = parsed.recipients;
  return order;
}

const structuredCases = new Set<CaseId>([
  "duplicate-order", "no-client", "no-recipient", "quantity-invalid",
  "price-missing", "option-unconfirmed", "alias-conflict", "category-conflict",
  "model-choice", "quantity-link", "candidate-name", "candidate-address",
  "candidate-phone", "candidate-mobile", "unassigned-evidence", "model-confirm",
]);
function adjustForScenario(order: Order, state: State, id: CaseId) {
  if (!structuredCases.has(id)) return;
  if (id === "no-client") { order.clientId = ""; return; }
  if (id === "no-recipient") { order.recipients = []; return; }
  if (id === "duplicate-order") return;
  const recipient = order.recipients[0];
  if (!recipient) throw Error("시험용 수취인이 없어 구조화된 오류를 재현할 수 없습니다.");
  if (id === "unassigned-evidence") {
    recipient.unassignedEvidence = [{ text: "미연결 원문" }] as unknown as NonNullable<Recipient["unassignedEvidence"]>;
    return;
  }
  if (id.startsWith("candidate-")) {
    const field = id.slice("candidate-".length);
    const values = field === "name" ? ["김민수", "이민수"] :
      field === "address" ? ["서울특별시 강남구 테헤란로 123", "부산광역시 해운대구 센텀중앙로 48"] :
      ["010-1111-2222", "010-3333-4444"];
    recipient.candidates = values.map((value, index) => ({
      id: "diagnostic-candidate-" + index, field, value, label: value, start: 0, end: 0,
    }));
    return;
  }
  const product = sampleProduct(state);
  if (!product) throw Error("구조화 검증에 사용할 기준 상품이 없습니다.");
  const variant = product.variants[0];
  let item = recipient.items[0];
  if (!item) {
    item = itemFromProduct(product, fakeClient, variant.color, 1);
    recipient.items.push(item);
  }
  // Structured cases deliberately change a copy of the parsed order. They do
  // NOT claim the source parser itself produced the selected exceptional state.
  item.productId = product.id;
  item.variantId = variant.id;
  item.quantity = 1;
  item.quantityConfirmed = true;
  item.issues = [];
  item.match = undefined;
  if (id === "quantity-invalid") item.quantity = 0;
  if (id === "price-missing") item.unitPrice = null;
  if (id === "option-unconfirmed") item.issues = ["색상 또는 옵션 확인 필요"];
  if (id === "model-confirm")
    item.modelProposal = { original: item.raw, required: true };
  const matched: Partial<Record<CaseId, NonNullable<Item["match"]>["kind"]>> = {
    "alias-conflict": "CONFLICT",
    "category-conflict": "CATEGORY_CONFLICT",
    "model-choice": "CATEGORY",
    "quantity-link": "QUANTITY",
  };
  if (matched[id]) {
    item.productId = null;
    item.variantId = null;
    item.match = { kind: matched[id]!, term: item.raw, productIds: [] };
  }
}

export function inspectOrder(
  state: State, id: CaseId, raw: string, clientId = "", customExpected = "NONE",
): DeveloperTestReport {
  if (!raw.trim() || raw.length > 20000)
    throw Error("발주서 원문은 1자 이상, 20,000자 이내로 입력하세요.");
  const source = structuredClone(state);
  const order = diagnosticOrder(source, raw, clientId);
  adjustForScenario(order, source, id);
  if (id === "duplicate-order") {
    const example = newReception(order.clientId);
    example.raw = raw;
    source.orders.push(example);
  }
  const issues = orderIssues(order).filter((issue) => issue.severity === "ACTION");
  const detected = [...new Set(issues.map((issue) => issue.kind))];
  const notes = issues.map((issue) => issue.title + ": " + issue.detail).slice(0, 60);
  const expected = id === "custom"
    ? customExpected === "NONE" ? [] : [customExpected]
    : expectedKinds[id] ?? [];
  const duplicates = source.orders.some((existing) =>
    !existing.deletedAt && existing.raw.trim() === raw.trim());
  if (duplicates && (id === "duplicate-order" || id === "duplicate-db"))
    detected.push("DUPLICATE_RAW");
  if (order.recipients.length >= 2) detected.push("RECIPIENTS>=2");
  const target = id === "multiple-recipients" ? ["RECIPIENTS>=2"] :
    (id === "duplicate-order" || id === "duplicate-db") ? ["DUPLICATE_RAW"] : expected;
  const passed = id === "normal" || (id === "custom" && customExpected === "NONE")
    ? detected.length === 0
    : id === "unknown-model"
      ? target.some((kind) => detected.includes(kind))
      : target.length > 0 && target.every((kind) => detected.includes(kind));
  if (id === "duplicate-order")
    notes.unshift("중복 주문은 현재 실행 중인 메모리에만 임시로 추가했습니다. 실제 DB 중복 검사가 아닙니다.");
  if (id === "duplicate-db")
    notes.unshift(duplicates ? "격리 DB에서 같은 원문 주문을 찾았습니다." :
      "격리 DB에 같은 원문 주문이 없습니다. 먼저 테스트 주문을 등록하세요.");
  if (structuredCases.has(id))
    notes.push("이 시나리오는 원문 파싱 후 복사된 주문의 검증 필드를 조작해 규칙을 검사합니다. 파서가 같은 입력을 자동 인식했다는 뜻이 아닙니다.");
  return {
    scenario: developerCases.find((item) => item.id === id)?.label ?? id,
    raw, passed, expected: target, detected: [...new Set(detected)],
    recipients: order.recipients.map((r) => ({
      name: r.name, address: r.address, contact: r.mobile || r.phone,
      items: r.items.map((item) =>
        (item.name || item.raw) + ": " + item.quantity + "개 (" +
        (item.productId ? "상품 연결" : "미확인") + ")"),
    })),
    notes,
  };
}
