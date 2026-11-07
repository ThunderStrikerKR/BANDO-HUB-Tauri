import { unassignedClient } from "../domain.js";
import { newReception } from "../orders/reception.js";
import { parseEvidence } from "../parser.js";
import { orderIssues } from "../validation.js";
import type { Client, DeveloperTestReport, State } from "../types.js";

export type CaseId =
  | "normal" | "missing-name" | "missing-address" | "missing-contact"
  | "invalid-contact" | "unknown-model" | "missing-quantity"
  | "multiple-recipients" | "duplicate-order" | "custom";

export const developerCases: { id: CaseId; label: string; detail: string }[] = [
  { id: "normal", label: "기본 발주", detail: "정상 원문에서 검토 이슈가 남는지 검사" },
  { id: "missing-name", label: "수취인 누락", detail: "수취인명 확인 이슈가 나타나야 함" },
  { id: "missing-address", label: "주소 누락", detail: "주소 확인 이슈가 나타나야 함" },
  { id: "missing-contact", label: "연락처 누락", detail: "연락처 확인 이슈가 나타나야 함" },
  { id: "invalid-contact", label: "잘못된 연락처", detail: "전화번호 형식이 잘못되면 검토 대상으로 분류" },
  { id: "unknown-model", label: "미등록 상품", detail: "모델 인식 실패 또는 상품 누락을 검출" },
  { id: "missing-quantity", label: "수량 미확정", detail: "수량이 확정되지 않았는지 검사" },
  { id: "multiple-recipients", label: "복수 수취인", detail: "2명 이상의 배송 건으로 분리되는지 검사" },
  { id: "duplicate-order", label: "동일 원문 중복", detail: "현재 격리 DB에 같은 원문이 이미 있는지 확인" },
  { id: "custom", label: "직접 입력", detail: "예상 오류 분류를 선택하고 실제 원문을 시험" },
];
const fakeClient: Client = {
  ...unassignedClient,
  id: "test-simulated-dealer",
  name: "[가상] 검증악기",
  address: "서울특별시 강남구 테헤란로 123",
  phone: "02-0000-0000",
  mobile: "",
};

function sampleModel(state: State) {
  const selected = state.products.find((product) =>
    !product.deletedAt && product.active !== false &&
    /(?:BD\s*)?\d{3}/i.test(product.code) && product.variants.length > 0);
  return selected?.code || "709";
}
export function exampleRaw(id: CaseId, state: State): string {
  const model = sampleModel(state);
  const item = model + " 블랙 3개";
  const who = "김민수";
  const address = "서울특별시 강남구 테헤란로 123";
  const contact = "010-1234-5678";
  const whole = [item, who, address, contact].join("\n");
  switch (id) {
    case "normal": return whole;
    case "missing-name": return [item, address, contact].join("\n");
    case "missing-address": return [item, who, contact].join("\n");
    case "missing-contact": return [item, who, address].join("\n");
    case "invalid-contact": return [item, who, address, "010-12"].join("\n");
    case "unknown-model": return ["BD 99999 2개", who, address, contact].join("\n");
    case "missing-quantity": return [model + " 블랙", who, address, contact].join("\n");
    case "multiple-recipients":
      return [item, who, address, contact, "", model + " 블랙 1개",
        "이영희", "부산광역시 해운대구 센텀중앙로 48", "010-9999-8888"].join("\n");
    case "duplicate-order": return whole;
    case "custom": return whole;
  }
}
const expectedKinds: Partial<Record<CaseId, string[]>> = {
  "missing-name": ["NAME"],
  "missing-address": ["ADDRESS"],
  "missing-contact": ["CONTACT"],
  "invalid-contact": ["CONTACT"],
  "missing-quantity": ["QUANTITY_MISSING"],
  "unknown-model": ["MODEL", "ITEM", "MODEL_CHOICE"],
};
export const expectedOptions = [
  { value: "NONE", label: "검토 오류 없음" },
  { value: "NAME", label: "수취인명 확인" },
  { value: "ADDRESS", label: "배송주소 확인" },
  { value: "CONTACT", label: "연락처 확인" },
  { value: "MODEL", label: "미등록 상품" },
  { value: "ITEM", label: "상품 누락" },
  { value: "QUANTITY_MISSING", label: "수량 미확정" },
  { value: "ALIAS_CONFLICT", label: "별칭 충돌" },
  { value: "CANDIDATE_name", label: "수취인 후보 충돌" },
];

export function inspectOrder(
  state: State, id: CaseId, raw: string, clientId = "", customExpected = "NONE",
): DeveloperTestReport {
  if (!raw.trim() || raw.length > 20000) {
    throw Error("발주서 원문은 1자 이상, 20,000자 이내로 입력하세요.");
  }
  const source = structuredClone(state);
  const client = source.clients.find((entry) => entry.id === clientId) ?? fakeClient;
  // Same evidence parser and validation functions as reception UI. No shipment,
  // payment, export, or state_save is invoked in this read-only diagnostic.
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
  const issues = orderIssues(order).filter((issue) => issue.severity === "ACTION");
  const detected = [...new Set(issues.map((issue) => issue.kind))];
  const notes = issues.map((issue) => issue.title + ": " + issue.detail).slice(0, 60);
  if (parsed.unassigned?.length) {
    notes.push("원문의 미귀속 정보가 있습니다. 배송 건 연결을 확인하세요.");
  }
  const expected = id === "custom"
    ? customExpected === "NONE" ? [] : [customExpected]
    : expectedKinds[id] ?? [];
  const duplicates = source.orders.some((existing) =>
    !existing.deletedAt && existing.raw.trim() === raw.trim());
  let passed: boolean;
  if (id === "normal" || (id === "custom" && customExpected === "NONE")) {
    passed = detected.length === 0;
  } else if (id === "unknown-model") {
    passed = expected.some((kind) => detected.includes(kind));
  } else if (id === "multiple-recipients") {
    passed = parsed.recipients.length >= 2;
  } else if (id === "duplicate-order") {
    passed = duplicates;
    notes.unshift(duplicates ? "동일 원문 주문이 격리 DB에 있습니다." :
      "동일 원문 주문이 격리 DB에 없습니다. 먼저 시험 주문을 등록하세요.");
  } else {
    passed = expected.every((kind) => detected.includes(kind));
  }
  const label = developerCases.find((item) => item.id === id)?.label ?? id;
  return {
    scenario: label,
    raw, passed, expected: id === "multiple-recipients" ? ["RECIPIENTS>=2"] :
      id === "duplicate-order" ? ["DUPLICATE_RAW"] : expected,
    detected: [
      ...detected,
      ...(parsed.recipients.length >= 2 ? ["RECIPIENTS>=2"] : []),
      ...(duplicates ? ["DUPLICATE_RAW"] : []),
    ],
    recipients: parsed.recipients.map((r) => ({
      name: r.name, address: r.address, contact: r.mobile || r.phone,
      items: r.items.map((item) =>
        (item.name || item.raw) + ": " + item.quantity + "개 (" +
        (item.productId ? "상품 연결" : "미확인") + ")"),
    })),
    notes,
  };
}
