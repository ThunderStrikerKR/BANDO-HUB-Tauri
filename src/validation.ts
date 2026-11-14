import { contactProblem, validContact } from "./contact.js";
import { deliveryRequirements } from "./delivery-requirements.js";
import { internalModel } from "./matching.js";
import type { IssueResolution, Item, Order, Recipient, ValidationIssue } from "./types.js";
export const issueId = (o: Order, r: Recipient | undefined, kind: string, item?: Item) =>
  ["issue", o.id, r?.id ?? "order", item?.id ?? "recipient", kind].join(":");

// These are unassigned *recognition candidates*, not confirmed products or
// quantities. Show the original text, rather than guessing which shipment owns it.
export function unassignedEvidenceDetail(recipient: Recipient): string {
  const candidates = recipient.unassignedEvidence ?? [];
  const fragments = candidates.slice(0, 4).map((candidate) => {
    const source = (candidate.text || candidate.value).replace(/\s+/g, " ").trim();
    const short = source.length > 60 ? source.slice(0, 60) + "…" : source;
    return (candidate.kind === "quantity" ? "수량" : "상품") + ': "' + short + '"';
  });
  const more = candidates.length > 4 ? " 외 " + (candidates.length - 4) + "개" : "";
  return "연결되지 않은 원문: " + (fragments.join(" / ") || "확인할 문구 없음") + more;
}
export function orderIssues(o: Order): ValidationIssue[] {
  const result: ValidationIssue[] = [];
  const add = (
    r: Recipient | undefined,
    kind: string,
    title: string,
    field: string,
    value: unknown,
    i?: Item,
    stage = 1,
    customer?: string,
    resolution?: IssueResolution,
  ) => {
    const id = issueId(o, r, kind, i),
      evidence = JSON.stringify(value),
      decision = o.issueResolutions?.[id],
      status =
        resolution ??
        (kind === "QUANTITY_MISSING" &&
        i?.quantityApproval?.quantity === 1 &&
        i.quantity === 1 &&
        i.quantityConfirmed === false &&
        !!i.productId && !!i.variantId
          ? "PROVISIONALLY_APPROVED"
          : decision?.evidence === evidence && decision.resolution === "PENDING_CUSTOMER"
            ? "PENDING_CUSTOMER"
            : "UNRESOLVED");
    result.push({
      evidence,
      issueId: id,
      orderId: o.id,
      groupId: "group:" + o.id,
      recipientId: r?.id ?? "",
      itemId: i?.id,
      kind,
      title,
      detail:
        kind === "UNASSIGNED_EVIDENCE" && r
          ? unassignedEvidenceDetail(r)
          : r
            ? (r.name || "수취인") + " / " + (i ? internalModel(i.name) : title)
            : title,
      sourceSpan: (i?.sources ?? r?.sources)?.find((s) => s.field === field),
      blockingStage: stage,
      severity: ["AUTO_APPLIED", "PROVISIONALLY_APPROVED", "RESOLVED"].includes(status)
        ? "INFO"
        : "ACTION",
      resolution: status,
      resolutionSource:
        decision?.resolutionSource ??
        (status === "AUTO_APPLIED"
          ? "코어"
          : status === "PROVISIONALLY_APPROVED"
            ? (i?.quantityApproval?.actor ?? "직원")
            : "미확인"),
      updatedAt: decision?.updatedAt ?? i?.quantityApproval?.at ?? o.updatedAt,
      linkKey: r ? (i?.id ?? r.id) + ":" + field : undefined,
      customer,
    });
  };
  if (!o.clientId && o.orderType !== "RETAIL")
    add(undefined, "CLIENT", "거래처를 선택하면 단가가 적용됩니다", "client", o.clientId);
  if (!o.recipients.length)
    add(undefined, "RECIPIENT", "수취인과 상품을 추가하세요", "recipient", 0);
  for (const r of o.recipients) {
    const required = deliveryRequirements(r, o.receptionVersion !== 1);
    if (r.unassignedEvidence?.length)
      add(
        r,
        "UNASSIGNED_EVIDENCE",
        "상품 또는 수량 정보가 연결되지 않았습니다",
        "product",
        r.unassignedEvidence,
      );
    const who = (r.name || "수취인") + "님";
    if (!r.name.trim())
      add(
        r,
        "NAME",
        "수취인 이름을 확인하세요",
        "name",
        r.name,
        undefined,
        1,
        "받으실 분의 성함을 알려주세요.",
      );
    if (!required.address)
      add(
        r,
        "ADDRESS",
        "상세 배송주소가 부족합니다",
        "address",
        [r.address, r.addressStatus],
        undefined,
        1,
        who + (r.address.trim() ? " 상세주소 확인 부탁드려요." : " 배송지 주소 확인 부탁드려요."),
      );
    if (!r.phone && !r.mobile)
      add(
        r,
        "CONTACT",
        "연락처가 없습니다",
        "mobile",
        [r.phone, r.mobile],
        undefined,
        1,
        who + " 연락처 확인 부탁드려요.",
      );
    else if (!required.contact)
      add(
        r,
        "CONTACT",
        contactProblem(
          r.mobile && !validContact(r.mobile) ? r.mobile : r.phone,
          !!r.mobile && !validContact(r.mobile),
        ),
        r.mobile && !validContact(r.mobile) ? "mobile" : "phone",
        [r.phone, r.mobile],
        undefined,
        1,
        who + " 연락처 확인 부탁드려요.",
      );
    for (const field of ["name", "address", "phone", "mobile"])
      if (
        new Set(r.candidates?.filter((c) => c.field === field).map((c) => c.value)).size > 1 &&
        !r.confirmedFields?.includes(field)
      )
        add(
          r,
          "CANDIDATE_" + field,
          (field === "name" ? "수취인명" : field === "address" ? "주소" : "연락처") +
            " 후보 선택 필요",
          field,
          r.candidates?.filter((c) => c.field === field),
        );
    if (!r.items.length) add(r, "ITEM", "상품명 누락", "product", []);
    for (const i of r.items) {
      const root =
        i.match?.kind === "QUANTITY"
          ? "QUANTITY_LINK"
          : i.match?.kind === "CONFLICT"
            ? "ALIAS_CONFLICT"
            : i.match?.kind === "CATEGORY_CONFLICT"
              ? "CATEGORY_CONFLICT"
              : i.match?.kind === "CATEGORY"
                ? "MODEL_CHOICE"
                : "MODEL";
      if (!i.productId || !i.variantId)
        add(
          r,
          root,
          {
            QUANTITY_LINK: "수량을 연결할 상품이 불명확합니다.",
            ALIAS_CONFLICT: "상품 연결 정보가 충돌합니다.",
            CATEGORY_CONFLICT: "상품 종류와 모델이 상충합니다.",
            MODEL_CHOICE: "모델 선택이 필요합니다.",
            MODEL: "미등록 상품입니다.",
          }[root],
          "product",
          [i.productId, i.variantId, i.match],
          i,
        );
      if (i.quantityConfirmed === false && root !== "QUANTITY_LINK") {
        add(
          r,
          "QUANTITY_MISSING",
          "상품에 귀속된 수량을 확정하세요.",
          "quantity",
          [i.quantity, i.quantityConfirmed],
          i,
          1,
          undefined,
          undefined,
        );
      }
      if (
        i.quantityConfirmed !== false &&
        (!Number.isSafeInteger(i.quantity) || (i.quantity ?? 0) < 1)
      )
        add(r, "QUANTITY_INVALID", "수량을 확인하세요", "quantity", i.quantity, i);
      if (
        o.orderType !== "RETAIL" &&
        o.clientId &&
        i.productId &&
        i.variantId &&
        (i.unitPrice === null || !Number.isSafeInteger(i.unitPrice) || i.unitPrice < 0)
      )
        add(r, "PRICE", "판매가를 등록하세요", "price", i.unitPrice, i);
      if (i.productId && i.variantId && i.issues.some((x) => /색상|옵션/.test(x)))
        add(
          r,
          "OPTION",
          "정확한 상품 구성을 확인하세요",
          "product",
          [i.variantId, i.color, i.issues],
          i,
          1,
          who + " " + internalModel(i.name) + " 정확한 상품명을 확인 부탁드려요.",
        );
      if (i.modelProposal?.required)
        add(
          r,
          "MODEL_CONFIRM",
          "추천 상품의 고객 확인이 필요합니다",
          "product",
          [i.productId, i.variantId, i.modelProposal],
          i,
          1,
          undefined,
          "PENDING_CUSTOMER",
        );
      if (
        i.match &&
        ["COMMON_INHERIT", "CLIENT_ALIAS", "COMMON_ALIAS"].includes(i.match.kind) &&
        i.productId &&
        i.variantId
      )
        add(
          r,
          "APPLIED",
          i.match.kind === "COMMON_INHERIT"
            ? "공통 상품 자동 적용"
            : i.match.kind === "CLIENT_ALIAS"
              ? "거래처 별칭 적용"
              : "공통 별칭 적용",
          "product",
          i.match,
          i,
          0,
          undefined,
          "AUTO_APPLIED",
        );
    }
  }
  return result;
}
export const blocking = (issue: ValidationIssue, stage = 4) =>
  issue.severity === "ACTION" && issue.blockingStage <= stage;
export function approveMissingQuantity(o: Order, rid: string, iid: string, actor: string) {
  const next = structuredClone(o),
    i = next.recipients.find((r) => r.id === rid)?.items.find((i) => i.id === iid);
  if (
    !i ||
    !i.productId ||
    !i.variantId ||
    i.quantityConfirmed !== false ||
    i.match?.kind === "QUANTITY" ||
    i.issues.some((x) => /여러|불명확/.test(x))
  )
    throw Error("수량 미기재로 확인된 실제 상품만 1개 잠정 처리할 수 있습니다.");
  i.quantity = 1;
  i.quantityApproval = { at: new Date().toISOString(), actor, quantity: 1 };
  i.manuallyConfirmed = true;
  return next;
}
export function pendingIssue(o: Order, id: string, actor: string) {
  const next = structuredClone(o),
    issue = orderIssues(o).find((i) => i.issueId === id);
  if (!issue || issue.severity !== "ACTION") return next;
  const evidence = issue.evidence ?? "";
  next.issueResolutions = {
    ...next.issueResolutions,
    [id]: {
      resolution: "PENDING_CUSTOMER",
      resolutionSource: actor,
      updatedAt: new Date().toISOString(),
      evidence,
    },
  };
  return next;
}
/** Extend the same result set with operational blockers supplied by workflow calculations. */
export function operationalIssue(
  o: Order,
  r: Recipient | undefined,
  groupId: string,
  kind: string,
  title: string,
  stage: number,
  field: string,
): ValidationIssue {
  return {
    issueId: issueId(o, r, kind) + (r ? "" : ":" + groupId),
    orderId: o.id,
    groupId,
    recipientId: r?.id ?? "",
    kind,
    title,
    detail: r ? (r.name || "수취인") + " / " + title : title,
    blockingStage: stage,
    severity: "ACTION",
    resolution: "UNRESOLVED",
    resolutionSource: "업무 검증",
    updatedAt: o.updatedAt,
    linkKey: r ? r.id + ":" + field : undefined,
  };
}

export function synchronizeIssueDecisions(order: Order) {
  const result = orderIssues(order),
    old = order.issueResolutions ?? {},
    next = { ...old },
    present = new Set(result.map((i) => i.issueId));
  for (const issue of result) {
    const previous = old[issue.issueId],
      evidence = issue.evidence ?? issue.title;
    next[issue.issueId] = {
      resolution: issue.resolution,
      resolutionSource: issue.resolutionSource,
      updatedAt:
        previous?.resolution === issue.resolution && previous.evidence === evidence
          ? previous.updatedAt
          : order.updatedAt,
      evidence,
    };
  }
  for (const [id, previous] of Object.entries(old))
    if (
      !present.has(id) &&
      ["PENDING_CUSTOMER", "UNRESOLVED", "PROVISIONALLY_APPROVED", "AUTO_APPLIED"].includes(
        previous.resolution,
      )
    )
      next[id] = {
        ...previous,
        resolution: "RESOLVED",
        resolutionSource: "직원 수정 또는 현재 원문 반영",
        updatedAt: order.updatedAt,
      };
  order.issueResolutions = next;
  return order;
}
