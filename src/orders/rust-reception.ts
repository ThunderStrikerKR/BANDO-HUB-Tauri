import { resolvePrice } from "../domain";
import { matchingRecipient, rebindEvidence, type OrderEvidence } from "../order-evidence";
import { addressParts, mergeParsedItem } from "../parser";
import { recommendShipping } from "../shipping";
import type { Client, Order, Recipient, State } from "../types";

/** Exact result envelope returned by recognition::execute("analyze_order"). */
export interface RustReceptionAnalysis {
  recipients: Recipient[];
  candidates: OrderEvidence[];
  unassigned: string[];
}

function sourceSpanIsValid(
  raw: string,
  source: { start: number; end: number; text: string },
): boolean {
  return Number.isInteger(source.start) && Number.isInteger(source.end) &&
    source.start >= 0 && source.end >= source.start && source.end <= raw.length &&
    typeof source.text === "string" && raw.slice(source.start, source.end) === source.text;
}

/** Never apply a partial or malformed native response to an editable order. */
export function assertRustReceptionAnalysis(
  value: unknown,
  raw: string,
): asserts value is RustReceptionAnalysis {
  if (!value || typeof value !== "object") throw Error("Rust 발주 분석 결과가 없습니다.");
  const result = value as Partial<RustReceptionAnalysis>;
  if (!Array.isArray(result.recipients) ||
      !Array.isArray(result.candidates) ||
      !Array.isArray(result.unassigned))
    throw Error("Rust 발주 분석 결과의 배송건 또는 근거 형식이 올바르지 않습니다.");
  for (const candidate of result.candidates) {
    if (!candidate || typeof candidate.id !== "string" ||
        typeof candidate.kind !== "string" ||
        !sourceSpanIsValid(raw, candidate))
      throw Error("Rust 발주 분석의 원문 근거 위치가 일치하지 않습니다.");
  }
  for (const recipient of result.recipients) {
    if (!recipient || typeof recipient.id !== "string" ||
        !Array.isArray(recipient.items) ||
        !Array.isArray(recipient.sources) ||
        typeof recipient.name !== "string" ||
        typeof recipient.address !== "string")
      throw Error("Rust 발주 분석의 수취인 자료가 올바르지 않습니다.");
    for (const span of recipient.sources) {
      if (!sourceSpanIsValid(raw, span))
        throw Error("Rust 수취인 근거가 발주 원문과 일치하지 않습니다.");
    }
    for (const item of recipient.items) {
      if (!item || typeof item.id !== "string" ||
          typeof item.raw !== "string" ||
          typeof item.name !== "string" ||
          !Array.isArray(item.issues) ||
          !Array.isArray(item.sources) ||
          (item.quantity !== null &&
            (!Number.isSafeInteger(item.quantity) || item.quantity <= 0)) ||
          typeof item.quantityConfirmed !== "boolean" ||
          (item.productId !== null && typeof item.productId !== "string") ||
          (item.variantId !== null && typeof item.variantId !== "string"))
        throw Error("Rust 발주 분석의 상품 또는 수량 자료가 올바르지 않습니다.");
      for (const span of item.sources) {
        if (!sourceSpanIsValid(raw, span))
          throw Error("Rust 상품 근거가 발주 원문과 일치하지 않습니다.");
      }
    }
  }
}

export function receptionAnalysisAllowed(
  previous: Order,
  raw: string,
  clientId: string,
): boolean {
  if (previous.deletedAt || previous.confirmedAt || previous.manualClassification ||
      previous.pricesLocked || previous.status === "EXPORTED")
    return false;
  return previous.analysisRaw !== raw || previous.analysisClientId !== clientId;
}

/**
 * Preserve the established reception behavior AFTER Rust has recognized the
 * original document. This function does not parse products, people or addresses.
 * It keeps stable employee-owned IDs, explicit approvals and frozen evidence.
 */
export function applyRustReceptionAnalysis(
  previous: Order,
  evidence: RustReceptionAnalysis,
  options: {
    raw: string;
    state: State;
    pricingClient: Client;
    at: string;
  },
): Order {
  const { raw, state, pricingClient, at } = options;
  assertRustReceptionAnalysis(evidence, raw);
  if (!receptionAnalysisAllowed(previous, raw, pricingClient.id)) return previous;

  // Native results are re-bound to existing employee-owned entities below.
  // Do not mutate the native response or the currently displayed draft.
  const parsed = structuredClone(evidence.recipients);
  const candidates = structuredClone(evidence.candidates);
  const originalParsed = structuredClone(parsed);
  const usedRecipients = new Set<string>();

  for (const recipient of parsed) {
    const prior = matchingRecipient(recipient, previous.recipients, usedRecipients, parsed);
    if (!prior) continue;
    usedRecipients.add(prior.id);
    const provisionalId = recipient.id;
    rebindEvidence(candidates, "recipientId", provisionalId, prior.id);
    recipient.id = prior.id;
    for (const span of recipient.sources ?? []) {
      span.targetId = prior.id;
      span.recipientId = prior.id;
    }

    for (const field of prior.confirmedFields ?? []) {
      if (["name", "address", "phone", "mobile", "note"].includes(field)) {
        (recipient as unknown as Record<string, unknown>)[field] =
          (prior as unknown as Record<string, unknown>)[field];
      }
    }
    recipient.confirmedFields = prior.confirmedFields;
    recipient.dispatchOrigin = prior.dispatchOrigin;
    recipient.actualFreight = prior.actualFreight;
    recipient.freightCode = prior.freightCode;
    recipient.vatDefault = prior.vatDefault;
    recipient.vatOverride = prior.vatOverride;
    recipient.shippingCharges = prior.shippingCharges;
    if (prior.confirmedFields?.includes("address")) {
      recipient.addressStatus = prior.addressStatus;
      recipient.addressParts = prior.addressParts ?? addressParts(prior.address);
    }

    const usedItems = new Set<string>();
    for (const item of recipient.items) {
      const priorItem = prior.items.find((candidate) =>
        candidate.raw === item.raw && !usedItems.has(candidate.id));
      if (priorItem) {
        usedItems.add(priorItem.id);
        rebindEvidence(candidates, "itemId", item.id, priorItem.id);
        item.id = priorItem.id;
        Object.assign(item, mergeParsedItem(item, priorItem));
        const product = state.products.find((p) => p.id === item.productId);
        if (product && item.variantId)
          item.unitPrice = resolvePrice(product, item.variantId, pricingClient);
      }
      // Even newly recognized items must reference the retained recipient,
      // not Rust's provisional recipient ID.
      for (const span of item.sources ?? []) {
        span.targetId = item.id;
        span.recipientId = recipient.id;
      }
    }
  }

  if (previous.orderType) {
    for (const recipient of parsed) {
      recipient.dispatchOrigin ??= "FACTORY";
      for (const item of recipient.items) item.origin = recipient.dispatchOrigin;
    }
  }
  const next: Order = {
    ...previous,
    analysisEvidence: candidates,
    analysisSnapshot: previous.analysisSnapshot?.raw === raw
      ? previous.analysisSnapshot
      : {
        at,
        raw,
        ruleVersion: "rust-recognition-v1",
        recipients: originalParsed,
      },
    raw,
    analysisRaw: raw,
    analysisClientId: pricingClient.id,
    recipients: parsed,
    pricesLocked: false,
    notified: false,
    paid: false,
    postpaidApproved: false,
    status: "REVIEW",
  };
  const freight = recommendShipping(next, state);
  next.shippingFee = pricingClient.shippingFeeExcluded ? 0 : freight.total;
  next.shippingMode = "AUTO";
  next.shippingVersion = freight.version;
  return next;
}
