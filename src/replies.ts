import { normalizeColor, orderClient, resolvePrice, totals, uid } from "./domain.js";
import { addressInfo, addressParts, parseSmart, quantities } from "./parser.js";
import { colorLabel, registeredProducts } from "./product-models.js";
import { productModelNames, registeredNameCandidates } from "./product-name-match.js";
import { recommendShipping } from "./shipping.js";
import type { BillingSnapshot, Item, Order, ReplyChange, ReplyPreview, State } from "./types.js";
export function billingSnapshot(o: Order, state: State, reason: string): BillingSnapshot {
  const c = orderClient(o, state);
  if (!c) throw Error("거래처 기록이 없습니다.");
  return {
    at: new Date().toISOString(),
    reason,
    recipients: structuredClone(o.recipients),
    shippingFee: o.shippingFee,
    vatAmount: o.vatAmount,
    applyVat: o.applyVat,
    total: totals(o, c).total,
    status: o.status,
    paid: o.paid,
    notified: o.notified,
    postpaidApproved: o.postpaidApproved,
    client: structuredClone(c),
  };
}
export function proposeReply(
  order: Order,
  raw: string,
  state: State,
  selectedIds: string[] = [],
): ReplyPreview {
  const changes: ReplyChange[] = [],
    warnings: string[] = [];
  const client =
    state.clients.find((c) => c.id === order.clientId && !c.deletedAt) ?? order.clientSnapshot;
  if (!client)
    return {
      raw,
      changes,
      warnings: ["거래처 기록을 확인하세요."],
      requiresReapproval: false,
    };
  if (!raw.trim())
    return {
      raw,
      changes,
      warnings: ["회신 내용을 붙여넣으세요."],
      requiresReapproval: false,
    };
  const recipientChanges: NonNullable<ReplyPreview["recipientChanges"]> = [];
  const parsedRecipients = parseSmart(raw, client, state);
  for (const parsed of parsedRecipients) {
    const target =
      order.recipients.find((r) => r.name && r.name === parsed.name) ??
      (order.recipients.length === 1 ? order.recipients[0] : undefined);
    if (!target) {
      if (parsed.address || parsed.phone || parsed.mobile)
        warnings.push("배송정보를 변경할 수취인을 선택하세요.");
      continue;
    }
    const before = {
        name: target.name,
        address: target.address,
        phone: target.phone,
        mobile: target.mobile,
        note: target.note,
      },
      after = { ...before };
    for (const key of ["name", "address", "phone", "mobile", "note"] as const)
      if (
        parsed[key] &&
        (key !== "name" || /(?:^|\n)\s*(?:수취인(?:명)?|수하인(?:명)?|성함|이름)\s*[:：]/.test(raw))
      )
        after[key] = parsed[key];
    if (JSON.stringify(before) !== JSON.stringify(after))
      recipientChanges.push({ recipientId: target.id, before, after });
  }
  const chars = raw.split("");
  for (const parsed of parsedRecipients)
    for (const span of parsed.sources ?? [])
      if (
        span.field !== "name" ||
        parsed.address ||
        parsed.phone ||
        parsed.mobile ||
        order.recipients.some((r) => r.name === parsed.name)
      )
        chars.fill(" ", span.start, span.end);
  const itemRaw = chars.join("");
  const qty = quantities(itemRaw);
  if (qty.length > 1)
    return {
      raw,
      changes,
      warnings: ["여러 수량이 있습니다. 품목별로 나누어 확인하세요."],
      requiresReapproval: true,
    };
  const quantity = qty[0]?.value;
  if (quantity !== undefined && quantity < 1) warnings.push("수량은 1 이상이어야 합니다.");
  let candidates = registeredNameCandidates(registeredProducts(state.products), itemRaw);
  if (
    /핑크|pink|노랑|노란|yellow|옐로우|초록|녹색|green|베이지|beige|보라|purple|퍼플|주황|orange/i.test(
      itemRaw,
    )
  )
    warnings.push("회신에 자동 해석을 지원하지 않는 색상이 있습니다. 등록 옵션을 직접 확인하세요.");
  const modelTokens = itemRaw.match(/(?:BD\s*)?\d{3}[A-Za-z0-9-]*/gi) ?? [];
  if (
    modelTokens.some(
      (token) =>
        !registeredProducts(state.products).some(
          (p) => productModelNames(p).some(name =>
            name.toUpperCase().replace(/^BD\s*/, "").replace(/\s/g,"") ===
              token.toUpperCase().replace(/^BD\s*/, "").replace(/\s/g,"")),
        ),
    )
  )
    warnings.push("등록되지 않은 모델 표현이 있습니다. 정확한 모델을 확인하세요.");
  const colorWords = [
    "블랙",
    "검정",
    "black",
    "그레이",
    "회색",
    "gray",
    "grey",
    "브라운",
    "brown",
    "화이트",
    "흰색",
    "white",
    "클리어",
    "clear",
    "프로스트",
    "frost",
    "실버",
    "silver",
    "블루",
    "blue",
    "레드",
    "red",
  ];
  const colors = [
    ...new Set(
      colorWords
        .filter((word) => itemRaw.toLowerCase().includes(word))
        .map((word) => normalizeColor(word)),
    ),
  ];
  if (colors.length > 1) warnings.push("여러 색상이 있습니다. 품목별로 회신을 나누어 확인하세요.");
  const color = colors.length === 1 ? colors[0] : undefined;
  if (color)
    candidates = candidates.filter((p) =>
      p.variants.some((v) => normalizeColor(v.color) === color),
    );
  const all = order.recipients.flatMap((r) => r.items.map((i) => ({ recipient: r, item: i })));
  let targets = selectedIds.length
    ? all.filter((x) => selectedIds.includes(x.item.id))
    : all.length === 1
      ? all
      : all.filter((x) => candidates.some((p) => p.id === x.item.productId));
  if (!targets.length && !recipientChanges.length) warnings.push("변경할 주문 품목을 선택하세요.");
  if (!color && quantity === undefined && !candidates.length && !recipientChanges.length)
    warnings.push("모델 / 색상 / 수량 변경 내용을 확인할 수 없습니다.");
  for (const { recipient, item } of color ||
  quantity !== undefined ||
  (candidates.length && !recipientChanges.length)
    ? targets
    : []) {
    const original = state.products.find((p) => p.id === item.productId);
    if (!original) {
      warnings.push(item.name + ": 등록 모델 확인 필요");
      continue;
    }
    let product = original;
    if (candidates.length === 1) {
      const selected = candidates[0];

      product = selected;
    } else if (candidates.length > 1) {
      warnings.push("모델 후보가 여러 개입니다. 정확한 모델을 확인하세요.");
      continue;
    }
    if (color && product.saleUnit) {
      const same = registeredProducts(state.products).filter(
        (p) =>
          p.familyKey === original.familyKey &&
          p.variants.some((v) => normalizeColor(v.color) === color),
      );
      if (same.length === 1) product = same[0];
    }
    const chosen = color
      ? product.variants.filter((v) => normalizeColor(v.color) === color)
      : product.id === original.id
        ? product.variants.filter((v) => v.id === item.variantId)
        : product.variants.filter((v) => v.color === product.defaultColor);
    if (chosen.length !== 1) {
      warnings.push(item.name + ": 지원하는 색상 / 옵션을 정확하게 선택하세요.");
      continue;
    }
    const v = chosen[0];
    const after: Item = {
      ...structuredClone(item),
      productId: product.id,
      variantId: v.id,
      name: product.name,
      color: v.color,
      unitPrice: resolvePrice(product, v.id, client),
      origin: product.origin,
      quantity: quantity ?? item.quantity,
      quantityConfirmed: quantity !== undefined ? true : item.quantityConfirmed,
      defaulted: false,
      issues: [],
      url: v.url,
      catalog: product.catalog,
    };
    if (JSON.stringify(after) !== JSON.stringify(item))
      changes.push({
        recipientId: recipient.id,
        itemId: item.id,
        before: structuredClone(item),
        after,
      });
  }
  if (order.status === "EXPORTED")
    warnings.push("이미 공장에 전달한 주문입니다. 출고 취소 / 회수 확인 없이 변경할 수 없습니다.");
  return {
    raw,
    changes,
    recipientChanges,
    warnings: [...new Set(warnings)],
    requiresReapproval:
      state.workflow?.shipments.some((s) => s.orderId === order.id && s.step >= 3) ||
      order.notified ||
      order.paid ||
      order.postpaidApproved ||
      order.status === "QUEUED",
  };
}
export function applyReply(
  order: Order,
  preview: ReplyPreview,
  state: State,
  acknowledged = false,
): Order {
  if (preview.warnings.length) throw Error(preview.warnings.join("\n"));
  if (!preview.changes.length && !preview.recipientChanges?.length)
    throw Error("적용할 변경사항이 없습니다.");
  if (order.status === "EXPORTED")
    throw Error("공장 전달 완료 주문은 회신으로 변경할 수 없습니다.");
  if (preview.requiresReapproval && !acknowledged)
    throw Error("기존 안내 / 입금 / 출고 승인의 재확인을 승인해 주세요.");
  const next = structuredClone(order);
  next.billingHistory = [
    ...(next.billingHistory ?? []),
    billingSnapshot(order, state, "회신 반영 전"),
  ];
  for (const change of preview.changes) {
    const item = next.recipients
      .find((r) => r.id === change.recipientId)
      ?.items.find((i) => i.id === change.itemId);
    if (!item || JSON.stringify(item) !== JSON.stringify(change.before))
      throw Error("주문이 변경되었습니다. 회신 내용을 다시 비교하세요.");
    Object.assign(item, structuredClone(change.after));
  }
  for (const change of preview.recipientChanges ?? []) {
    const r = next.recipients.find((r) => r.id === change.recipientId);
    if (
      !r ||
      Object.entries(change.before).some(
        ([k, v]) => (r as unknown as Record<string, unknown>)[k] !== v,
      )
    )
      throw Error("수취정보가 변경되었습니다. 다시 비교하세요.");
    Object.assign(r, change.after);
    r.confirmedFields = [
      ...new Set([
        ...(r.confirmedFields ?? []),
        ...Object.keys(change.after).filter(
          (k) =>
            (change.before as unknown as Record<string, unknown>)[k] !==
            (change.after as unknown as Record<string, unknown>)[k],
        ),
      ]),
    ];
    if (change.before.address !== change.after.address) {
      const info = addressInfo(r.address);
      r.addressKind = info.kind;
      r.addressParts = addressParts(r.address);
      r.addressStatus = info.complete ? "COMPLETE" : "INCOMPLETE";
    }
  }
  next.replies = [
    ...(next.replies ?? []),
    {
      id: uid(),
      at: new Date().toISOString(),
      raw: preview.raw,
      changes: structuredClone(preview.changes),
      recipientChanges: structuredClone(preview.recipientChanges),
    },
  ];
  next.pricesLocked = false;
  next.notified = false;
  next.paid = false;
  next.postpaidApproved = false;
  next.status = "REVIEW";
  next.shippingMode = "AUTO";
  next.updatedAt = new Date().toISOString();
  delete next.messageEdits;
  const recommendation = recommendShipping(next, state);
  next.shippingFee = recommendation.total;
  next.shippingVersion = recommendation.version;
  return next;
}
export function bulkColorPreview(
  order: Order,
  state: State,
  color: string,
  itemIds: string[],
): ReplyPreview {
  if (!itemIds.length)
    return {
      raw: "옵션 일괄 변경",
      changes: [],
      warnings: ["일괄 변경할 품목을 선택하세요."],
      requiresReapproval: false,
    };
  return proposeReply(order, colorLabel(color) + " 색상으로 변경", state, itemIds);
}
