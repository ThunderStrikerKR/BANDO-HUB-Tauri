# TSBH Rust migration — session 2/3: Price, freight and workflow rules

## Session 2 continuation: workflowIssues and stageIssues differential parity — 2026-11-13

**Implementation and verified source checkpoint**
- Branch: `migration/02-rules`
- Verified implementation SHA: `dbd2bf9aa19b0d26f7e946877e278fbab6146d18`
- GitHub Actions: https://github.com/ThunderStrikerKR/TSBH/actions/runs/43366482425
- **TypeScript original against actual Rust: 240/240 named fixtures PASS, 0 mismatches**
- **Standalone Rust regression: 47/47 PASS**
- **Windows Tauri/SQLite integration: SKIPPED on this branch**
- No source writes outside the session-2 owned directories or test fixtures.

### Source functionality transferred

- `src-tauri/src/business_core/rules/workflow_issues.rs` is a new
  pure-Rust projection of `src/workflow.ts::workflowIssues` and `stageIssues`.
- The `workflow_issues` action returns the **full issue object array**, not
  merely titles. Includes typed field/recipient/item evidence, original
  issue IDs and group ownership, sales status blockers and historical
  split-product price references, sender requirements, active item/variant
  checks, invalid origin, conditional freight blockers, retail-specific
  exclusions, chosen account and updated-notice issues.
- The `stage_issues` action returns original ordered, deduplicated blocker
  strings at the requested stage, combining projected workflow issues,
  shipment totals, prior freight application, account notice, prepaid
  payment deficit and per-shipment sales status.
- The existing `evaluate_workflow` and `advance_group` functions now use
  this same stage blocker projection instead of the earlier partial helper.
  Neither a React caller nor a Tauri command binding was changed.
- Supports normal and deleted/superseded product status, single-price-record
  historical mapping, invalid/unknown variant, frozen confirmation handling,
  manual and preferred/brand account selection, retail fallback, multiple
  shipping origins, legacy confirmed orders, multiple recipients and
  partially paid or rechecked prepaid orders.

### Differences found by actual differential execution and corrected

1. **Prepaid recheck**: Old Rust stage validation counted a confirmation that
   TypeScript invalidates with `입금 승인 재확인 필요`. The shared
   `payment_due` helper now excludes those confirmations by event ID and
   shipment before determining stage-4 eligibility.
2. **Retail with no linked dealer/client snapshot**: original `orderParty`
   supplies the default company client; Rust stage checking now tolerates
   this valid input rather than failing with a missing-dealer error.
3. **Unpriced prepaid shipment**: original text is `입금 부족 확인 필요`
   when the payable total is null; Rust now preserves this exact text.
4. **Missing both recipient phone numbers**: original title is
   `연락처가 없습니다` without final punctuation; the shared
   `orderIssues` projection was fixed to match exactly.
5. **Explicit sender phone with whitespace**: original
   `explicitSender` recognizes separated digit blocks; Rust now handles
   prefixes `010`, `02`, `050x`, regional codes and split groups with
   whitespace, parentheses, periods and hyphens. The stage sender
   requirement compares equal for tested full-width colons and spaced input.

### Differential test coverage

Original TS `workflowIssues` and `stageIssues` are executed directly from
`tests/rust-migration/rules/parity/compare.mts` on the SAME structured
JSON input as the compiled Rust `json_rules` binary. Fixtures include:

- Baseline/empty/broken recipient, candidate and confirmation evidence
- Sender missing, explicit sender/phone, account missing/manual/brand
- Product unknown, missing variant, deleted, frozen and sale status
- Historical product mappings including mismatches
- Mixed shipping origins, collect freight and missing charge
- PREPAID, POSTPAID, partial payment, confirmed and invalidated payment
- Retail with/without snapshot, grouped multi-recipient and confirmed order
- Different stage transition thresholds 1, 2, 3 and 4

**240/240 PASS is a corpus-specific result, not proof of all possible
inputs or all TypeScript functions.** Remaining blockers outside this task
include `applyOrderRawEdit`, `migrateWorkflow`, some complete
`validateWorkflow` and `validateReceptionBoundary` conditions, arbitrary
sender raw-line parsing, unusual JSON key ordering in evidence, and all
Tauri/SQLite/Windows integration. Session 3 must retain authoritative
receipt validation and avoid switching production approvals to Rust until
integration and all remaining validation branches are proven.

---

## Session 2 continuation: order decisions, guarded deletion and shipping upgrade — 2026-11-13

**Most recent actual source verification**
- Branch: `migration/02-rules`
- Implementation/test-source commit: `8b913a9e647a79e3be72241077933177a8060e15`
- GitHub Actions: https://github.com/ThunderStrikerKR/TSBH/actions/runs/43364642796
- **Previous checkpoint: 46/46 named differential fixtures PASS (superseded by 240/240 above)**
- **Independent Rust regression: 47/47 PASS, 0 failed**
- **Windows Tauri integration: SKIPPED by branch CI policy**
- This is named-case parity ONLY; **session 2 is INCOMPLETE**.
  No Tauri/SQLite business-rule caller has been switched.

New or expanded session-2 owned implementation:
1. `src-tauri/src/business_core/rules/issues.rs` adds `order_issues`
   matching the original `validation.ts::orderIssues` result shape:
   issue title, stage, severity, recipient/item, customer questions,
   source-span, actor, evidence and staff decision. Reconciliation
   now reuses the projected issues for historical decision sync.
2. `apply_issue_action` implements `approve_missing_quantity`
   and `pending_issue`, including source-specific rejection conditions
   and staff/customer decision evidence.
3. `src-tauri/src/business_core/rules/order_mutations.rs` adds
   `delete_order`, with original ordinary-delete restrictions,
   queued-export cancellation, soft deletion, recheck events and group
   notice changes. The pure function receives deterministic
   `now`, `eventId` and ordered `eventIds`.
4. `apply_shipping_action` adds `upgrade`:
   six legacy groups are appended only when absent; historical tariffs
   and groups remain intact. The caller injects versions and time.
5. The parity corpus has grown from 27 to **46 original-TS comparisons**:
   complete issue records, missing address/name/quantity/color, legacy
   alias and staff decisions, rejection paths, order deletion including
   two audit events, tariff upgrade and idempotence.
6. Known differences fixed using actual TS results:
   serialized match discriminator appears first in the evidence string;
   JavaScript `Date.toISOString()` uses UTC Z representation.

**Outstanding work in this session, by priority**
- Finish all `workflowIssues` and `stageIssues` branches, `saleIssues`,
  the entire `validateWorkflow`/`validateReceptionBoundary` guard set,
  and exact address/contact/receipt/evidence checks.
- Implement `applyOrderRawEdit` (using recognition output supplied by
  session 1, without rewriting its parser) and `migrateWorkflow`.
- Compare partial payment-confirmation cancellation, account changes,
  post-delivery/queued-export exceptions, audit/recheck fan-out.
- Verify explicit-sender extraction from order raw text and
  exact historical billing/account signature serialization.
- Session 3 alone owns Tauri command/React/SQLite integration and Windows
  app execution. Retain native `reception.rs` as authoritative.

**Critical limitation**: 46 matching fixtures are not exhaustive
TypeScript equivalence; no production Rust approval gate can replace the
existing TS behavior until untested paths and native integration pass.

---

## TypeScript-vs-Rust differential comparison — executed 2026-11-13 KST

**Verified**: actual original TypeScript business functions and the compiled
Rust `rules::execute` runner received the same JSON fixtures on a GitHub
Actions Ubuntu runner. The Rust integration test
`tests/rust-migration/rules/tests/ts_parity.rs` installs dependencies with
`npm ci --ignore-scripts --no-audit --no-fund`, runs original sources via
`node --import tsx` and the Rust `json_rules` binary, and compares success,
errors, numeric values, JSON fields, and snapshots recursively.

**Previous checkpoint: 27 / 27 PARITY PASS, 0 mismatches (superseded by 46 / 46 above).**
**Independent Rust regression at that previous checkpoint: 47 / 47 PASS.**
GitHub Actions run:
https://github.com/ThunderStrikerKR/TSBH/actions/runs/43360550428
Source commit tested: `88db940d02660882842443890e0873ffabaa2a05`.

Actual failing baseline runs and fixes:
- 17-case suite initially **16 PASS / 1 FAIL**, with
  `reconcileWorkflow` missing `issueResolutions` and TS-only
  `undefined` key incorrectly compared across the JSON boundary.
  Fixed by preserving the decision map and JSON-roundtripping TS results.
  Subsequent run **17 PASS / 0 FAIL**:
  https://github.com/ThunderStrikerKR/TSBH/actions/runs/43359910058
- Expanded to 27 cases and obtained **24 PASS / 3 FAIL**:
  negative quantity freight reason;
  missing recipient-name decision evidence;
  obsolete issue decision not marked resolved.
  TypeScript original results were used as the reference.
- Fixed shipping negative quantity parity and added
  `src-tauri/src/business_core/rules/issues.rs` for order issue
  decision synchronization (current evidence, stale decision closure,
  option/model/quantity/contact candidates). An intermediate Rust test
  exposed a UTF-8 slicing panic on Korean product names; removed the
  faulty helper. **27 PASS / 0 FAIL** now confirmed in the link above.

**Important scope qualification**: The 27 fixtures cover price/VAT,
tier overrides, combinations/epochs, tariff rules, shipping recipients and
origins, frozen snapshots, selected workflow validation errors, and
selected reconciliation issue-decision paths. They do **not** cover
all TypeScript workflows, arbitrary recognition candidates,
sender-raw parsing, complete factory reply flows, every event history
variant, or real Tauri/SQLite/Windows integration. Overall session-2
migration remains **INCOMPLETE**; do not replace the TS production
approval gate solely on these results.

The exact executable comparison is now part of the branch's actual
Cargo test run, not a test file waiting to be executed. Local manual
invocation after npm install:
`node --import tsx tests/rust-migration/rules/parity/compare.mts`.

**Caveats for extending the corpus**: Rust JSON maps may reorder object
keys before storing strings that represent `JSON.stringify` evidence;
source-span, candidate-match and historical issue payloads need additional
differential coverage. The Rust issue synchronization is not a substitute
for the full `orderIssues` and `workflowIssues` implementations or their
display-level issue objects.

---

## Current continuation checkpoint — 2026-11-13

**Latest CI status:** 47 / 47 independent Rust tests passed, 0 failed, source
commit `a9aabdb6e5eb730f4a4c9372045c41e39fecd3b4`.
GitHub Actions: https://github.com/ThunderStrikerKR/TSBH/actions/runs/43358837376
Integrated Tauri Windows job: SKIPPED. This is Rust implementation coverage,
**not** direct TypeScript parity.

New session-2 owned files and changes:
- `src-tauri/src/business_core/rules/reconciliation.rs`:
  `reconcile_workflow` JSON operation for stable source/group/shipment
  registration; draft merge; client-change audit guard; tariff and item
  signature drift; charge updates; stage downgrade, audit recheck and
  confirmation-warning events; removed-recipient history preservation.
  Caller injects `now` and a sufficiently long `eventIds` array.
- `src-tauri/src/business_core/rules/workflow.rs`:
  `detach_shipment` (input `newGroupId`) and `regroup_shipment` (input
  `targetGroupId`, `ack`) with source/client/account/stage/transfer guards,
  preserved historical notices, explicit audit evidence. Existing public
  workflow helper `account_for` is reused by the reconciliation module.
- `src-tauri/src/business_core/rules/shipping.rs`:
  `apply_shipping_action` supports `save_combination`, `delete_group`,
  `change_basis`, `editable_rule`, `combination_versions`,
  `combination_current`. Caller supplies generated IDs and timestamps.
- `src-tauri/src/business_core/rules/validation.rs`:
  matches TS historical confirmation cancellation exceptions for pre-approval
  shipments; separately rejects duplicate confirmation IDs; checks original
  actual-freight evidence; permits the narrowly evidenced exported-file
  metadata change and pre-delivery print disposal while retaining frozen
  snapshot constraints.
- `tests/rust-migration/rules/src/lib.rs`: 16 additional synthetic fixtures
  for group changes, tariff lifecycle, audit exceptions, reconciliation
  lifecycle and preservation of financial evidence.
- `tests/rust-migration/rules/src/bin/json_rules.rs`: Rust JSON Lines CLI
  that executes the actual `rules::execute` function.
- `tests/rust-migration/rules/parity/compare.mts`: a differential harness
  that imports the **original** `src/domain.ts`, `src/shipping.ts` and
  `src/workflow.ts`, executes the real Rust CLI on the same synthetic
  fixtures, compares structured success and errors, and exits nonzero
  on mismatches.

Differential harness invocation from repository root when Cargo, Node and
the repository's npm dependencies are installed:

    npx tsx tests/rust-migration/rules/parity/compare.mts

**Superseded checkpoint:** The TypeScript differential harness has since been
executed under the Cargo test integration runner; see the 27/27 PASS
section above. This older unexecuted-harness checkpoint is retained only
for historical chronology.

**Known parity gaps and blockers still open:**
1. `reconcile_workflow` does not yet faithfully execute
   `synchronizeIssueDecisions` and `orderIssues` for every candidate,
   item and customer decision. It also does not parse explicit sender
   information from original order raw text as `explicitSender` does.
   Its billing signature comparison should be checked against the TS
   serializer and actual persisted snapshots.
2. Full `workflowIssues` and `stageIssues` are NOT ported for all
   branches; native Rust approval-gating must not use this port alone.
   The delivery address/contact checks use approximations rather than
   the exact TS parser.
3. `applyOrderRawEdit`, `deleteOrder`, `migrateWorkflow`, all auxiliary
   issue-decision operations, and `upgradeShipping` remain outside
   implemented Rust actions. Factory reply ingestion and match conflict
   handling belong to session 3 coordination.
4. `undoGroup`, `completeDelivery`, payment and notification exceptional
   paths still require direct TS differential tests, including partial
   cancellations and transferred shipment revalidation.
5. `reconcile_workflow` is **not automatically invoked** from existing
   Rust action routes. Session 3 must establish atomic order of calls
   only after TS parity is confirmed. Do not assume it is wired to the app.
6. `shipping::initial_shipping` has stable placeholder versions rather
   than TS random IDs; persisted shipping data must be supplied for
   production parity.
7. The Rust JSON adapter and TS harness are authored but **not executed
   together**. TypeScript output parity is NOT_RUN, Windows native
   integration is NOT_RUN, app UI and SQLite wiring is NOT_RUN.
8. The branch contains the same out-of-scope CI workflow file committed
   by another concurrent writer as previously documented. Session 2
   did not modify that CI file.

Classification (current): **Rust standalone PASS**, **27/27 named TS
fixture parity PASS**, **full TypeScript feature parity UNVERIFIED**,
**Windows integration SKIPPED**, **overall migration INCOMPLETE**.
Do not merge these rules as a replacement for the full TypeScript authority
until differential failures are closed.

---


Date: 2026-11-13 KST
Repository: ThunderStrikerKR/TSBH
Branch: migration/02-rules (created at d5ea8ed20b8120b844437263c2eb2b8963559e8d)
Last implementation/test-source commit before this document: 0a168943b78390f5c97e0a7f335860add0d35db1
Prior independent Cargo checkpoint: 0a168943b78390f5c97e0a7f335860add0d35db1 (31/31 PASS; superseded by current continuation checkpoint above)

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

9. evaluate_dispatch_state
   Input: {state: State, orderId: string}
   Output: {status: "처리 중" | "처리 완료"}
   Source: src/factory-replies.ts dispatchState

10. validate_reception_boundary
   Input: {before: State, state: State}
   Output: {valid: true} or error
   Source: src/orders/reception.ts and native reception.rs (PARTIAL)

11. apply_workflow_action
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
      record_payment: groupId, paymentId, allocationIds, allocations,
        paidAmount, paidAt, optional memo
      confirm_group_payment: groupId, confirmationId
      restore_shipment: shipmentId
      mark_store_sent: queueId
      record_change_request: shipmentId, changeRequestId, text
      set_group_account: groupId, accountId? (AUTO if omitted)
      complete_delivery: shipmentId, actual by origin, combinationIds,
        deliveryIds; rejects QUEUED or fileOnly EXPORTED entries

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

1. The direct executor has no Rust/Cargo or local Git worktree, but the remote branch's GitHub Actions Rust runner successfully compiled and executed 28/28 standalone tests. Native Tauri Windows integration remains NOT_RUN.
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
6. Missing workflow operations still include detachShipment, regroupShipment,
   and factory-reply row matching/application. Rust complete_delivery now
   records verified combinations and delivery evidence, but requires further
   TS parity testing before integration. The pure Rust
   engine now provides record_payment, confirm_group_payment,
   set_group_account, restore_shipment, mark_store_sent,
   record_change_request and evaluate_dispatch_state, but TS parity for
   those new paths is not established by the standalone synthetic tests.
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
Thirty-one synthetic Rust regression tests were authored for:
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

LATEST RESULT: 31/31 Rust independent regression tests PASS in GitHub Actions run 43354719292 (verified source commit 0a168943b78390f5c97e0a7f335860add0d35db1). TS parity, native Tauri/SQLite integration and Windows EXE remain NOT_RUN/UNVERIFIED.
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

1. Continue the successful GitHub Actions isolated Rust tests for every new
   session-2 commit and resolve any regression within owned files.
2. Run identical TS and Rust fixtures. Classify every case as PASS,
   BASELINE_FAIL, REGRESSION, BLOCKED or NOT_RUN, with logs.
3. Complete all workflow issue branches and payment-confirmation audit
   semantics before enabling Rust approval decisions.
4. Extend the now-passing STORE/FACTORY mixed-shipment and product-tariff
   fixtures to exact TS parity, alternate VAT, complex payment allocation
   and historical orders.
5. Re-run regression suite and commit corrections only on migration/02-rules.

## 2026-11-13 CI implementation update

- Fixed earlier workflow borrow conflicts in existing agent commit `5e7713d958c84911b49244a9ab4cf75ad8e27d01`.
- Remaining compile error fixed at `3f68c89be8a0bb6c8d6b7f1611937e48a244fe5c`: `field(&shipment_totals(state, ...)?,"total")` borrows temporary JSON for the expected `&Value` argument.
- GitHub Actions: https://github.com/ThunderStrikerKR/TSBH/actions/runs/43351968128
- Result: standalone rules crate compiles, 18 passed / 0 failed; Windows integration job is skipped for this standalone branch by design.
- This result does NOT establish parity for all TypeScript workflows, nor final Tauri/Windows readiness. Session 3 must retain those gates.

## Final remote verification and cross-session boundary notes (2026-11-13)

- Session 2 final independent Rust test fixture checkpoint: commit `0a168943b78390f5c97e0a7f335860add0d35db1`.
- GitHub Actions Rust (Ubuntu Stable) run: https://github.com/ThunderStrikerKR/TSBH/actions/runs/43354719292
- **PASS: 31 tests / 0 failed**. This verifies syntax, compilation, and the authored fixture expectations, **not exhaustive TypeScript parity**.
- Later tests added: actual payment record, prepaid confirmation with audit allocation, group account change with preserved confirmation and recheck events, store queue transition, queued Excel handoff restore, separate actual freight event, post-delivery change request, origin-completion assessment, STORE/FACTORY mixed bundle shipping, product-specific freight, and safe overflow rejection.
- **BASELINE_FAIL: no baseline executed; REGRESSION: not established; BLOCKED: unreconciled workflow, full approval issue parity, confirm-revocation edge cases, account/freight special cases, completeDelivery parity and TS snapshot exceptions; NOT_RUN: TypeScript output parity and Windows Tauri/SQLite integration**.
- This branch additionally contains `.github/workflows/rust-migration-ci.yml` from separate concurrent writer commit `51776244a413f8adbf9d70118de3f4205f4130b6`. Session 2 neither authored nor edited this out-of-scope path, and cannot safely erase concurrent changes under the ownership contract. Session 3 must inspect this unexpected out-of-scope branch addition before merging.
- Session 3 should **not enable Rust approval-gating as the sole authority** until stage issues and workflow history parity are completed and the native Rust reception validator has remained in the SQLite transaction pipeline.

## Delivery finalization checkpoint

- Ported TS workflow.ts completeDelivery as pure action `complete_delivery`, using explicit `now`, `eventId`, `combinationIds` and `deliveryIds` rather than global UUID or clock. It validates transferred state, rejects queued/unconfirmed factory output, requires per-origin actual freight, freezes shipment delivery evidence and records verified tariff combinations with observed charges. It never overwrites existing queue billing snapshots.
- CI regression tests cover one successful finalized FACTORY delivery plus QUEUED and fileOnly rejection. These tests passed in run 43354364403; production parity (sample-counts, historical assignment/version and SQLite transactions) remains BLOCKED until session 3 verification.

## Freight change and payment-approval audit correction

- `set_shipment_freight` now performs the same audit sequence on a previously advanced shipment as the TypeScript `downgrade` path: keep any prior confirmation record, append `입금 승인 재확인 필요` event when applicable, append `재검증 필요`, lower shipment step to 1, mark account notice as required when previously past step 2, and finally append `배송 건 운임 수정`.
- Generated internal audit event IDs derive deterministically from the caller's required `eventId` and shipment/confirmation IDs, preserving uniqueness without an implicit clock or global UUID.
- Source/test checkpoint `0a168943b78390f5c97e0a7f335860add0d35db1`: 31/31 PASS GitHub Actions Ubuntu; this is still not complete TypeScript parity.
