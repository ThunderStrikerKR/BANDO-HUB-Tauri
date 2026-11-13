# TSBH Rust migration — session 2/3: Price, freight and workflow rules

## Session 2: direct source parity for all 14 workflow actions — 2026-11-13

**Latest verified checkpoint (supersedes the older audit statement that these 14 actions lack direct TS comparison)**
- Branch: `migration/02-rules`
- Implementation and test fixture SHA: `8673288dd08306e6bf1a302111d3a15d51e80211`
- GitHub Actions: https://github.com/ThunderStrikerKR/TSBH/actions/runs/43385251793
- **Real TypeScript vs compiled Rust: 528 / 528 named cases PASS, 0 mismatches**
- **50 newly added direct workflow-action comparison cases**, across **all 14** original mutation functions. Previous checkpoint: 478 / 478.
- **Standalone Rust regression: 47 / 47 PASS**.
- **Windows/Tauri/SQLite integrated job: SKIPPED**.
- All modifications confined to session-2 `workflow.rs`, parity
  `compare.mts` and this handoff. No TypeScript original, React,
  recognition algorithm, SQLite schema or Tauri wiring was edited.

### Original source operations now directly exercised

Rust `execute("apply_workflow_action",{state,action,...})` compared to
the actual TypeScript functions:

| Rust action | Original TypeScript | Direct scenarios |
| --- | --- | --- |
| `advance_group` | `advanceGroup` | stage 0->1, 1->2, 2->3 and 3->4, blocked prepaid jump, transferred guard |
| `undo_group` | `undoGroup` | stage rollback, stage 4, confirmed PREPAID approval cancellation, transferred guard |
| `set_shipment_freight` | `setShipmentFreight` | ordinary edit, previously notified downgrade, transferred guard |
| `process_group` | `processGroup` | valid Excel queue conversion, not-ready refusal, already transferred |
| `record_actual_freight` | `recordActualFreight` | new observation, unchanged value/no event, invalid amount |
| `confirm_group_payment` | `confirmGroupPayment` | successful prepaid confirmation, missing prior notice |
| `record_payment` | `recordPayment` | valid entry and allocation, zero, duplicate/overallocated/missing-time refusal |
| `restore_shipment` | `restoreShipment` | queued restore, not-transferred and already-exported refusal |
| `mark_store_sent` | `markStoreSent` | queued store, historically exported store with valid export link, wrong origin and missing export link |
| `record_change_request` | `recordChangeRequest` | append-only request, blank text and missing shipment refusal |
| `set_group_account` | `setGroupAccount` | valid change, after-notice downgrade, unknown account refusal |
| `detach_shipment` | `detachShipment` | split multi-recipient group, preserve prior notice, already independent refusal |
| `regroup_shipment` | `regroupShipment` | same-source regrouping, required notice acknowledgment, identical-group refusal |
| `complete_delivery` | `completeDelivery` | actual delivery, repeat/no-op, pre-transfer, queued export and fileOnly refusal |

The harness freezes `Date` and `crypto.randomUUID`, builds the exact
same initialized State for both implementations, separately requires
expected success or failure for each fixture, and compares the **entire
returned State** including receipts, payment allocations, frozen Excel
snapshots, recheck records and ordered audit events. Rust-only adapter
metadata (`step`, `paymentId`, `changeRequestId`, etc.) is excluded
from the State comparison; TypeScript operations only return State.
For blocked cases, **exact original Korean error text** is compared.

### Source differences found and corrected

1. `workflow.rs::append_event` previously serialized absent optional
   `before`, `after` or `groupId` fields as null; original TypeScript
   serializes undefined event parameters as absent keys. Now matches
   original event schemas by action and includes original undo reason.
2. Stage-1 `advanceGroup` must set a shipment sender from
   `senderFor(order,state)`, not just copy a possibly missing
   `order.senderSnapshot`.
3. Stage-2 `advanceGroup` must resolve eligible historical
   `rechecks` and save `appliedEpoch` / `appliedBundles` when the
   shipment's freight basis is still current, besides saving manual
   charges and `confirmedFreightVersion`.
4. `undoGroup` after a PREPAID stage-4 confirmation must revoke only
   non-invalidated confirmations for affected shipment IDs; partial
   confirmations retain unaffected allocations, amounts and IDs.
   The old unconditional rejection when any confirmation existed
   was incorrect.
5. Financial downgrade events caused by updated freight/account
   need the exact *original chronology* and caller-generated
   `auditEventIds`. Source `입금 승인 재확인 필요` omits its after
   field; `재검증 필요` includes the stage transition. Rust now
   accepts injected IDs for the audit sequence, with the legacy
   deterministic-ID fallback retained for old callers.
6. `record_change_request` now returns original missing-shipment
   error instead of the lower-level lookup error.
7. A stage-3 action can require reconciliation of the recipient's
   newly confirmed `shippingCharges` into `recipientSnapshot`.
   Unconditionally reconciling every Rust action broke 11 existing
   standalone tests that do not provide reconciliation event IDs;
   that change was **reverted**. Rust performs source reconciliation
   when the caller explicitly provides `reconcileEventIds`.
   The original TypeScript calls reconcileWorkflow internally for
   most mutation actions, while `recordActualFreight`,
   `markStoreSent` and `recordChangeRequest` directly clone input
   without reconciliation. **Session 3 must enforce this workflow
   boundary contract for every call.**

### Rust integration contract for session 3

All 14 actions remain pure in-memory transformations with explicit
`state`, `action`, `now`, `actor`, `eventId` and their
action-specific parameters. No implicit clock, DB access or
cryptographic UUID generator is used by Rust.

- If the source action internally calls `reconcileWorkflow`, either
  feed a pre-reconciled State with frozen signatures **and verify it
  cannot produce new reconciliation changes**, or provide the
  `reconcileEventIds` key (ordered list, possibly empty) to let
  the action run native reconciliation. Without this key, the
  Rust adapter retains the older caller contract and does not
  automatically reconcile.
- For advanced freight/account changes, provide `auditEventIds`
  ordered like the original emitted recheck/confirmation-invalidating
  events and a distinct `eventId` for the final staff action.
- For `advance_group` at stage 3, the current Rust adapter takes
  `noticeId`, exact `paymentMessage` and `billingSignature`
  as host parameters. It does **not** itself implement the original
  `groupMessages`/invoice message renderer; this belongs to
  session 3 integration and must be source-equivalent.
- For `advance_group` on initial reception step 1, pass the proper
  `sender` when the caller wants the original saved confirmation
  snapshot. Stage 2 may require original tariff-adjustment creation
  when staff-confirmed freight differs from a current recommendation;
  this **adjustment mismatch path was not covered** in the 50
  action fixtures and must be checked before using as production
  audit evidence.
- For `record_payment`, source UUID order is payment ID,
  allocation IDs, then event ID; for PREPAID
  `confirm_group_payment` it is confirmation ID then
  advancement event ID; for group detach, new group ID then
  event ID. Preserve this order and use exactly one atomic DB
  transaction when integrating.

### Remaining limits and stop conditions

**528/528 is verified for the synthetic fixture corpus, not an
exhaustive equivalence proof.** Uncovered cases include complex
multi-confirmation partial invalidation, current-tariff override
adjustment snapshots, multiple shipment groups with independent
simultaneous financial changes, arbitrary JSON property insertion
order, and multiple generated reconcile/audit UUIDs in one
transaction. Do not represent this as all Rust migration functions
complete or Windows/production ready.

The earlier **function inventory audit** below recorded the historical
state where no workflow actions had been directly compared. That
particular finding is now resolved. Its other missing module coverage
items (`group-trash.ts`, `corrections.ts`, `working-raw.ts`,
`orders/retail.ts`, etc.) remain unresolved.

---

## Session 2 function inventory and cross-module gap audit — 2026-11-13

**Verdict: SECURITY_LIMITED / INCOMPLETE; no session-2 final PASS.**

Audited actual GitHub branch `migration/02-rules` at
`54511a1dd7ab540f70249b13ae477027e45ce633` against the unchanged
TypeScript source baseline
`d5ea8ed20b8120b844437263c2eb2b8963559e8d`. The most recent
passing isolated CI run was
https://github.com/ThunderStrikerKR/TSBH/actions/runs/43380248456.
It verifies **478/478 direct TS/Rust named examples and 47/47
Rust-only unit tests**, but is **not** a complete function inventory
coverage claim. Windows/Tauri/SQLite integration is skipped.

Source scope discovery was expanded beyond only `src/workflow.ts` and
`src/shipping.ts` by inspecting the original recursive repository
tree (720 entries; not truncated) and separately reading
`src/orders/reception.ts`, `src/orders/retail.ts`,
`src/group-trash.ts`, `src/corrections.ts`, `src/working-raw.ts`,
`src/receipt.ts`, `src/replies.ts`, `src/issue-actions.ts`,
`src/factory-replies.ts`, `src/actual-freight.ts`,
`src/orders/passive-pricing.ts`, `src/order-types.ts`,
`src/sale-status.ts`, and other supporting business modules.

### Category A: Implemented and exercised against original TypeScript

The `tests/rust-migration/rules/parity/compare.mts` program actually
imports and executes TypeScript functions for these 15 of the 20
top-level operations exposed by Rust `execute`:

| Rust operation | Original TypeScript source |
| --- | --- |
| `calculate_price` | `domain.ts::totals` |
| `resolve_unit_price` | `domain.ts::resolvePrice` |
| `calculate_shipping` | `shipping.ts::recommendShipping` |
| `calculate_shipment_totals` | `workflow.ts::shipmentTotals` |
| `apply_shipping_action` (partial action set) | `shipping.ts`: `upgradeShipping`, `editableShippingRule`, `combinationVersions`, `combinationCurrent`, `saveCombination` |
| `reconcile_workflow` | `workflow.ts::reconcileWorkflow` |
| `workflow_issues` | `workflow.ts::workflowIssues` |
| `stage_issues` | `workflow.ts::stageIssues` |
| `order_issues` | `validation.ts::orderIssues` |
| `apply_issue_action` | `validation.ts::approveMissingQuantity` and `pendingIssue` |
| `delete_order` | `workflow.ts::deleteOrder` |
| `apply_order_raw_edit` | `workflow.ts::applyOrderRawEdit` (original TS parser output injected) |
| `migrate_workflow` | `workflow.ts::migrateWorkflow` |
| `validate_workflow` | `workflow.ts::validateWorkflow` |
| `validate_reception_boundary` | `orders/reception.ts::validateReceptionBoundary` |

**LIMIT:** "tested against TS" means selected structured inputs,
not every branch, arbitrary evidence ordering or all possible state.
The `apply_shipping_action` envelope has seven Rust actions but the
direct corpus does not cover `delete_group` or `change_basis`.

### Category B: Implemented, but NO direct TS/Rust differential
for their standalone operation

| Rust operation or sub-action | Original TypeScript comparison missing |
| --- | --- |
| `reprice_order` | `domain.ts::repriceOrder`, combined with persisted/explicit edit policy |
| `should_refresh_pricing` | `orders/passive-pricing.ts::shouldRefreshUncommittedOrderPricing` |
| `evaluate_workflow` | `workflow.ts::groupStep` and stage/evaluation summary |
| `evaluate_dispatch_state` | `factory-replies.ts::dispatchState` |
| `apply_workflow_action` | all **14** source mutation actions listed below |
| `apply_shipping_action: delete_group` | `shipping.ts::deleteShippingGroup` |
| `apply_shipping_action: change_basis` | `shipping.ts::changeShippingBasis` |

All **14** supported `apply_workflow_action` names were inspected
in `workflow.rs`:
`advance_group`, `undo_group`, `set_shipment_freight`,
`process_group`, `record_actual_freight`,
`confirm_group_payment`, `record_payment`,
`restore_shipment`, `mark_store_sent`,
`record_change_request`, `set_group_account`,
`detach_shipment`, `regroup_shipment`, `complete_delivery`.

The direct TypeScript parity script contains **zero**
`apply_workflow_action` invocations and does not invoke the original
`advanceGroup`, `undoGroup`, `setShipmentFreight`,
`confirmGroupPayment`, `recordPayment`, `completeDelivery`, etc.
Rust-only regression tests do invoke each sub-action at least once,
but cannot prove exact TypeScript State, billing snapshot, event
order, generated UUID sequence or error priority. Do **not** promote
these to direct parity PASS based on the independent 47 tests.

### Category C: Original TypeScript exports without a complete Rust
operation in the current session-2 rules boundary

**Confirmed missing workflow-related state mutations**
- `src/group-trash.ts`: `deleteGroup` and `restoreGroup`,
  including soft-delete constraints and audit events. The existing
  Rust `delete_order` deletes an ORDER, not a GROUP; the tariff
  `delete_group` deletes a SHIPPING GROUP. Neither is a substitute.
- `src/corrections.ts`: `requestCorrection`,
  `copiedCorrection`, `confirmCorrection`,
  `markFactoryDelivered`, `markCollected` and
  `reopenUnsentExport`. `record_change_request` and
  `restore_shipment` cover other narrower actions, not these
  structured correction, handoff and collection flows.
- `src/working-raw.ts`: `rawCorrectionAllowed`,
  `rawCorrectableIssue` and `correctWorkingRaw`.
  `apply_order_raw_edit` supplies a lower-level primitive, not the
  before/after `analysisRaw`, eligibility and `rawCorrections`
  orchestration.
- `src/receipt.ts`: `correctReceipt`
  (reason, receipt fallback, and correction audit). The generic
  raw edit primitive does not add the original
  `rawCorrections` record.
- `src/orders/reception.ts`:
  `newReception`, `replaceReception` and
  `persistedReceptionState` (do not persist unsaved drafts or
  their transient sources, groups, shipments and events).
  `validateReceptionBoundary` **is** ported, but is not a
  replacement for draft filtering.
- `src/orders/retail.ts`:
  `newRetailOrder` and especially `confirmRetail` (retail
  source/confirmation snapshot, step 4, event and `processGroup`).
  Retail boundary validation **is** ported; retail confirmation
  mutation is not.
- `src/replies.ts`: `billingSnapshot`,
  `proposeReply` and `applyReply`, with billing history and
  reapproval requirements; parser/proposal crosses into session 1,
  but applying the state change is still a business-rule handoff.
- `src/issue-actions.ts`: `resolveProduct` and
  `confirmProposedProduct`. These interact with recognition,
  alias persistence, default-model/color rules and customer confirmation,
  so coordinate ownership with session 1 before porting.
- `src/factory-replies.ts`: `replyNeedsReview` and
  `connectFactoryReply`, plus `trackingMessage`. These originate
  from factory Excel reply/import and message output, so coordinate
  ownership with session 3 rather than expanding session 2
  into workbook parsing/UI.
- `src/domain.ts`: `reviewIssues` and legacy `canQueue`
  are not standalone Rust operations. Current workflow issue
  projections are not proof of the legacy public helper's full
  output. `messages` and `workflow.ts::groupMessages` belong
  to session-3 messaging output; product matching/normalization
  exported from `domain.ts` belongs to session 1.
- `src/shipping.ts`: `bundleCounts` is a minor UI rule
  with no independent Rust operation. `initialShipping` is only
  a **deterministic fallback approximation** in Rust: original
  TypeScript generates real random rule version IDs and timestamps.
  Preserve persisted shipping state or inject equivalent IDs/time
  before claiming exact parity on newly initialized state.

**Implemented inside other Rust functions, but not independently
proven:** `workflow.ts::clientChangeIssue` has an **inline guard**
in `reconciliation.rs` using the original rejection text;
it is not wholly missing. Its direct isolated comparison is missing.
Similarly `orderInformationIssues`, `paymentBalance`,
`groupTotals`, `groupAccount`, `shipmentVat`, `roundVat`,
`senderFor`, `saleIssues` and `synchronizeIssueDecisions`
are represented partly through composite Rust routes. Composite
test success alone does not prove each helper across all inputs.

### Category D: Known risk even inside directly exercised routes

- Original TypeScript `JSON.stringify` preserves significant
  object insertion order in several historical strings and
  snapshots. Plain Rust `serde_json::Value` equality uses unordered
  object semantics, and not all arbitrary evidence key orders have
  been tested.
- `explicitSender` is a JavaScript regular-expression parser;
  Rust uses a hand-written matcher for the same common formats,
  not a fully proven equivalent for arbitrary raw input.
- `apply_order_raw_edit` requires **verified output** of the
  session-1 parser from the same raw text/context. An arbitrary
  caller-provided `parsedRecipients` list is not a trusted substitute.
- `migrate_workflow` is NOT idempotent. Running the same
  conversion twice may append duplicated historical events.
- `reprice_order` intentionally combines original repricing with
  a persisted-order refresh gate; it is **not identical by public
  signature** to `domain.ts::repriceOrder`. Exact explicit-staff-edit
  and persisted/locked order semantics need direct TS examples.
- Some original modules are outside session 2's source ownership:
  image/product matching is session 1, and Excel generation,
  tracking message output and Tauri/SQLite/Windows app wiring
  are session 3. This audit identifies **coverage and ownership
  gaps**, not authorization to alter those owners' files.

### Required completion gates

1. **P0:** Add actual original-TS-to-Rust differential test
   cases for all 14 `apply_workflow_action` names, including
   successful state mutation, blocked mutation, undo/recheck,
   partial payment cancellation, confirmation reapproval,
   exports and delivery finalization. Freeze UUIDs and clocks,
   compare full State and audit order; do not count equivalent
   failures unless success/failure expectation is asserted.
2. **P0:** Assign, implement and directly compare the missing
   workflow mutation families in group-trash, corrections,
   reception/working-raw/receipt, retail confirmation and
   reply application. Keep session 1's recognition parser and
   session 3's Excel/UI/DB interfaces isolated.
3. **P1:** Expand direct cases for pricing refresh, shipping
   basis/group deletion, group evaluation, dispatch summary,
   deleted/frozen/historical recipients and evidence order.
4. **P1:** Run a mixed cross-order, cross-group,
   PREPAID/POSTPAID and STORE/FACTORY scenario matrix,
   including conflicting historical receipts, rechecks
   and manual/automatic tariff versions.
5. **Integration (session 3):** Run both independent validators
   at their original transition boundaries, use atomic SQLite
   transactions/backup, verify Windows Tauri end-to-end, and
   do not enable Rust as the sole workflow approval authority
   before these blockers are resolved.

**Audit conclusion: implementation is substantial, but the
session-2 migration is NOT yet proven fully equivalent to the
TypeScript source.** A merged/production-ready claim is BLOCKED.

---

## Session 2 continuation: validateReceptionBoundary original-TS parity — 2026-11-13

**Latest audited source / test checkpoint**
- Branch: `migration/02-rules`
- Verified implementation and fixture commit: `dac5e32f33da0191bb82d0ab2854d79685689e14`
- GitHub Actions CI: https://github.com/ThunderStrikerKR/TSBH/actions/runs/43380061844
- **Real TypeScript against compiled Rust: 478/478 named differential cases PASS, 0 mismatch**
- **Independent Rust regression: 47/47 PASS**
- **Tauri/SQLite/Windows integrated job: SKIPPED (not tested)**
- The comparison corpus increased from 383 to **478**, with 95 additional
  direct cases for new and existing reception boundary checks. All new
  cases separately assert intended original TypeScript success vs rejection,
  in addition to exact original/Rust result parity.
- Source of truth: `src/orders/reception.ts::validateReceptionBoundary`
  at TS baseline `d5ea8ed20b8120b844437263c2eb2b8963559e8d`.
- Rust target: `src-tauri/src/business_core/rules/validation.rs::validate_reception`,
  exposed through `execute("validate_reception_boundary",{before,state})`.
- No edits to TypeScript, original recognition parser, Rust SQLite/Tauri
  integration or UI. Only session-2 Rust rules, direct comparison fixtures
  and this handoff document were touched.

### Exact behavior implemented / verified

1. **Original receipt version and order type gates**: reject invalid order
   type; reject new RETAIL orders unless `receptionVersion===1`; refuse
   new unconfirmed v1 orders without truthy `confirmedAt` and
   `confirmationSnapshot`; old unconfirmed draft edits remain legal.
2. **Immutable existing confirmation**: a previously confirmed order
   cannot change its confirmed time, original raw text or captured
   `confirmationSnapshot`. Existing orders cannot change `orderType`
   or `senderSnapshot`. Distinguishes a missing `senderSnapshot` key
   from an explicitly present `null`, as TypeScript `JSON.stringify`
   does. Mutations of unrelated mutable fields remain allowed.
3. **Expected new sender**: for DEALER and RETAIL, derive exact
   company sender from settings; for AGENCY, use the live client
   plus explicitly marked sender in `analysisRaw ?? raw` (not the
   historical `clientSnapshot`). Verify `senderSnapshot` against
   that expected value before all product/receipt checks.
4. **RETAIL validation**: require the exact `companyParty` as
   `clientSnapshot`; execute `retailIssues` business checks in
   original error order: actionable `orderIssues`, dispatch origin,
   actual freight, valid non-superseded current product, manually
   confirmed item quantity, company sender contact/address and
   `saleIssues`. Deduplicate messages in first-seen order. Forbid
   separate client ID, nonempty raw, analysis snapshot, paid=false
   and any item price **other than explicit null**. A missing
   `unitPrice` is not treated as null.
5. **Products before snapshot**: check each newly received item
   resolves to registered, active, non-deleted independent product
   and matching variant. A historical sale status check in
   retailIssues can reject a product before this general check.
6. **Original confirmation snapshot and receipt**: check raw,
   data.id, data.raw, both recipient lists, time, receipt.original,
   receipt.at and client ID. Preserve first-failing-condition
   priority and original Korean error messages.
7. **Shipment coverage**: exclude legacyArchived shipments; ensure
   **every confirmed recipient** has a corresponding active shipment
   before checking for a nonempty shipment set, step >=1 and an
   actual `주문 확인 완료` event mentioning at least one current shipment.
   For each distinct shipment group, execute the previously ported
   TypeScript-equivalent `stageIssues(...,1)` gate and propagate
   ordered customer/operation issues before allowing persistence.
8. **Separate validation contracts**: `validate_reception_boundary`
   is independently callable. `validate_workflow` does not silently
   invoke it, matching the original TypeScript architecture.

### Direct tests added

Full valid new AGENCY / DEALER / RETAIL orders; old legacy order and
editable draft; invalid type/reception version/unconfirmed v1; frozen
confirmedAt/raw/snapshot and immutable sender/type; expected sender from
master client, company and explicit sender (full-width colon, spaced phone,
phone punctuation, analysisRaw override); RETAIL company party, dispatch,
contact/address, freight, status/superseded product, null/missing unitPrice,
manual quantity, forbidden payment and raw analysis flags, combined
multi-issue ordering; deleted/inactive/unregistered product and variant;
each field of receipt/confirmationSnapshot; incomplete/archived shipments,
missing confirmation event, step-0 block, active multi-recipient coverage,
multi-group confirmation, stage-1 origin, address and evidence conflicts.
Includes both successful and invalid before/after snapshots and identity
key-presence corner cases.

### Source divergences discovered and repaired

- Rust previously **omitted** expected sender snapshot verification.
- Retail-specific company party, `retailIssues` and retail no-pricing/
  no-raw constraints were entirely missing.
- Rust previously checked snapshot before product validity, whereas
  original TypeScript checks product first; returned error priority
  differed on invalid product/variant.
- Rust previously missed the confirmed-recipient shipment coverage guard.
- Rust previously omitted the final stage-1 business issue gate.
- Missing vs null `senderSnapshot` and missing vs explicit-null retail
  `unitPrice` needed key-presence semantics, not a generic null fallback.
- Original's truthiness rules for confirmation time and snapshot are
  explicitly honored for successful/blocked v1 registration.

### Remaining limitations / ownership handoff

The **478/478 result is for this specific synthetic corpus**, not a
formal proof of every possible JSON object, timestamp, sender parser
sequence or original TypeScript implementation path. Original JS
`JSON.stringify` can consider object field insertion order; generic
Rust `serde_json::Value` equality is object order insensitive, so
arbitrary reordered snapshot property keys remain a known source of
possible divergence. The sender line parser likewise has no
exhaustive fuzz proof; tested practical formats match.
No existing business database was read, migrated or modified.

Session 3 must call **both** validation boundaries at the appropriate
original business transitions and verify durable SQLite transaction
semantics, generated receipt snapshots and grouped stage-1 approval
in the Windows Tauri application before production adoption. It
must not mistake the pure Rust module CI for an integrated Windows
app test. The original TS modules remain unchanged.

**Session 2 remaining:** final whole-function inventory, any
uncovered JSON/serialization and historical payment/confirmation
corner cases, and explicit ownership handoff to session 3.
Do not advertise total application migration or production
readiness based on the selected-input tests.

---

## Session 2 continuation: validateWorkflow full-branch audit — 2026-11-13

**Current verified checkpoint**
- Branch: `migration/02-rules`
- Last source/test SHA: `75105ec30ac0be9bfe997f8f97c5a5025cd361d8`
- Passing workflow run: https://github.com/ThunderStrikerKR/TSBH/actions/runs/43374763979
- **Direct original-TypeScript / compiled-Rust comparison: 383/383 named fixtures PASS**
- **Independent Rust regression tests: 47/47 PASS**
- Integrated Windows/Tauri/SQLite test on this branch: **SKIPPED**.
- The previous checkpoint was 285/285. This pass added **98** direct
  differential examples including a current/previous-state integrity matrix.
- This is test-corpus equivalence, **not a proof of all possible states**.

### Source audit and actual corrections

The source of truth remains `src/workflow.ts::validateWorkflow`
from commit `d5ea8ed20b8120b844437263c2eb2b8963559e8d`.
The Rust implementation is `src-tauri/src/business_core/rules/validation.rs::validate`.

1. **Separated validation responsibilities**: original
   `validateWorkflow(state,before)` does not invoke
   `validateReceptionBoundary(before,state)`. Rust previously called
   the reception validator implicitly at the end of `validate`.
   The extra call has been **removed**. The separate Rust
   `validate_reception_boundary` operation remains registered and
   continues to be a required independent integration check.
2. **Matched the guard order**: within a shipment check, the source
   checks RETAIL payment/stage restrictions before source/group
   link integrity; actualFreight numeric validity before charge validity.
   In history checks, existing confirmation cancellation precedes
   shipment reference/actual freight/delivery preservation, followed
   by group notice, immutable source/payment/event/delivery/change
   records, then Excel queue snapshot and handoff exceptions.
3. **Correct JS payment aggregation behavior**: source validates the
   payment total first, then executes the `sum(allocations)` aggregate,
   then checks individual allocations. Decimal, negative, overrun
   and non-safe aggregate totals can produce the distinct original
   `금액 합계를 확인하세요.` rather than an invented allocation error.
   Negative individual amounts with an otherwise valid aggregate
   proceed to the source's `입금 배분 연결 오류` guard.
4. **Preserved absent-versus-explicit-null actual freight**: source
   compares `JSON.stringify(undefined)` with `JSON.stringify(null)`.
   Rust previously collapsed absent and null into the same JSON value
   and silently permitted some unrecorded changes to historical
   actual freight. It now includes property **presence** in the
   comparison before allowing a change; a new `실제 출고 운임 입력`
   event with the correct previous amount, new origin and value
   is required for changed entries.
5. **Correct shipmentContext dealer validation**: source requires a
   recipient and the effective `orderParty`. A missing dealer without
   a saved clientSnapshot is invalid for agency/dealer orders; a
   RETAIL order may synthesize the company party, and saved
   clientSnapshot must be honored if the master client is absent.
   Rust now follows the same cases. For archived shipments, only
   *missing original recipient linkage* qualifies for the source's
   skip path; an archived shipment with an existing recipient but
   missing dealer must not be silently skipped.

### Original TypeScript comparison matrix

`tests/rust-migration/rules/parity/compare.mts` runs the actual
`validateWorkflow(state,before)` and the compiled Rust
`execute("validate_workflow",{state,before})` on the SAME synthetic
JSON structure, comparing exact success and error messages.

Fixtures cover:
- No workflow, valid state and duplicate IDs across sources, groups,
  shipments, payments, queue, events, deliveries and requests
- Orphan/archived recipients, RETAIL restrictions, source/group/dealer
  linkage, step range and negative/decimal freight values
- Missing/incorrect recipient party vs RETAIL company fallback and
  saved clientSnapshot
- Payment totals, multiple allocations, invalid dealer/shipment
  linkage, safe-integer limits and incorrect aggregate sums
- Duplicate deliveries, confirmations with invalid amounts, unknown
  group/shipments and duplicate confirmation identifiers
- Partial/full confirmation cancellation at valid and forbidden
  shipment stages, unchanged confirmations and illegal edits
- Stable source/recipient/shipment IDs and preserved payments,
  account notices, audit events, deliveries and change requests
- Actual freight audit proof with new event, origin/amount/before
  matching, legacy recipient fallback, explicitly null/absent
  origin distinction, and reused old-event refusal
- Queue entry immutable shipment/origin/snapshot, CANCELLED
  exceptions, EXPORTED/STORE_SENT frozen records, staff
  `공장 전달 직원 확인` metadata-only change and documented
  `전달 전 출력본 폐기 / 재작성` disposal with a matching export snapshot
- Double-fault priority cases showing the original error precedence
  for retail, approval cancellation and freight.

The tests also assert whether the real TypeScript source **must pass
or fail** for each scenario; two implementations merely returning the
same unintended error do not count as success.

### Important boundaries

- `validateWorkflow` and `validateReceptionBoundary` are separate
  original TypeScript functions with separate Rust operations. The
  completion of this task **does not verify every reception-boundary
  branch**. Call both at their correct app boundary as required by
  the existing original workflow; do not silently combine their
  semantics in the pure `validateWorkflow` operation.
- 383 matching cases are not exhaustive input-space proof. Unusual
  malformed JSON, unsupported runtime types or differing serialized
  object property order may still require further verification.
- **No live business records were migrated or modified**. No
  app-level Tauri commands, SQLite persistence, UI, or Windows
  runtime were edited in this session. Those integrations remain
  with session 3.
- Remaining session-2 owned work: comprehensive
  `validateReceptionBoundary` direct parity and any uncovered
  payment-confirmation/cancellation variant not in this matrix.

---

## Session 2 continuation: migrateWorkflow Rust migration — 2026-11-13

**Latest verified source checkpoint**
- Branch: `migration/02-rules`
- Implementation and direct-comparison source SHA: `81037695496b7f56943dfed63c44c5e51864e608`
- GitHub Actions: https://github.com/ThunderStrikerKR/TSBH/actions/runs/43372901079
- **Real TypeScript vs compiled Rust: 285 / 285 named comparison cases PASS**
- **Standalone Rust regression: 47 / 47 PASS**
- **Windows Tauri/SQLite integration: SKIPPED, not yet verified**
- The corpus expanded by 26 original-TS-to-Rust migration examples over the previous 259/259 checkpoint. CI enforces **the expected TypeScript success or failure**, not only equality of error messages.

### Ported operation and migration contract

`execute("migrate_workflow", {"state": State, "now": UTC_ISO_STRING, "eventIds": [UUID, ...]})`

Implemented in `src-tauri/src/business_core/rules/legacy_migration.rs`
and registered from `src-tauri/src/business_core/rules/mod.rs`. Returns
`{"state": State}` or the exact original TypeScript business-rule error
for the tested rejection case.

- Calls the already-ported `reconciliation::reconcile` first, sharing a
  single ordered event-ID stream with the subsequent legacy events.
- Derives each shipment's legacy step: **4** for `paid`,
  `postpaidApproved`, or legacy status `QUEUED`/`EXPORTED`; **3** for
  `notified` if not already step 4; **0** otherwise. Sets
  `legacyApproval = (step == 4)`.
- Retains the stable source, group, order, recipient and shipment IDs.
  Each shipment gets a sender snapshot from the original
  `senderFor` precedence: saved `senderSnapshot` first, then company
  sender for `DEALER`/`RETAIL`, otherwise an explicitly marked
  sender in raw/analysisRaw, then frozen clientSnapshot, master
  client, or company fallback. Handling of marked sender phone/address
  was corrected after an actual TypeScript mismatch.
- For a single-recipient order with a valid historical shippingFee,
  sets chargeMode `MANUAL`, setting the specific amount only when all
  items share exactly one origin. Applies confirmedFreightVersion
  at step >=2 and the historical billingSignature at step >=3.
- For status `EXPORTED`, sets `transferred` and `legacyArchived`
  without inventing an Excel queue record.
- For non-EXPORTED orders in the original **State.queue** legacy
  order-ID list, creates a `QUEUED` workflow Excel record for each
  origin, with at-time item-filtered recipient snapshot, sender,
  freight code, subtotal, shipping, VAT and total. This is different
  from the new `State.workflow.queue`; do not confuse the two.
- Appends one original-style audit event `기존 주문 상태 보존`
  per migrated shipment, with its old order status, converted step,
  and `receiptCreated:false`.
- Existing payment allocations, confirmations, source records, queue
  records, deliveries, change requests, audit events and pre-existing
  account notices are **preserved**. None is recalculated, erased or
  reassigned by the migration function.
- TypeScript refuses to re-bill a group containing exclusively
  legacyArchived shipments when migrating a financially completed
  order. Rust reproduces that error: `묶음의 배송 건이 없습니다.`.
  A REVIEW order with archived shipment remains a separately
  tested successful case.

### Migration-specific test cases

`tests/rust-migration/rules/parity/compare.mts` executes the exact
original `migrateWorkflow` and the compiled Rust operation on identical
fully structured State. It freezes timestamp/UUIDs and compares **all**
serialized resulting State fields, not only summarized status. Test
categories cover:

- REVIEW, notified, paid, postpaidApproved, QUEUED, EXPORTED
- Legacy queue snapshot contents, mixed STORE/FACTORY, freight
  collect 020, single STORE fee, missing historical fee and VAT
- Single and multiple recipients, multiple independent orders,
  separate paid and queued orders, multi-allocation payments
- Pre-existing clientSnapshot, senderSnapshot, explicitly marked
  sender, company sender, phone formats and full-width colons
- Historical confirmations, invoice notices, payment allocations,
  receipt/rawHistory, deliveries, change requests, audit IDs
- Correct error for completed archived-only groups versus successful
  archival preservation of REVIEW orders

**In addition to Rust/TS equality**, for every pre-existing workflow
payment, source, event, delivery, change request, confirmation and
queue record, test code checks that the TypeScript migration retained
the exact same ID and record content. It also checks existing
group.notices. Because the final Rust State must equal the complete
TypeScript State, the same preservation invariants apply to Rust.

### Operational precautions and remaining session work

- **Migration is one-time, not inherently idempotent**: the original
  TypeScript appends new audit records and can append old-queue
  conversion records on each invocation. Session 3 must use a
  one-shot migration marker/transaction and a backup; do not call on
  every launch, invent safety flags inside the pure Rust rule, or
  silently duplicate historical records.
- This pure module has **no SQLite mutation, UI wire-up or executable
  Windows/Tauri test**, and no migration has been performed against
  real business records. All examples are synthetic.
- The 285 matched examples do **not** establish exhaustive semantic
  parity. Unchecked inputs, arbitrary JSON ordering of frozen evidence,
  some sender formatting and cross-history combinations remain possible
  sources of divergence.
- **Still incomplete in session 2:** exhaustive `validateWorkflow`
  and `validateReceptionBoundary` branch parity, partial cancellation
  and revalidation of historical payment confirmations, and some
  edge cases for sender/account/billing signatures.
- Session 3 must integrate the pure functions into native
  SQLite/Tauri transactions, preserve authenticated historical data
  and verify end-to-end Windows behavior. Do not activate production
  migration or replace TypeScript validation solely based on these fixtures.

---

## Session 2 continuation: applyOrderRawEdit Rust migration — 2026-11-13

**Latest verified checkpoint**
- Branch: `migration/02-rules`
- Source and test commit: `2e26dc1d538b3acb2a8410b2b11bcb98491bebbc`
- CI: https://github.com/ThunderStrikerKR/TSBH/actions/runs/43371378641
- **Original TypeScript vs compiled Rust: 259 / 259 parity fixtures PASS, 0 mismatches**
- **Independent Rust regression: 47 / 47 PASS**
- **Windows/Tauri/SQLite: SKIPPED/NOT VERIFIED**
- 19 additional direct comparison fixtures cover raw order edits; the prior
  checkpoint was 240 / 240. For the raw-edit fixtures, expected successful
  TypeScript outcomes and expected rejection outcomes were separately
  asserted. Equal errors without the intended result do not count as PASS.
- All writes remained in the session-2 ownership paths.

### Implemented pure Rust boundary

`execute("apply_order_raw_edit", payload)` is implemented in
`src-tauri/src/business_core/rules/order_mutations.rs`, registered in
`src-tauri/src/business_core/rules/mod.rs`.

Payload contract:

    {
      "state": State,
      "orderId": "o1",
      "raw": "edited original source",
      "parsedRecipients": [/* output from the existing session-1 parser */],
      "strictIdentity": false,
      "actor": "staff member",
      "now": "2026-11-13T05:00:00.000Z",
      "eventIds": ["event UUID 1", "event UUID 2", "..."]
    }

The function returns `{"state": State}`; errors return the original Korean
TypeScript business-rule message. It is a **pure in-memory JSON mutation**;
the caller must persist atomically and retain native reception validation.

The original `applyOrderRawEdit` internally calls `parseOrder`; this port
does **not** implement another parser. It accepts the exact
`parseOrder(raw, selectedClient, state)` output from the session-1
recognition owner. This is an **integration precondition**, not an
authorization to synthesize or trust arbitrary `parsedRecipients`. Session 3
must pass authenticated output from the original equivalent parser, verify
the raw/context used to generate it, and avoid applying an unrelated
parsed recipient list.

Exact business-rule paths covered:
- Reject nonexistent/deleted orders, blank raw edits, and attempts to
  re-analyze EXPORTED/STORE_SENT or delivered shipments. Identical raw
  returns an unmodified clone without requiring parser input or time.
- Reassign recipient identity by first matching phone/mobile, then name,
  finally (unless strictIdentity) original index; do not assign one prior
  recipient to more than one new recipient.
- Preserve receipt recipient VAT settings and old item ID on matching
  original raw/product+variant; apply `mergeParsedItem` rules for staff
  manual-confirmation evidence and changed quantity source spans; update
  source-span target IDs for the preserved identities.
- Reject paid-recipient reidentification when both name and mobile change;
  retain previous payment records and all existing shipment IDs.
- Cancel QUEUED exports, clear transferred flags, append downgrade/recheck
  events, invalidate existing payment confirmations with `입금 승인 재확인 필요`,
  reset order status/price lock and copy-message edit fields, append the
  old original text to `rawHistory`, append `원문 편집` event.
- Call the already-existing Rust `reconciliation::reconcile` after the
  raw-edit mutation, preserving ordering of all generated audit IDs.
- The input supplies UTC ISO clock and an ordered pool of event IDs;
  there is no internal clock, random UUID or SQLite write.

### Direct parity fixture coverage

`tests/rust-migration/rules/parity/compare.mts` uses the **real TypeScript
parseOrder** output as the Rust `parsedRecipients` input and replays the
same UUID stream and time in the **real TypeScript applyOrderRawEdit**
function. Compares entire JSON return values, including event order, ID
links, source spans, billing information and rechecks.

New fixtures: no-op raw, blank raw, deleted order, EXPORTED/STORE_SENT
refusal, already delivered order, normal edit, strict matching,
queued/cancelled Excel entries, paid recipient identity, retained
mobile/name, staff-confirmed items and VAT overrides, confirmed orders,
two previous recipient links with payment, and step-3 downgrade.

**Scope qualification:** 259 / 259 is selected-input parity, not formal
exhaustive equivalence. The Rust code depends on an external accurate
recognition result; final atomic Tauri/SQLite integration and Windows
execution remain session 3 tasks. Potential untested cases include
arbitrary parser outputs, cross-group shipment histories, complex source
evidence serialization and all native reception-boundary exceptions.

**Session-2 work still outstanding beyond this task:**
remaining `validateWorkflow` and
`validateReceptionBoundary` branches and full historical-payment
cancellation/revalidation parity. Do not represent the overall migration as
complete.

---

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
include `migrateWorkflow`, some complete
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
