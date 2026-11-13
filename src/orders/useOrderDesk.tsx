import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { type WorkflowSelection } from "../WorkflowBoard";
import {
  itemFromProduct,
  normalizeColor,
  orderClient,
  unassignedClient,
} from "../domain";
import type { StaffBlock } from "../hub-messages";
import { hubMessages } from "../hub-messages";
import { businessCoreCall } from "../tauri-bridge";
import { applyRustReceptionAnalysis, assertRustReceptionAnalysis, receptionAnalysisAllowed } from "./rust-reception";
import { registeredProducts, sortProducts } from "../product-models";
import { billingSnapshot } from "../replies";
import type { NoticeSink } from "../shared/notices";
import type { Item, Order, Product, State } from "../types";
import { clone } from "../ui";
import { pendingIssue } from "../validation";
import { shouldRefreshUncommittedOrderPricing } from "./passive-pricing";
import { groupMessages, groupShipments, reconcileWorkflow } from "../workflow";
type SaveMode = "save" | "notify" | "pay" | "queue" | "wait";
export type OrderDeskProps = {
  onRawEditDirty?: (dirty: boolean) => void;
  portalTargets?: {
    source?: HTMLElement | null;
    messages?: HTMLElement | null;
    details?: HTMLElement | null;
  };
  viewMode?: "all" | "reception" | "details";
  linkController?: {
    active: string;
    recipientId?: string;
    setActive: (value: string) => void;
  };
  workflowSelection?: WorkflowSelection;
  onSelectWorkflow: (s: WorkflowSelection) => void;
  onWorkflowSave: (s: State) => Promise<void>;
  state: State;
  // HubWorkspace may supply a preview state containing unsaved orders.
  // Use the authoritative persisted order set when deciding whether this
  // record is a new reception that may track current master prices.
  persistedOrders?: readonly Pick<Order, "id">[];
  draft: Order;
  onChange: (next: Order | ((previous: Order) => Order)) => void;
  onSave: (mode: SaveMode) => Promise<void>;
  onSaveState: (state: State) => Promise<void>;
  onNotice: NoticeSink;
  onManageProducts: () => void;
  onManual?: () => void;
  onSettings?: () => void;
};
export function useOrderDesk({
  state,
  persistedOrders,
  draft,
  onChange,
  onSave,
  onSaveState,
  onNotice,
  onManageProducts,
  onManual,
  onSettings,
  workflowSelection,
  onSelectWorkflow,
  onWorkflowSave,
  onRawEditDirty,
  portalTargets,
  viewMode = "all",
  linkController,
}: OrderDeskProps) {
  const [resolving, setResolving] = useState<{
    rid: string;
    iid: string;
  }>();
  const [productSearch, setProductSearch] = useState<{
    rid: string;
    iid?: string;
  }>();
  const [itemEditing, setItemEditing] = useState<{
      rid: string;
      iid: string;
    }>(),
    [pendingFocus, setPendingFocus] = useState<string>();
  const [rawEditing, setRawEditing] = useState(false);
  const [localHighlight, setLocalHighlight] = useState("");
  const highlight = linkController?.active ?? localHighlight,
    setHighlight = linkController?.setActive ?? setLocalHighlight;
  const place = (content: ReactNode, node?: HTMLElement | null) =>
    portalTargets ? (node ? createPortal(content, node) : null) : content;
  const [source, setSource] = useState(draft.analysisRaw ?? draft.raw),
    [links] = useState({ payment: false, options: false }),
    [selected, setSelected] = useState<string[]>([]);
  const client = orderClient(draft, state),
    liveClient = state.clients.find((c) => c.id === draft.clientId && !c.deletedAt) ?? client,
    pricingClient = liveClient ?? unassignedClient;
  const products = useMemo(
    () => sortProducts(registeredProducts(state.products)),
    [state.products],
  );
  const flowState = useMemo(() => reconcileWorkflow(state, draft), [state, draft]);
  const flowGroups = (flowState.workflow?.groups ?? []).filter((g) =>
    groupShipments(flowState, g.id).some((s) => s.orderId === draft.id),
  );
  const activeGroupId = flowGroups.some((g) => g.id === workflowSelection?.groupId)
    ? workflowSelection!.groupId
    : (
        flowGroups.find((g) => groupShipments(flowState, g.id).some((s) => !s.transferred)) ??
        flowGroups[0]
      )?.id;
  const activeShipments = activeGroupId ? groupShipments(flowState, activeGroupId) : [];
  const activeShipment =
    activeShipments.find((s) => s.id === workflowSelection?.shipmentId) ?? activeShipments[0];

  const generated = activeGroupId
    ? groupMessages(flowState, activeGroupId, links)
    : hubMessages(draft, state, undefined, links);
  const persisted = persistedOrders ?? state.orders;
  const saved = persisted.some((o) => o.id === draft.id),
    // Saved orders retain historical prices even when their preview state
    // contains a revised product/shipping master.
    passivePricingAllowed = shouldRefreshUncommittedOrderPricing(draft, persisted),
    exported = draft.status === "EXPORTED" || activeShipment?.transferred === true;
  useEffect(() => {
    if (viewMode === "details" && highlight)
      document
        .querySelector('.review-pane [data-link-key=\"' + CSS.escape(highlight) + '\"]')
        ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [highlight, viewMode]);
  useEffect(() => {
    setRawEditing(false);
    setSource(draft.analysisRaw ?? draft.raw);
    setSelected([]);
  }, [draft.id, draft.rawCorrections?.at(-1)?.id]);
  useEffect(() => {
    if (viewMode !== "details") onRawEditDirty?.(rawEditing && source !== draft.raw);
  }, [rawEditing, source, draft.raw, viewMode, onRawEditDirty]);
  // Rust responses for pricing and shipping may arrive after the employee
  // has changed the draft or the master catalog. Reject those stale results
  // rather than overwriting newer manually approved information.
  const ruleRequests = useRef({ price: 0, shipping: 0 });
  const rulesClientSignature = JSON.stringify(liveClient ?? null);
  const latestRulesInput = useRef({ draft, state, rulesClientSignature, saved });
  latestRulesInput.current = { draft, state, rulesClientSignature, saved };
  useEffect(() => {
    const request = ++ruleRequests.current.price;
    if (!liveClient || !passivePricingAllowed) return;
    const before = JSON.stringify(draft.recipients);
    const orderId = draft.id;
    void businessCoreCall<{ order: Order; refreshed: boolean }>(
      "rules", "reprice_order", {
        order: draft,
        client: liveClient,
        state,
        persistedOrders: persisted,
      },
    ).then(({ order, refreshed }) => {
      const current = latestRulesInput.current;
      if (!refreshed || request !== ruleRequests.current.price ||
          current.state !== state || current.draft.id !== orderId ||
          current.rulesClientSignature !== rulesClientSignature) return;
      onChange((previous) => {
        if (request !== ruleRequests.current.price ||
            !shouldRefreshUncommittedOrderPricing(previous, persisted) ||
            previous.id !== orderId ||
            JSON.stringify(previous.recipients) !== before) return previous;
        const next = { ...previous, recipients: order.recipients };
        // Factory-transferred and further-confirmed rows are frozen even if
        // a catalog update has occurred since the receipt was entered.
        for (const r of next.recipients)
          if (state.workflow?.shipments.some((ship) =>
            ship.orderId === previous.id && ship.recipientId === r.id &&
            (ship.transferred || ship.step >= 3))) {
            const old = previous.recipients.find((row) => row.id === r.id);
            if (old) Object.assign(r, clone(old));
          }
        return JSON.stringify(previous.recipients) === JSON.stringify(next.recipients)
          ? previous : next;
      });
    }).catch((error) => {
      if (request === ruleRequests.current.price)
        onNotice("Rust 단가 계산 실패: " +
          (error instanceof Error ? error.message : String(error)), "error");
    });
    return () => { if (request === ruleRequests.current.price) ruleRequests.current.price++; };
  }, [
    draft.id, draft.recipients, state.products, liveClient?.id,
    liveClient?.tier, JSON.stringify(liveClient?.overrides),
    passivePricingAllowed,
  ]);
  useEffect(() => {
    const request = ++ruleRequests.current.shipping;
    // Existing completed orders are not repriced passively. The empty version
    // marker is set only by an explicit employee edit requiring new freight.
    const shippingPending = draft.shippingVersion === "" && draft.shippingFee === null;
    if ((!passivePricingAllowed && !shippingPending) ||
        draft.shippingMode === "MANUAL" || draft.pricesLocked ||
        draft.deletedAt || exported ||
        !draft.recipients.some((r) => r.items.length > 0)) return;
    const before = JSON.stringify(draft.recipients);
    const orderId = draft.id;
    void businessCoreCall<{ total: number | null; version: string }>(
      "rules", "calculate_shipping", { order: draft, state },
    ).then((result) => {
      const current = latestRulesInput.current;
      if (request !== ruleRequests.current.shipping ||
          current.state !== state || current.draft.id !== orderId ||
          current.rulesClientSignature !== rulesClientSignature) return;
      onChange((previous) => {
        if (request !== ruleRequests.current.shipping ||
            previous.id !== orderId || previous.pricesLocked ||
            previous.shippingMode === "MANUAL" ||
            JSON.stringify(previous.recipients) !== before ||
            (!shouldRefreshUncommittedOrderPricing(previous, persisted) &&
              !(previous.shippingVersion === "" && previous.shippingFee === null)))
          return previous;
        const fee = liveClient?.shippingFeeExcluded ? 0 : result.total;
        if (previous.shippingFee === fee &&
            previous.shippingVersion === result.version) return previous;
        return {
          ...previous, shippingFee: fee,
          shippingVersion: result.version, shippingMode: "AUTO",
        };
      });
    }).catch((error) => {
      if (request === ruleRequests.current.shipping)
        onNotice("Rust 운임 계산 실패: " +
          (error instanceof Error ? error.message : String(error)), "error");
    });
    return () => {
      if (request === ruleRequests.current.shipping) ruleRequests.current.shipping++;
    };
  }, [
    draft.id, draft.recipients, draft.shippingMode, draft.shippingFee,
    draft.shippingVersion, draft.pricesLocked, draft.deletedAt,
    state.shipping, state.products, liveClient?.shippingFeeExcluded,
    passivePricingAllowed, exported,
  ]);
  // Every native response is associated with a specific draft, raw text,
  // client and catalog revision. A completed previous request must never
  // replace newer typing, a newly selected order or employee corrections.
  const recognitionRequest = useRef(0);
  // RETAIL's companyParty() can allocate a new equal object each render.
  // A semantic signature prevents repeated native calls on those renders.
  const clientSignature = JSON.stringify(liveClient ?? null);
  const latestReceptionInput = useRef({
    orderId: draft.id,
    clientId: draft.clientId,
    source,
    saved,
    manual: !!draft.manualClassification,
    products: state.products,
    aliases: state.aliases,
    clientSignature,
  });
  latestReceptionInput.current = {
    orderId: draft.id,
    clientId: draft.clientId,
    source,
    saved,
    manual: !!draft.manualClassification,
    products: state.products,
    aliases: state.aliases,
    clientSignature,
  };
  useEffect(() => {
    const request = ++recognitionRequest.current;
    if (
      viewMode === "details" ||
      saved ||
      !!draft.manualClassification ||
      !receptionAnalysisAllowed(draft, source, pricingClient.id)
    ) return;
    const orderId = draft.id;
    const clientId = draft.clientId;
    const timer = setTimeout(() => {
      const pending: Promise<unknown> = source.trim()
        ? businessCoreCall<unknown>("recognition", "analyze_order", {
            raw: source,
            client: liveClient ?? null,
            state: {
              ...state,
              products: state.products.filter(
                (p) => p.catalog !== "DEMO" && !p.variants.some((v) => v.source === "DEMO"),
              ),
            },
          })
        : Promise.resolve({ recipients: [], candidates: [], unassigned: [] });
      void pending.then((result) => {
        const latest = latestReceptionInput.current;
        if (
          request !== recognitionRequest.current ||
          latest.orderId !== orderId ||
          latest.clientId !== clientId ||
          latest.source !== source ||
          latest.saved || latest.manual ||
          latest.products !== state.products ||
          latest.aliases !== state.aliases ||
          latest.clientSignature !== clientSignature
        ) return;
        assertRustReceptionAnalysis(result, source);
        onChange((previous) => {
          const active = latestReceptionInput.current;
          if (
            request !== recognitionRequest.current ||
            active.orderId !== orderId ||
            active.clientId !== clientId ||
            active.source !== source ||
            active.saved || active.manual ||
            active.products !== state.products ||
            active.aliases !== state.aliases ||
            active.clientSignature !== clientSignature ||
            previous.id !== orderId ||
            previous.clientId !== clientId ||
            !receptionAnalysisAllowed(previous, source, pricingClient.id)
          ) return previous;
          return applyRustReceptionAnalysis(previous, result, {
            raw: source,
            state,
            pricingClient,
            at: new Date().toISOString(),
          });
        });
      }).catch((error: unknown) => {
        const latest = latestReceptionInput.current;
        if (
          request !== recognitionRequest.current ||
          latest.orderId !== orderId ||
          latest.clientId !== clientId ||
          latest.source !== source ||
          latest.saved || latest.manual
        ) return;
        onNotice("Rust 발주서 자동 분석 실패: " +
          (error instanceof Error ? error.message : String(error)), "error");
      });
    }, 350);
    return () => {
      clearTimeout(timer);
      if (recognitionRequest.current === request) recognitionRequest.current++;
    };
  }, [
    source, draft.id, draft.clientId, draft.analysisRaw, draft.analysisClientId,
    draft.manualClassification, draft.confirmedAt, draft.pricesLocked,
    viewMode, saved, pricingClient.id, clientSignature,
    state.products, state.aliases,
  ]);
  const run = async (fn: () => Promise<unknown> | unknown) => {
    try {
      await fn();
    } catch (e) {
      onNotice(e instanceof Error ? e.message : String(e), "error");
    }
  };
  const edit = (fn: (o: Order) => void, reason = "주문 정보 수정", recalculateShipping = true) => {
    if (draft.deletedAt) {
      onNotice("삭제된 발주는 이력으로만 조회할 수 있습니다.");
      return;
    }
    if (exported) {
      onNotice("공장 전달 완료 주문은 변경할 수 없습니다. 출고 취소 / 회수 확인이 필요합니다.");
      return;
    }
    onChange((previous) => {
      const next = clone(previous);
      if (previous.pricesLocked && !activeGroupId)
        next.billingHistory = [
          ...(next.billingHistory ?? []),
          billingSnapshot(previous, state, reason),
        ];
      next.pricesLocked = false;
      next.clientSnapshot = liveClient ? clone(liveClient) : next.clientSnapshot;
      next.notified = false;
      next.paid = false;
      next.postpaidApproved = false;
      next.status = "REVIEW";
      fn(next);
      if (next.orderType)
        for (const row of next.recipients) {
          row.dispatchOrigin ??= "FACTORY";
          row.items.forEach((item) => (item.origin = row.dispatchOrigin!));
        }
      next.updatedAt = new Date().toISOString();
      if (recalculateShipping) {
        next.shippingMode = "AUTO";
        // A changed draft cannot retain its old freight as a valid amount.
        // Async native Rust shipping will fill in the authoritative tariff.
        next.shippingFee = null;
        next.shippingVersion = "";
      }
      return next;
    });
  };
  const recEdit = (rid: string, fn: (r: Order["recipients"][number]) => void, recalculate = true) =>
    edit(
      (o) => {
        const r = o.recipients.find((r) => r.id === rid);
        if (r) fn(r);
      },
      "수취인 / 배송 정보 수정",
      recalculate,
    );
  const itemEdit = (rid: string, iid: string, fn: (i: Item) => void) =>
    recEdit(rid, (r) => {
      const i = r.items.find((i) => i.id === iid);
      if (i) {
        const before = JSON.stringify([i.productId, i.variantId, i.quantity, i.quantityConfirmed]);
        fn(i);
        if (before !== JSON.stringify([i.productId, i.variantId, i.quantity, i.quantityConfirmed]))
          delete i.quantityApproval;
        i.manuallyConfirmed = true;
      }
    });

  const allBlocks =
    !draft.raw.trim() && !draft.recipients.length
      ? []
      : flowGroups.length
        ? flowGroups.flatMap((g) => groupMessages(flowState, g.id).validation)
        : generated.validation;
  const staffBlocks: StaffBlock[] = allBlocks
    .filter((b, i, a) => a.findIndex((x) => x.issueId === b.issueId) === i)
    .map((b) => {
      const r = draft.recipients.find((r) => r.id === b.recipientId),
        item = r?.items.find((i) => i.id === b.itemId);
      return {
        ...b,
        detail:
          b.detail +
          (b.kind === "APPLIED" ? " × " + item?.quantity : "") +
          (item?.recognitionReason ? " / " + item.recognitionReason : ""),
        choices:
          b.kind.startsWith("CANDIDATE_")
            ? r?.candidates
                ?.filter((c) => c.field === b.kind.slice(10))
                .map((c) => ({ label: c.label, value: c.value }))
            : undefined,
      };
    });
  const question = (b: StaffBlock) => {
    if (!b.issueId) return;
    onChange((previous) => ({
      ...pendingIssue(previous, b.issueId!, state.settings.operatorName || "직원"),
      requestedIssueIds: [...new Set([...(previous.requestedIssueIds ?? []), b.issueId!])],
    }));
  };
  const shownRecipient =
    activeShipment?.recipientId ??
    draft.recipients.find(
      (r) => "shipment:" + draft.id + ":" + r.id === workflowSelection?.shipmentId,
    )?.id ??
    draft.recipients[0]?.id;
  const selectIssue = (block: StaffBlock) => {
    if (block.kind === "UNASSIGNED_EVIDENCE") {
      onManual?.();
      return;
    }
    if ((block.kind === "ITEM" || block.kind === "OPTION") && block.recipientId) {
      // A configuration is a standalone product, never a secondary dropdown selection.
      setProductSearch({ rid: block.recipientId, iid: block.itemId });
      return;
    }
    if (exported && block.itemId) {
      onNotice("전달한 품목은 엑셀 이력의 공장 정정 요청에서 변경하세요.");
      return;
    }
    if (
      draft.orderType === "DEALER" &&
      ["SENDER_NAME", "SENDER_ADDRESS", "SENDER_CONTACT"].includes(block.kind ?? "")
    ) {
      onSettings?.();
      return;
    }
    if (!block.recipientId) {
      if (block.kind === "CLIENT")
        document.querySelector<HTMLButtonElement>(".source-client-actions > button")?.click();
      document.querySelector<HTMLInputElement>('[aria-label="거래처 통합 검색"]')?.focus();
      return;
    }
    const shipment = flowState.workflow?.shipments.find(
      (s) => s.orderId === draft.id && s.recipientId === block.recipientId,
    );
    onSelectWorkflow(
      shipment
        ? {
            orderId: draft.id,
            groupId: shipment.groupId,
            shipmentId: shipment.id,
          }
        : {
            orderId: draft.id,
            groupId: "group:" + draft.id,
            shipmentId: "shipment:" + draft.id + ":" + block.recipientId,
          },
    );
    if (block.itemId) {
      if (
        block.severity !== "INFO" &&
        [
          "MODEL",
          "MODEL_CHOICE",
          "ALIAS_CONFLICT",
          "CATEGORY_CONFLICT",
          "QUANTITY_LINK",
          "OPTION",
        ].includes(block.kind ?? "")
      )
        setResolving({ rid: block.recipientId, iid: block.itemId });
      else if (block.kind !== "QUANTITY_MISSING")
        setItemEditing({ rid: block.recipientId, iid: block.itemId });
    }
    if (block.linkKey) {
      setHighlight(block.linkKey);
      setPendingFocus(block.linkKey);
    }
  };
  useEffect(() => {
    if (!pendingFocus) return;
    const frame = requestAnimationFrame(() => {
      const targets = Array.from(document.querySelectorAll<HTMLElement>("[data-link-key]")),
        target = targets.find(
          (e) =>
            e.dataset.linkKey === pendingFocus &&
            (e.closest(".review-pane") || e.closest('[aria-label="상품 상세 수정"]')),
        );
      if (!target) return;
      target.scrollIntoView({ block: "nearest" });
      (
        target.querySelector<HTMLElement>("input:not(:disabled)") ??
        target.querySelector<HTMLElement>("select,button")
      )?.focus({ preventScroll: true });
      setPendingFocus(undefined);
    });
    return () => cancelAnimationFrame(frame);
  }, [pendingFocus, shownRecipient, itemEditing]);
  const selectedItems = draft.recipients
    .flatMap((r) => r.items)
    .filter((i) => selected.includes(i.id));
  let colors: string[] = [];
  if (selectedItems.length) {
    colors =
      products
        .find((p) => p.id === selectedItems[0].productId)
        ?.variants.map((v) => normalizeColor(v.color)) ?? [];
    colors = [...new Set(colors)].filter((c) =>
      selectedItems.every((i) =>
        products
          .find((p) => p.id === i.productId)
          ?.variants.some((v) => normalizeColor(v.color) === c),
      ),
    );
  }
  const chooseProduct = (rid: string, p: Product, iid?: string) => {
    if (p.variants.length !== 1 || p.requiresOption) {
      onNotice(p.requiresOption
        ? "상품 구성이 미확정입니다. 판매 구성을 확인한 뒤 독립 상품으로 등록하세요."
        : "상품 가격 기록이 정확히 하나가 아닙니다. 상품 데이터를 확인하세요.", "error");
      return;
    }
    const orderId = draft.id;
    const itemId = iid;
    const variantId = p.variants[0].id;
    void run(async () => {
      const { unitPrice } = await businessCoreCall<{ unitPrice: number | null }>(
        "rules", "resolve_unit_price", {
          product: p, variantId, client: pricingClient,
        },
      );
      const current = latestRulesInput.current;
      if (current.draft.id !== orderId || current.state !== state ||
          current.rulesClientSignature !== rulesClientSignature ||
          current.draft.deletedAt || current.draft.status === "EXPORTED")
        return;
      if (itemId) {
        // The visible product name, old evidence and manually confirmed
        // quantity survive; only the price comes from native Rust.
        if (!current.draft.recipients.some((r) =>
          r.id === rid && r.items.some((item) => item.id === itemId))) return;
        itemEdit(rid, itemId, (item) => {
          const proposal = !item.productId || !!item.modelProposal?.required;
          const old = {
            id: item.id, raw: item.raw, sources: item.sources,
            quantityConfirmed: item.quantityConfirmed,
          };
          Object.assign(item, itemFromProduct(p, pricingClient, undefined, item.quantity), old, {
            manuallyConfirmed: true, unitPrice,
          });
          item.match = { kind: "NAME", term: p.name, productIds: [p.id] };
          item.temporary = false;
          delete item.pendingAlias;
          if (proposal) {
            item.modelProposal = { original: old.raw, required: true };
            item.issues.push("추천 상품 고객 확인 필요");
          }
        });
      } else {
        recEdit(rid, (r) => r.items.push({
          ...itemFromProduct(p, pricingClient, undefined, null),
          unitPrice, quantityConfirmed: false,
        }));
      }
      setProductSearch(undefined);
    });
  };
  return {
    highlight,
    linkController,
    setHighlight,
    viewMode,
    place,
    state,
    draft,
    source,
    client,
    setSource,
    saved,
    onChange,
    exported,
    onWorkflowSave,
    onSave,
    onSaveState,
    onNotice,
    portalTargets,
    staffBlocks,
    selectIssue,
    question,
    recEdit,
    products,
    pricingClient,
    shownRecipient,
    setItemEditing,
    itemEdit,
    activeShipment,
    flowState,
    setProductSearch,
    edit,
    activeGroupId,
    run,
    resolving,
    setResolving,
    productSearch,
    chooseProduct,
    itemEditing,
  };
}
