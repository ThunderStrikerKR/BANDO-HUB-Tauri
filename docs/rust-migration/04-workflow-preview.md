# TSBH Session A: Rust live workflow preview and workflow-stage handoff

**Scope:** `migration/04-workflow-preview`, branched from
`migration/03-integration` at `a1444be0a524dae250587b0bf513061fb452be5f`.

**Session-A source work:** COMPLETE. All owned changes are committed to the
dedicated branch. Do not conflate this with an app-wide migration or a merged
integration branch.

## Owned runtime boundaries

- `src-tauri/src/business_core/rules/workflow_preview.rs` owns the Rust
  read-only projections for group workflow stages, stage issues, financial
  amounts, VAT/collect carrier freight, per-shipment paid allocations, order
  total, shipment count, and item line amounts.
- `src-tauri/src/business_core/rules/mod.rs` exposes
  `preview_workflow` and `preview_order`.
- `src/orders/useNativeWorkflowReconcile.ts`,
  `useNativeWorkflowBoard.ts`, and `useNativeOrderPreview.ts` guard stale IPC
  responses by content fingerprint. Pending results do **not** invoke the old
  TypeScript business calculator as fallback.
- `src/HubWorkspace.tsx`, `src/orders/useOrderDesk.tsx`,
  `src/OrderDesk.tsx`, `src/WorkflowBoard.tsx`, and
  `src/WorkflowFooter.tsx` consume native calculations. The separate
  automatic-message generator in `MessageWorkspace.tsx` remains another
  session's responsibility.

## Verified automatic acceptance

- **94 differential cases**: actual compiled Rust versus original TypeScript
  price/shipping/order/workflow rules including live unsaved draft reconciliation
  (0 differences).
- **Windows real native Rust library and SQLite suite**: 104 tests passed,
  0 failed; 1 unrelated ignored test; 2 known pre-migration Kakao Win32
  fixtures explicitly filtered out by the established CI policy.
- **Four added on-disk SQLite lifecycle tests** run via the actual
  `initialize_database` and v2 relational core, not mocked persistence:
  1. Rust preview/reconciliation does not write pending orders or transient
     events to SQLite, including after process-level database reopen.
  2. Postpaid stage-4 approval, audit trail, relational order/recipient rows,
     revision conflict rejection and SQLite reload.
  3. Prepaid stage-4 rejection without payment preserves database revision,
     order contents and audit events.
  4. Staff stages 1→2→3→4 run through the native reducer, are committed
     in separate SQLite transactions, and preserve shipment identity,
     account notice history and restored final state on reopen.
- TypeScript compilation, Vite production build, existing JS regressions,
  original rules parity, isolated Rust rules, and integration Rust dispatch
  also passed.

Evidence: https://github.com/ThunderStrikerKR/TSBH/actions/runs/43442726176

## Important boundary / integration handoff

- **Not yet merged into `migration/03-integration`.** The integration
  session should merge the dedicated branch after checking concurrent changes,
  especially the shared Rust rule dispatcher and `HubWorkspace.tsx`.
- **No interactive Windows GUI/WebView2 acceptance was executed.** GitHub
  Actions tests the real native library, database transaction path, and
  frontend build, but does not prove a human clicked the real packaged Tauri
  windows or captured layout screenshots. The app-wide Windows visual
  acceptance remains a separate integration-release criterion.
- The native read-only projections do not themselves call `state_save`; only
  approved actions reach the existing revision-checked SQLite writer.
- Original TypeScript functions stay in the repository for parity tests and
  modules owned by other migration sessions. Do not delete them solely from
  this branch.
- This suite never uses a production database. Each native SQLite test
  creates an independent temporary directory and deletes it on completion.

## Final ownership decision

**A session closed for source implementation and automated acceptance.**
The unfinished cross-session merge and an actual packaged-GUI operator
acceptance are recorded for integration/release rather than misreported as
A-session work already tested.
