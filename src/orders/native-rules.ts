/** Native Rust computations used by editable reception and dealer workflows.
 * No fallback to TypeScript prices or freight on failed native execution.
 * These functions never write SQLite or silently modify the supplied order.
 */
import { businessCoreCall } from "../tauri-bridge";
import { groupMessages } from "../workflow";
import type { Client, Order, Origin, Price, State } from "../types";

export async function nativeRepriceEditedOrder(
  order: Order,
  client: Client,
  state: State,
): Promise<Order> {
  const next = structuredClone(order);
  const requests = next.recipients.flatMap((recipient) =>
    recipient.items.flatMap((item) => {
      const product = state.products.find((p) => p.id === item.productId);
      return product && item.variantId
        ? [{ item, product, variantId: item.variantId }]
        : [];
    }),
  );
  const prices = await Promise.all(
    requests.map(({ product, variantId }) =>
      businessCoreCall<{ unitPrice: number | null }>(
        "rules", "resolve_unit_price", { product, variantId, client },
      )),
  );
  requests.forEach(({ item, product, variantId }, index) => {
    item.unitPrice = prices[index].unitPrice;
    if (item.modelProposal?.required) {
      const variant = product.variants.find((v) => v.id === variantId);
      if (variant?.url) item.url = variant.url;
    }
  });
  return next;
}

export async function nativeReconcileWorkflow(
  state: State,
  draft?: Order,
): Promise<State> {
  // Rust reconciliation is deterministic and never reads the system clock
  // or generates IDs itself. Reserve enough candidate IDs for all potential
  // downgrade and revalidation events; unused IDs are not persisted.
  const count = Math.max(
    256,
    12 * (state.workflow?.shipments.length ?? 0) +
      8 * state.orders.length + 64,
  );
  if (count > 15000) throw Error("재검증 이벤트가 너무 많습니다. 발주 묶음을 나누어 확인하세요.");
  const eventIds = Array.from({ length: count }, () => crypto.randomUUID());
  const { state: next } = await businessCoreCall<{ state: State; emittedEvents: number }>(
    "rules", "reconcile_workflow", {
      state, ...(draft ? { draft } : {}),
      now: new Date().toISOString(), eventIds,
    },
  );
  await businessCoreCall<{ valid: boolean }>(
    "rules", "validate_workflow", { state: next, before: state },
  );
  return next;
}

/** Persist a staff-approved actual freight amount using Rust's audited
 * shipment operation. The caller still commits exactly once via SQLite.
 */
export async function nativeRecordActualFreight(
  state: State, shipmentId: string, origin: Origin, value: Price,
): Promise<State> {
  const { state: updated } = await businessCoreCall<{ state: State }>(
    "rules", "apply_workflow_action", {
      action: "record_actual_freight",
      state, shipmentId, origin, value,
      now: new Date().toISOString(),
      eventId: crypto.randomUUID(),
      actor: state.settings.operatorName || "직원",
    },
  );
  return updated;
}

/** Stateful workflow transitions use Rust's audited domain reducer. The
 * caller's onSave still owns the single revision-checked SQLite transaction.
 */
export async function nativeApplyWorkflowAction(
  state: State,
  action:
    | "restore_shipment" | "mark_store_sent" | "detach_shipment"
    | "regroup_shipment" | "undo_group" | "advance_group"
    | "confirm_group_payment" | "process_group"
    | "set_group_account" | "set_shipment_freight",
  args: Record<string, unknown>,
): Promise<State> {
  const prepared = action === "mark_store_sent"
    ? state : await nativeReconcileWorkflow(state);
  const now = new Date().toISOString();
  const actor = state.settings.operatorName?.trim() || "직원(이름 미설정)";
  // Audit IDs are preallocated on the caller side. Only IDs of actually
  // emitted records are used; never leave a partially changed SQLite state.
  const auditEventIds = Array.from({ length: 2048 }, () => crypto.randomUUID());
  // Payment copy text is UI-owned but its notice record is a native Rust
  // workflow decision. Build it from the reconciled state that Rust will use.
  const paymentMessage =
    action === "advance_group" && typeof args.groupId === "string"
      ? groupMessages(prepared, args.groupId).payment
      : undefined;
  const payload = {
    state: prepared, action, now, actor,
    eventId: crypto.randomUUID(),
    auditEventIds,
    newGroupId: crypto.randomUUID(),
    confirmationId: crypto.randomUUID(),
    noticeId: crypto.randomUUID(),
    ...(paymentMessage !== undefined ? { paymentMessage } : {}),
    ...args,
  };
  const result = await businessCoreCall<{ state: State }>(
    "rules", "apply_workflow_action", payload,
  );
  await businessCoreCall<{ valid: boolean }>(
    "rules", "validate_workflow", { state: result.state, before: state },
  );
  return result.state;
}

/** Execute the existing Rust correction reducer for already-exported freight.
 * Caller performs the single revision-checked SQLite commit; no TS mutation
 * fallback is allowed on a native error.
 */
export async function nativeApplyCorrectionAction(
  state: State,
  action: "request_correction" | "copied_correction" | "confirm_correction"
    | "mark_factory_delivered" | "mark_collected" | "reopen_unsent_export",
  args: { shipmentId?: string; requestId?: string; afterRecipient?: import("../types").Recipient },
): Promise<State> {
  const { state: updated } = await businessCoreCall<{ state: State }>(
    "rules", "apply_correction_action", {
      state, action, ...args, now: new Date().toISOString(),
      ids: [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()],
    },
  );
  await businessCoreCall<{ valid: boolean }>(
    "rules", "validate_workflow", { state: updated, before: state },
  );
  return updated;
}

/** Confirm a direct-entry retail order with the existing Rust reducer.
 * New-order form construction stays synchronous in React; the confirmed order
 * and all workflow/audit transitions come exclusively from native Rust.
 */
export async function nativeConfirmRetail(
  state: State,
  draft: Order,
): Promise<State> {
  const count = Math.max(
    256,
    12 * (state.workflow?.shipments.length ?? 0) + 8 * state.orders.length + 64,
  );
  if (count > 15000) throw Error("재검증 이벤트가 너무 많습니다. 발주 묶음을 나누어 확인하세요.");
  const ids = () => Array.from({ length: count }, () => crypto.randomUUID());
  const { state: updated } = await businessCoreCall<{ state: State }>(
    "rules", "apply_retail_action", {
      state, draft, action: "confirm_retail",
      now: new Date().toISOString(),
      receiptEventId: crypto.randomUUID(),
      processEventId: crypto.randomUUID(),
      reconcileEventIds: ids(),
      processReconcileEventIds: ids(),
    },
  );
  await businessCoreCall<{ valid: boolean }>(
    "rules", "validate_workflow", { state: updated, before: state },
  );
  return updated;
}

/** Soft deletion/restoration of a shipment group is also an audited Rust rule.
 * This keeps its event history and protects payment/exported groups.
 */
export async function nativeChangeGroup(
  state: State, groupId: string, action: "delete_group" | "restore_group",
): Promise<State> {
  const result = await businessCoreCall<{ state: State }>(
    "rules", "apply_group_action", {
      state, groupId, action, now: new Date().toISOString(),
      eventId: crypto.randomUUID(),
    },
  );
  await businessCoreCall<{ valid: boolean }>(
    "rules", "validate_workflow", { state: result.state, before: state },
  );
  return result.state;
}
