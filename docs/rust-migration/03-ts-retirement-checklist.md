# Session 3 — TypeScript business-algorithm retirement gate

Status: **NOT CLEARED TO DELETE** (2026-11-13). Branch: `migration/03-integration`.
This is a live migration inventory, not authorization to remove original TS
functions or claim full Windows release readiness.

## Rules that must not be weakened
1. Compare the actual original TypeScript algorithm with compiled production Rust on identical synthetic states and stable UUID/date inputs. Static source-pattern tests are not sufficient.
2. Make the real React action invoke Rust; a Rust function existing on disk is not evidence of migration. Errors must not silently fall back to TypeScript mutations.
3. Keep ExcelJS serialization, file dialogs, React rendering/draft state and type-only adapters in TypeScript. Removing the TS business engine does **not** imply removing all TypeScript.
4. Keep original TS oracles until every supported branch, date, VAT, freight, catalog, historical and state-transition case is covered. Do not remove them as part of a wiring patch.
5. Keep original receipt, locked prices, old export snapshots, audit ordering and SQLite revision-checked single-write semantics. Never mark saved XLSX as physically shipped.
6. Original legacy order-sample indexes **19 and 20** were explicitly excluded from the old TS sample tests. They are not grounds to disable unrelated migrated Rust tests.
7. The two Windows KakaoTalk synthetic-window failures remain separate blockers. A passing business parity run is **not** a passing native Windows application.

## Migration ledger: runtime ownership

| Business family | Active React path | Rust target | Retirement gate |
| --- | --- | --- | --- |
| Initial reception recognition | `orders/useOrderDesk.tsx` | `recognition.analyze_order` | UI wired; verify all original input structures and persisted evidence before dropping `parser.ts` |
| Selected product/representative and alias | `IssueResolver.tsx`, `OrderDesk.tsx` | `rules.apply_product_action` | UI wired; product/alias original oracle retained; widen real catalog fixtures |
| Direct retail confirmation | `orders/RetailOrderDialog.tsx` | `rules.apply_retail_action` | UI wired; retain original oracle and test SQLite/Windows |
| Post-export correction and factory handoff | `CorrectionPanel.tsx`, `WorkflowQueue.tsx` | `rules.apply_correction_action` | UI wired for request, copy, confirm, factory handoff, pre-handoff reopen; other readers/formatters still TS |
| Working raw correction | `WorkingRawDialog.tsx` | `recognition.analyze_order` plus `rules.apply_raw_correction` | Handler wired but **dialog is not reached from the active receipt UI**. End-to-end parity and explicit UX entrypoint approval needed |
| Factory/store Excel row preparation | `WorkflowQueue.tsx` | `output.prepare_factory_export`, `prepare_store_export` | UI wired, TS ExcelJS generates bytes |
| **Factory/store Excel export history** | `WorkflowQueue.tsx` | `output.finalize_export` | UI wired, fresh Rust revalidation, EXPORTED and fileOnly snapshots and audit; original `record*ExportPrepared` kept as oracle |
| **Clipboard message-copy audit** | `MessageWorkspace.tsx` | `rules.record_message_copy` | UI wired and token-idempotent. **TS `paymentSignature` still computes the text signature**; the message generation engine is not retired |
| Editable pricing/freight and order writes | `OrderDesk.tsx`, `ShippingManager.tsx` and selectors | `rules.resolve_unit_price`, `save_order`, `apply_shipping_action`, `apply_workflow_action` | Main writes wired; inspect remaining synchronous snapshots and quote paths separately |
| Automatic message generation | `MessageWorkspace.tsx`, `automatic-message.ts`, `hub-messages.ts` | `output.render_messages` (partial renderer) | **BLOCKED**: full request/payment phase, conditional notices, custom templates, links, mixed VAT, signatures and copy parity. Do not replace with partial Rust output |
| Live workflow previews/totals | `HubWorkspace.tsx`, `orders/useOrderDesk.tsx`, `WorkflowBoard.tsx` | `rules.reconcile_workflow`, `workflow_issues`, `calculate_shipment_totals`, `evaluate_workflow` | **BLOCKED**: live TS memoized projections used during edits. Must port async preview without stale result overwrites or UI redesign |
| Factory-reply workbook import and matching | `FactoryReplyImport.tsx`, `factory-reply-workbook.ts`, `factory-replies.ts` | Native file storage/conflict tools exist, but not full reply parsing/match engine | **BLOCKED**: ambiguous row matches, actual freight, shipping identity and historical audit need full parity and GUI tests |
| Customer reply proposal/apply | `replies.ts`, draft review paths | `rules.apply_reply_action` (partial caller integration) | **BLOCKED** until proposal, address parsing input and UI caller provenance verified |
| Order-history/settlement inputs | `app/order-history.ts`, `app/settlement-report.ts` | `output.prepare_settlement` for final aggregates | **BLOCKED**: Rust aggregates TS-produced history rows. Move history selection/financial snapshot source first |
| Product/client batch registration | `client-workbook.ts`, `product-sync-workbook.ts`, `product-unified-workbook.ts`, other management modules | Separate Rust rules not yet complete | **BLOCKED / beyond immediate session-3 output ownership**; do not delete these files |

## Source files to **retain** during final removal preparation

- Core parity oracles: `src/domain.ts`, `src/workflow.ts`, `src/shipping.ts`, `src/parser.ts`, `src/matching.ts`, `src/validation.ts`, `src/issue-actions.ts`, `src/corrections.ts`, `src/working-raw.ts`, `src/orders/retail.ts`.
- Output oracles: `src/factory-export.ts` and `src/store-export.ts` **retain ExcelJS formatting** even after their legacy history reducers become removable; `src/automatic-message.ts`, `src/hub-messages.ts`, `src/message-model.ts`, `src/automatic-message-templates.ts`, `src/factory-reply-workbook.ts`.
- Read and financial projection: `src/app/order-history.ts`, `src/app/settlement-report.ts`, `src/replies.ts`.
- React screens, TypeScript interfaces, `src/tauri-bridge.ts`, native IPC adapters and ExcelJS workbook serialization remain legitimate TS code.
- No filename is safe to delete solely because a new Rust module now has a similar name. Confirm production call graph, tests, references, dynamic imports and historical data first.

## Verification assets

- `tests/rust-migration/output/parity.test.mjs`: actual TS versus compiled Rust output, including the new factory/store ledger transition cases.
- `tests/rust-migration/rules/parity/compare.mts`: actual TS versus compiled Rust rules, now including message copy audit.
- `tests/tauri-native-export-and-copy-wiring.test.mjs`: prevents UI regressions back to TS history reducers.
- `tests/tauri-native-product-confirmation-parity.test.mjs`: product selection original TS oracle.
- `tests/tauri-native-operational-actions.test.mjs`: UI-to-native routing. These are static checks and do not replace real Windows GUI tests.

## Exit criteria — all required before deleting business TS algorithms

1. Every business mutation inside React source routes to Rust, with no TS fallback and a single revision-checked SQLite commit.
2. The complete message request/payment text and all customer notices/conditional templates match original TS fixtures; no missing links or changed VAT labels.
3. Excel preparation, saved-file audit and factory reply matching are Rust-owned, preserve distinct factory/store queues and all historical snapshots.
4. Saved edits, receipt history, backups and restores are validated in a real installed Windows build, including actual business-shaped data.
5. No TS-only price, workflow stage, grouped amount, order history or export state calculator remains on the authoritative live path.
6. Automated import/call-site audit and integration tests pass; then remove **only** unreferenced business TS code, in separate reviewable commits. Retain test oracles outside the live bundle as needed.
7. CI Windows native failures are resolved or explicitly isolated with validated real-window evidence. Do not describe partial CI as all-green.

## Suggested bounded next commits
A. Make `MessageWorkspace` request/payment body and signature Rust-native with broad original TS parity, without moving the position of product notices or changing conditional messages.
B. Port live workflow preview and financial read projections using stale-response cancellation.
C. Port factory-reply match/approve and the source of settlement history rows.
D. Review and only then retire unused TypeScript business helper functions.

**Current conclusion:** exporter and copy-audit live reducers may be candidates
for future removal **after usage and oracle review**, but the application
cannot yet remove the TypeScript business layer as a whole.
