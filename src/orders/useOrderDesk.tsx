import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { type WorkflowSelection } from "../WorkflowBoard";
import {
  itemFromProduct,
  normalizeColor,
  orderClient,
  repriceOrder,
  resolvePrice,
  unassignedClient,
} from "../domain";
import type { StaffBlock } from "../hub-messages";
import { hubMessages } from "../hub-messages";
import { addressParts, mergeParsedItem, parseEvidence } from "../parser";
import { registeredProducts, sortProducts } from "../product-models";
import { billingSnapshot } from "../replies";
import type { NoticeSink } from "../shared/notices";
import { recommendShipping } from "../shipping";
import type { Item, Order, Product, State } from "../types";
import { clone } from "../ui";
import { pendingIssue } from "../validation";
import { shouldRefreshUncommittedOrderPricing } from "./passive-pricing";
import { matchingRecipient, rebindEvidence } from "../order-evidence";
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
  useEffect(() => {
    if (!liveClient || !passivePricingAllowed) return;
    onChange((previous) => {
      // Check the latest draft too: a save may complete between scheduling
      // the effect and running its state-updater callback.
      if (!shouldRefreshUncommittedOrderPricing(previous, persisted)) return previous;
      const next = repriceOrder(previous, liveClient, state);
      for (const r of next.recipients)
        if (
          state.workflow?.shipments.some(
            (s) =>
              s.orderId === previous.id && s.recipientId === r.id && (s.transferred || s.step >= 3),
          )
        ) {
          const old = previous.recipients.find((x) => x.id === r.id);
          if (old) Object.assign(r, clone(old));
        }
      if (JSON.stringify(previous.recipients) === JSON.stringify(next.recipients)) return previous;
      return next;
    });
  }, [state.products, liveClient?.id, liveClient?.tier, JSON.stringify(liveClient?.overrides), passivePricingAllowed]);
  useEffect(() => {
    if (!passivePricingAllowed) return;
    onChange((previous) => {
      if (!shouldRefreshUncommittedOrderPricing(previous, persisted) ||
          previous.shippingMode === "MANUAL" ||
          !previous.recipients.some((recipient) => recipient.items.length > 0))
        return previous;
      const result = recommendShipping(previous, state),
        fee = liveClient?.shippingFeeExcluded ? 0 : result.total;
      if (previous.shippingFee === fee && previous.shippingVersion === result.version)
        return previous;
      return {
        ...previous,
        shippingFee: fee,
        shippingVersion: result.version,
        shippingMode: "AUTO",
      };
    });
  }, [state.shipping, state.products, draft.recipients, liveClient?.shippingFeeExcluded, passivePricingAllowed]);
  useEffect(() => {
    if (
      viewMode === "details" ||
      saved ||
      (draft.manualClassification && draft.analysisRaw === source) ||
      (draft.analysisRaw === source && draft.analysisClientId === draft.clientId)
    )
      return;
    const timer = setTimeout(() => {
      onChange((previous) => {
        const evidence = source.trim()
          ? parseEvidence(source, liveClient, {
              ...state,
              products: state.products.filter(
                (p) => p.catalog !== "DEMO" && !p.variants.some((v) => v.source === "DEMO"),
              ),
            })
          : { recipients: [], candidates: [], unassigned: [] };
        const parsed = evidence.recipients;
        const originalParsed = clone(parsed);
        const usedRecipients = new Set<string>();
        for (const r of parsed) {
          const old = matchingRecipient(r, previous.recipients, usedRecipients, parsed);
          if (old) usedRecipients.add(old.id);
          if (!old) continue;

          rebindEvidence(evidence.candidates, "recipientId", r.id, old.id);
          r.id = old.id;
          const usedItems = new Set<string>();
          for (const span of r.sources ?? []) {
            span.targetId = r.id;
            span.recipientId = r.id;
          }
          for (const field of old.confirmedFields ?? [])
            if (["name", "address", "phone", "mobile", "note"].includes(field))
              (r as unknown as Record<string, unknown>)[field] = (
                old as unknown as Record<string, unknown>
              )[field];
          r.confirmedFields = old.confirmedFields;
          r.dispatchOrigin = old.dispatchOrigin;
          r.actualFreight = old.actualFreight;
          r.freightCode = old.freightCode;
          r.vatDefault = old.vatDefault;
          r.vatOverride = old.vatOverride;
          r.shippingCharges = old.shippingCharges;
          if (old.confirmedFields?.includes("address")) {
            r.addressStatus = old.addressStatus;
            r.addressParts = old.addressParts ?? addressParts(old.address);
          }
          for (const item of r.items) {
            const prior = old.items.find((i) => i.raw === item.raw && !usedItems.has(i.id));
            if (prior) {
              usedItems.add(prior.id);

              rebindEvidence(evidence.candidates, "itemId", item.id, prior.id);
              item.id = prior.id;
              Object.assign(item, mergeParsedItem(item, prior));
              const product = state.products.find((p) => p.id === item.productId);
              if (product && item.variantId)
                item.unitPrice = resolvePrice(product, item.variantId, pricingClient);
              for (const span of item.sources ?? []) {
                span.targetId = item.id;
                span.recipientId = r.id;
              }
            }
          }
        }
        if (previous.orderType)
          for (const row of parsed) {
            row.dispatchOrigin ??= "FACTORY";
            row.items.forEach((item) => (item.origin = row.dispatchOrigin!));
          }
        const next = {
          ...previous,
          analysisEvidence: evidence.candidates,
          analysisSnapshot:
            previous.analysisSnapshot?.raw === source
              ? previous.analysisSnapshot
              : {
                  at: new Date().toISOString(),
                  raw: source,
                  ruleVersion: "parser-v0808",
                  recipients: originalParsed,
                },
          raw: source,
          analysisRaw: source,
          analysisClientId: pricingClient.id,
          recipients: parsed,
          pricesLocked: false,
          notified: false,
          paid: false,
          postpaidApproved: false,
          status: "REVIEW" as const,
        };
        const reco = recommendShipping(next, state);
        next.shippingFee = pricingClient.shippingFeeExcluded ? 0 : reco.total;
        next.shippingMode = "AUTO";
        next.shippingVersion = reco.version;
        return next;
      });
    }, 350);
    return () => clearTimeout(timer);
  }, [source, draft.clientId, viewMode]);
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
        const reco = recommendShipping(next, state);
        next.shippingFee = state.clients.find((c) => c.id === next.clientId)?.shippingFeeExcluded
          ? 0
          : reco.total;
        next.shippingVersion = reco.version;
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
    if (iid)
      itemEdit(rid, iid, (item) => {
        const proposal = !item.productId || !!item.modelProposal?.required;
        const old = {
          id: item.id,
          raw: item.raw,
          sources: item.sources,
          quantityConfirmed: item.quantityConfirmed,
        };
        Object.assign(item, itemFromProduct(p, pricingClient, undefined, item.quantity), old, {
          manuallyConfirmed: true,
        });
        item.match = { kind: "NAME", term: p.name, productIds: [p.id] };
        item.temporary = false;
        delete item.pendingAlias;
        if (proposal) {
          item.modelProposal = { original: old.raw, required: true };
          item.issues.push("추천 상품 고객 확인 필요");
        }
      });
    else
      recEdit(rid, (r) =>
        r.items.push({
          ...itemFromProduct(p, pricingClient, undefined, null),
          quantityConfirmed: false,
        }),
      );
    setProductSearch(undefined);
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
