import type {
  Item,
  Order,
  ShippingBundle,
  ShippingCombination,
  ShippingRule,
  ShippingState,
  State,
} from "./types.js";
const id = () => crypto.randomUUID();
export const activeGroups = (s: ShippingState) => s.groups.filter((g) => !g.deletedAt);
export function upgradeShipping(input: ShippingState) {
  const s = structuredClone(input);
  for (const [prefix, names] of [
    ["music", ["경량형", "표준형", "중량형"]],
    ["microphone", ["소형 포장", "중형 포장", "대형 포장"]],
  ] as const)
    for (const [i, name] of names.entries()) {
      const groupId = prefix + "-type-" + (i + 1);
      if (!s.groups.some((g) => g.id === groupId))
        s.groups.push({
          id: groupId,
          name: (prefix === "music" ? "일반 보면대" : "일반 마이크스탠드") + " / " + name,
          current: {
            ...emptyProductRule(),
            notes: "직원이 분류와 운임을 확인해 입력하세요.",
          },
          history: [],
        });
    }
  return s;
}
export function deleteShippingGroup(state: State, id: string, detach = false) {
  const next = structuredClone(state),
    g = next.shipping?.groups.find((g) => g.id === id && !g.deletedAt);
  if (!g) throw Error("현재 그룹이 없습니다.");
  const linked = next.products.filter(
    (p) => !p.deletedAt && !p.supersededBy && p.shippingGroupId === id,
  );
  if (linked.length && !detach)
    throw Error("사용 중인 상품: " + linked.map((p) => p.name).join(", "));
  for (const p of next.products) if (p.shippingGroupId === id) p.shippingGroupId = undefined;
  g.deletedAt = new Date().toISOString();
  for (const c of next.shipping!.combinations) if (c.versions["group:" + id]) c.active = false;
  return next;
}
const rule = (
  fees: Record<string, number | null>,
  notes = "",
  maxBundle: number | null = null,
  maxConfirmed = false,
  perItem: number | null = null,
): ShippingRule => ({
  version: id(),
  at: new Date().toISOString(),
  fees,
  maxBundle,
  maxConfirmed,
  perItem,
  notes,
});
export function initialShipping(): ShippingState {
  return {
    epoch: 1,
    productRules: {},
    productHistory: {},
    groups: [
      {
        id: "music",
        name: "일반 보면대",
        current: rule(
          { "1": 3000, "2": 4000, "3": null, "4": null, "5": null, "6": null },
          "최대 합포장 4개는 잠정값 / 직원 확인 필요",
          4,
          false,
        ),
        history: [],
      },
      {
        id: "microphone",
        name: "일반 마이크스탠드",
        current: rule(
          { "1": 3000, "2": 4000, "3": null, "4": null, "5": null, "6": null },
          "3~6개 운임 및 합포장 제한 확인 필요",
        ),
        history: [],
      },
      {
        id: "940",
        name: "940 계열",
        current: rule(
          { "1": null, "2": null, "3": null, "4": null, "5": null, "6": null },
          "1개 4,000원 및 합포장 제한 미확정 / 자동 추천하지 않음",
        ),
        history: [],
      },
      {
        id: "conductor",
        name: "지휘자 스탠드",
        current: rule({}, "확인된 기준: 개당 5,000원", 1, true, 5000),
        history: [],
      },
    ],
    combinations: [],
  };
}
const validAmount = (n: unknown): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
export function shippingBundles(o: Order, state: State): ShippingBundle[] {
  const shipping = state.shipping ?? initialShipping(),
    bundles: ShippingBundle[] = [];
  for (const r of o.recipients)
    for (const origin of ["STORE", "FACTORY"] as const) {
      const items = r.items.filter((i) => i.origin === origin);
      if (!items.length) continue;
      const grouped = new Map<string, number>();
      for (const i of items) {
        const key = (i.productId ?? "?") + "@" + (i.variantId ?? "?");
        grouped.set(key, (grouped.get(key) ?? 0) + (i.quantity ?? 0));
      }
      const key =
        origin +
        "|" +
        [...grouped]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, q]) => key + ":" + q)
          .join("|");
      const versions = combinationVersions(key, state);
      const byGroup = new Map<string, { items: Item[]; rule: ShippingRule; name: string }>();
      let unknown = false,
        expired = false;
      for (const i of items) {
        const p = state.products.find((p) => p.id === i.productId);
        if (!p) {
          unknown = true;
          continue;
        }
        const group = shipping.groups.find((g) => g.id === p.shippingGroupId && !g.deletedAt);
        const basis = group?.current ?? shipping.productRules?.[p.id];
        if (r.dispatchOrigin && p.origin !== origin) {
          unknown = true;
          continue;
        }
        if (!basis || !shippingRuleCurrent(basis)) {
          unknown = true;
          expired = !!basis;
          continue;
        }
        const effective = group ? "group:" + group.id : "product:" + p.id;
        versions[effective] = basis.version;
        versions["assignment:" + p.id] = group?.id ?? "individual";
        const previous = byGroup.get(effective);
        byGroup.set(effective, {
          items: [...(previous?.items ?? []), i],
          rule: basis,
          name: group?.name ?? p.name,
        });
      }
      const known = shipping.combinations
        .filter(
          (c) =>
            c.active &&
            c.key === key &&
            c.epoch === shipping.epoch &&
            Object.keys(c.versions).length === Object.keys(versions).length &&
            Object.entries(c.versions).every(([g, v]) => versions[g] === v),
        )
        .sort((a, b) => b.at.localeCompare(a.at))[0];
      let recommendation: number | null = null,
        reason = "",
        source: ShippingBundle["source"] = "MANUAL";
      if (
        items.some(
          (i) => !i.productId || !i.variantId || !i.quantity || !Number.isSafeInteger(i.quantity),
        )
      ) {
        reason = "상품/옵션/수량 확인 필요";
      } else if (known && !expired) {
        recommendation = known.charge;
        reason = "현재 기준의 확인된 동일 조합";
        source = "COMBINATION";
      } else if (unknown) {
        reason = "상품별 기본 운임 미등록 / 직원 확인 필요";
      } else {
        let sum = 0;
        let pending = false;
        for (const entry of byGroup.values()) {
          const groupItems = entry.items;
          const q = groupItems.reduce((s, i) => s + (i.quantity ?? 0), 0),
            r = entry.rule;
          if (groupItems.some((i) => !i.quantity || !Number.isInteger(i.quantity))) {
            pending = true;
            reason = "수량 확인 필요";
            break;
          }
          if (validAmount(r.perItem)) {
            sum += r.perItem * q;
            continue;
          }
          if (r.maxConfirmed && r.maxBundle === 1) {
            const single = r.fees["1"];
            if (!validAmount(single)) {
              pending = true;
              reason = entry.name + " 1개 운임 확인 필요";
              break;
            }
            sum += single * q;
            continue;
          }
          if (r.maxConfirmed && r.maxBundle !== null && q > r.maxBundle) {
            pending = true;
            reason = entry.name + " 합포장 제한 초과 / 운임 확인 필요";
            break;
          }
          const amount = r.fees[String(q)];
          if (!validAmount(amount)) {
            pending = true;
            reason = entry.name + " " + q + "개 운임 확인 필요";
            break;
          }
          sum += amount;
        }
        if (!pending && byGroup.size) {
          recommendation = sum;
          reason = "현재 상품별/동급 그룹 기본 운임표";
          source = "GROUP";
        }
      }
      bundles.push({
        key,
        recipientId: r.id,
        origin,
        items,
        versions,
        description:
          (r.name || "수취인 확인") +
          " / " +
          items.map((i) => i.name + " × " + i.quantity).join(" + "),
        recommendation,
        reason,
        source,
      });
    }
  return bundles;
}
export function recommendShipping(o: Order, state: State) {
  const bundles = shippingBundles(o, state);
  return {
    bundles,
    total:
      bundles.length && bundles.every((b) => b.recommendation !== null)
        ? bundles.reduce((s, b) => s + b.recommendation!, 0)
        : null,
    version: JSON.stringify({
      epoch: state.shipping?.epoch ?? 1,
      groups: bundles.map((b) => b.versions),
    }),
  };
}
export function saveCombination(
  shipping: ShippingState,
  bundle: ShippingBundle,
  charge: number,
  actual: number | null = null,
) {
  if (!validAmount(charge) || (actual !== null && !validAmount(actual)))
    throw Error("운임은 0 이상의 원 단위 정수로 입력하세요.");
  const next = structuredClone(shipping);
  for (const old of next.combinations) if (old.key === bundle.key && old.active) old.active = false;
  next.combinations.push({
    id: id(),
    key: bundle.key,
    epoch: next.epoch,
    versions: bundle.versions,
    charge,
    actual,
    at: new Date().toISOString(),
    active: true,
    description: bundle.description,
  });
  return next;
}
export function changeShippingBasis(shipping: ShippingState, groupId?: string) {
  const next = structuredClone(shipping);
  if (!groupId) {
    next.epoch++;
    for (const [pid, old] of Object.entries(next.productRules ?? {})) {
      next.productHistory ??= {};
      next.productHistory[pid] = [...(next.productHistory[pid] ?? []), old];
      next.productRules![pid] = {
        ...old,
        version: id(),
        at: new Date().toISOString(),
        fees: {},
        perItem: null,
        notes: "새 기준의 운임 확인 필요",
      };
    }
  }
  for (const g of next.groups.filter((g) => !groupId || g.id === groupId)) {
    g.history.push(structuredClone(g.current));
    g.current = {
      ...g.current,
      version: id(),
      at: new Date().toISOString(),
      fees: {
        "1": null,
        "2": null,
        "3": null,
        "4": null,
        "5": null,
        "6": null,
      },
      perItem: null,
      notes: "새 기준의 운임 확인 필요",
    };
  }
  return next;
}

export function emptyProductRule(): ShippingRule {
  return {
    version: id(),
    at: new Date().toISOString(),
    fees: { "1": null, "2": null, "3": null, "4": null, "5": null, "6": null },
    maxBundle: null,
    maxConfirmed: false,
    perItem: null,
    notes: "상품의 최대 묶음 수량과 운임을 확인해 입력하세요.",
  };
}
export function effectiveShippingRule(state: State, productId: string) {
  const p = state.products.find((p) => p.id === productId),
    group = state.shipping?.groups.find((g) => g.id === p?.shippingGroupId && !g.deletedAt);
  return {
    group,
    rule: group?.current ?? state.shipping?.productRules?.[productId],
  };
}
export function combinationCurrent(c: ShippingCombination, state: State) {
  const shipping = state.shipping;
  if (!shipping || !c.active || c.epoch !== shipping.epoch) return false;
  return Object.entries(c.versions).every(([key, v]) => {
    if (key.startsWith("group:"))
      return shipping.groups.some(
        (g) => g.id === key.slice(6) && g.current.version === v && shippingRuleCurrent(g.current),
      );
    if (key.startsWith("product:"))
      return (
        (shipping.productRules?.[key.slice(8)]?.version ?? "unregistered") === v &&
        (!shipping.productRules?.[key.slice(8)] ||
          shippingRuleCurrent(shipping.productRules[key.slice(8)]))
      );
    if (key.startsWith("assignment:"))
      return (
        (state.products.find((p) => p.id === key.slice(11))?.shippingGroupId ?? "individual") === v
      );
    return shipping.groups.find((g) => g.id === key)?.current.version === v;
  });
}

export function combinationVersions(key: string, state: State) {
  const versions: Record<string, string> = {};
  for (const part of key.split("|").slice(1)) {
    const pid = part.split("@")[0],
      p = state.products.find((p) => p.id === pid),
      group = state.shipping?.groups.find((g) => g.id === p?.shippingGroupId && !g.deletedAt);
    versions["assignment:" + pid] = group?.id ?? "individual";
    versions[group ? "group:" + group.id : "product:" + pid] =
      group?.current.version ?? state.shipping?.productRules?.[pid]?.version ?? "unregistered";
  }
  return versions;
}

export const bundleCounts = (max: number | null | undefined) =>
  max && Number.isInteger(max) && max > 0
    ? Array.from({ length: Math.min(6, max) }, (_, i) => i + 1)
    : [];
export function editableShippingRule(input: ShippingRule): ShippingRule {
  const r = structuredClone(input);
  if (validAmount(r.perItem)) {
    r.fees = { ...r.fees, "1": r.perItem };
    r.perItem = null;
    r.maxBundle = 1;
    r.maxConfirmed = true;
  }
  return r;
}

export function shippingRuleCurrent(rule: ShippingRule | undefined) {
  // Past freight dates no longer control active pricing.
  return !!rule;
}

