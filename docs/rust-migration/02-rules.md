# TSBH Rust migration — session 2/3: Price, freight and workflow rules

Date: 2026-11-13 KST
Repository: ThunderStrikerKR/TSBH
Branch: migration/02-rules (created at d5ea8ed20b8120b844437263c2eb2b8963559e8d)
Last implementation/test-source commit before this document: ecdb71e20490ccd2acd71112e37ef19a67683f83
Last independent Cargo test-verified code commit: 3f68c89be8a0bb6c8d6b7f1611937e48a244fe5c (GitHub Actions; not an end-to-end parity or Windows validation)

## Scope and ownership

Session 2 wrote only:
- src-tauri/src/business_core/rules/mod.rs
- src-tauri/src/business_core/rules/pricing.rs
- src-tauri/src/business_core/rules/shipping.rs
- src-tauri/src/business_core/rules/workflow.rs
- src-tauri/src/business_core/rules/validation.rs
- tests/rust-migration/rules/Cargo.toml
- tests/rust-migration/rules/src/lib.rs
- docs/rust-migration/02-rules.md

No files owned by sessions 1/3, no TS call sites, no src-tauri/Cargo.toml, no
src-tauri/src/lib.rs, and no SQLite table definitions have been modified.
Writes were directly committed to the isolated remote branch. A local Git
worktree could not be created because GitHub DNS access is unavailable in
the executor. Rust and Cargo are not installed in the executor.

## Public entry point

Signature in src-tauri/src/business_core/rules/mod.rs:

    pub fn execute(
        operation: &str,
        payload: serde_json::Value,
    ) -> Result<serde_json::Value, String>

All inputs are JSON, all actions return new JSON values, and no function writes
SQLite or reads the current clock. Errors return String; callers must not
persist any intermediate state on Err.

Operations and JSON contracts:

1. calculate_price
   Input: {order: Order, client: Client}
   Output: {subtotal: Price, shipping: Price, vat: Price, total: Price}
   Source: src/domain.ts totals / roundVat

2. resolve_unit_price
   Input: {product: Product, variantId: string, client: Client}
   Output: {unitPrice: Price}
   Source: src/domain.ts resolvePrice

3. reprice_order
   Input: {order, client, products OR state.products, persistedOrders?,
           persistedOrderIds?, explicitEdit?}
   Output: {order: Order, refreshed: boolean}
   Source: src/domain.ts repriceOrder and src/orders/passive-pricing.ts
   Confirmed or locked orders NEVER reprice. An explicit staff edit can
   refresh an unconfirmed persisted order.

4. should_refresh_pricing
   Input: {order, persistedOrders?, persistedOrderIds?}
   Output: {refresh: boolean}

5. calculate_shipping
   Input: {order: Order, state: State}
   Output: {bundles: ShippingBundle[], total: Price, version: string}
   Source: src/shipping.ts shippingBundles / recommendShipping

6. calculate_shipment_totals
   Input: {state: State, shipmentId: string}
   Output: {subtotal: Price, shipping: Price, vat: Price, total: Price}
   Source: src/workflow.ts shipmentTotals

7. evaluate_workflow
   Input: {state: State, groupId: string}
   Output: {step, nextStep, issues, shipmentsCount, needsNotice, transferred}
   Source: src/workflow.ts groupStep and stageIssues (PARTIAL)

8. validate_workflow
   Input: {state: State, before?: State}
   Output: {valid: true} or error
   Source: src/workflow.ts validateWorkflow (PARTIAL)

9. validate_reception_boundary
   Input: {before: State, state: State}
   Output: {valid: true} or error
   Source: src/orders/reception.ts and native reception.rs (PARTIAL)

10. apply_workflow_action
    Input: {state: State, action: string, now: string, eventId: string,
            ...action-specific fields}
    Output: {state, step} or {state, entries} or {state, unchanged}
    Supported actions:
      advance_group: groupId; stage 1 may need sender;
        stage 3 needs noticeId, paymentMessage, billingSignature
      undo_group: groupId
      set_shipment_freight: shipmentId, origin, value
      process_group: groupId
      record_actual_freight: shipmentId, origin, value

Example calculation (call execute("calculate_price", payload)):

    payload = {
      "order": {
        "recipients": [{"items": [{
          "productId": "p", "variantId": "v",
          "quantity": 2, "unitPrice": 30000
        }]}],
        "shippingFee": 3000, "freightCode": "010",
        "applyVat": true, "pricesLocked": false
      },
      "client": {"id": "dealer", "shippingFeeExcluded": false}
    }

Expected: {"subtotal":60000,"shipping":3000,"vat":6300,"total":69300}

## Intended invariants

- Tier pricing uses the actual independent product variant ID.
- SPECIAL tier uses overrides by variant ID and legacy IDs, then wholesale.
- Values of 0 resolve to unknown unit prices as in the TS baseline.
- A confirmed order retains clientSnapshot, unit prices and locked VAT.
- Customer shipping fee waiver and collect code 020 suppress billed shipping,
  but do not erase shipment charge records.
- Freight recommendations use current explicit group/product tariffs, epoch
  and saved combination versions; an old charge remains on old orders.
- A transferred shipment uses the frozen queue billing snapshot when eligible.
- Workflow actions clone state. No intermediate state is returned on error.
- Existing stages 0-4 and existing Excel statuses are used; no extra stages
  have been introduced.
- Existing event, payment, source and delivery records are append-only,
  subject to the stronger native storage validation.

## BLOCKED / not parity-verified (must not silently claim complete)

1. No compiler or Cargo available in the executor; no Rust tests were run.
2. src/workflow.ts reconcileWorkflow is NOT ported. Session 3 must supply
   reconciled sources/groups/shipments or extend the pure Rust module.
3. Rust stage_issues covers common blockers but does not implement every
   orderIssues, saleIssues, alias conflict, original evidence, and candidate
   resolution branch. DO NOT use it as the only production approval gate yet.
4. Address validation is a conservative string approximation of
   deliveryRequirements.ts, not the same regular expression.
5. Absent shipping state uses seeded amounts but a deterministic fallback
   version string. InitialShipping in TypeScript creates random versions.
   Persisted shipping state must be supplied before production use.
6. Missing workflow actions: recordPayment, confirmGroupPayment,
   setGroupAccount, detachShipment, regroupShipment, restoreShipment,
   completeDelivery, markStoreSent, factory-reply processing.
7. Complete downgrade/recheck event fan-out and partial payment-confirmation
   cancellation are not ported. Unsupported confirmation mutations reject.
8. validate_workflow conservatively rejects some legitimate TS metadata-only
   exported queue changes; exact TS exceptions remain unimplemented.
9. The independent rules validation does NOT replace the stronger native
   src-tauri/src/reception.rs validate_reception. That Rust validator already
   checks immutable receipt, raw corrections, source and shipment references.
10. Stage 3 requires the exact payment text and billing signature from the
    existing host workflow; message generation belongs to session 3.
11. Native Tauri command registration, React calls, TS cleanup, SQLite
    transactions and Windows EXE build belong to session 3.

## Existing native validation / persistence (read-only findings)

src-tauri/src/reception.rs:
  validate_reception(previous,next) rejects incomplete confirmations,
  missing selected products, changed original raw/receipt/snapshot, missing
  correction evidence and disappearance of existing confirmed orders.
  Keep this authoritative validation at the storage boundary.

src-tauri/src/relational_store.rs:
  Persists product and price records, clients, orders/recipients/items in
  SQLite tables with FK relations; verify() checks the stored price rows and
  foreign keys. Rules module must not duplicate the database or alter tables.

src-tauri/Cargo.toml already depends on serde_json = "1".
No additional app-crate dependency is required by the rules code.

## Test project and actual status

Independent Cargo crate:
  tests/rust-migration/rules/Cargo.toml
  tests/rust-migration/rules/src/lib.rs

Compile/test command:
  cargo test --manifest-path tests/rust-migration/rules/Cargo.toml

It imports the real rules/mod.rs by relative path, not a duplicated mock.
Eighteen synthetic Rust regression tests were authored for:
  tier pricing, SPECIAL and legacy overrides;
  VAT, COD and fee waiver;
  invalid price and overflow;
  frozen snapshot pricing;
  passive vs explicit repricing;
  tariff group version and combination epoch;
  missing shipping rule and multiple recipients;
  frozen shipment totals;
  prepaid refusal, postpaid approval and undo;
  explicit freight edit downgrade;
  queue snapshot on processing;
  actual freight event;
  immutable workflow history and duplicate IDs.

RESULT UPDATE: 18/18 Rust independent regression tests PASS in GitHub Actions run 43351968128. TS parity, Tauri integration and Windows EXE remain UNVERIFIED.
TS baseline test source inspected, not executed:
  tests/tauri-confirmed-order-master-freeze.test.mjs
  tests/reception-passive-pricing.test.mjs
  tests/tauri-committed-snapshot.test.mjs

No BASELINE_FAIL or REGRESSION may be inferred without execution.
Windows binary build and app-level integration are also NOT_RUN.

## Integration call sites for session 3 (baseline read-only inspection)

src/orders/useOrderDesk.tsx:
  ~105 reconcileWorkflow
  ~148 repriceOrder
  ~170 / 276 / 323 recommendShipping
  ~241 resolvePrice

src/domain.ts:
  ~130 resolvePrice
  ~409 repriceOrder
  ~467 totals

src/shipping.ts:
  ~109 shippingBundles
  ~246 recommendShipping

src/workflow.ts:
  ~150 shipmentTotals
  ~822 stageIssues
  ~860 advanceGroup
  ~1016 undoGroup
  ~1055 setShipmentFreight
  ~1236 processGroup
  ~1435 validateWorkflow
  ~1639 confirmGroupPayment

src/orders/reception.ts:
  persistedReceptionState and validateReceptionBoundary

Use the existing SQLite transaction layer, and always run native
reception validation in addition to the rules engine. Do not return
or save intermediate states after a failure. Session 3 should connect
Rust operations only after TS parity of the corresponding operation,
with source of truth for receipt and workflow histories kept intact.

## Next work for session 2 continuation

1. Install/use a Rust runner and execute the independent Cargo tests; fix
   all compiler errors within this session's allowed paths.
2. Run identical TS and Rust fixtures. Classify every case as PASS,
   BASELINE_FAIL, REGRESSION, BLOCKED or NOT_RUN, with logs.
3. Complete all workflow issue branches and payment-confirmation audit
   semantics before enabling Rust approval decisions.
4. Cover STORE and FACTORY mixed shipments, overridden VAT, postpaid,
   master tariff changes and full order snapshot preservation.
5. Re-run regression suite and commit corrections only on migration/02-rules.

## 2026-11-13 CI implementation update

- Fixed earlier workflow borrow conflicts in existing agent commit `5e7713d958c84911b49244a9ab4cf75ad8e27d01`.
- Remaining compile error fixed at `3f68c89be8a0bb6c8d6b7f1611937e48a244fe5c`: `field(&shipment_totals(state, ...)?,"total")` borrows temporary JSON for the expected `&Value` argument.
- GitHub Actions: https://github.com/ThunderStrikerKR/TSBH/actions/runs/43351968128
- Result: standalone rules crate compiles, 18 passed / 0 failed; Windows integration job is skipped for this standalone branch by design.
- This result does NOT establish parity for all TypeScript workflows, nor final Tauri/Windows readiness. Session 3 must retain those gates.
