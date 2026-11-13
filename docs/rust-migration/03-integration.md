# Session 3: Output and integration handoff (2026-11-13)

## Ownership and branch
- Repository: `ThunderStrikerKR/TSBH`
- Branch: `migration/03-integration`
- Common base: `d5ea8ed20b8120b844437263c2eb2b8963559e8d`
- Other owners: recognition `migration/01-recognition`; rules `migration/02-rules`.
- Do not merge unverified commits from the other branches or modify their private module files.

## Implemented (independent Rust output engine)
- `src-tauri/src/business_core/output/mod.rs` provides `execute(operation: &str, payload: serde_json::Value) -> Result<serde_json::Value, String>`.
- `prepare_factory_export` and `prepare_store_export` accept `{state,ids}` and return `{revision,ids,rows}`. These validate frozen queue snapshots, shipment stage, duplicate export IDs, sender/recipient fields, freight codes and items, with historical product ID + price-record checks for factory shipments.
- `render_messages` takes `{mode,settings,...}`. Modes: `template` (`templateId,values`), `validate_templates`, `payment` (rules-resolved recipient financial amounts, total and account), `options` (pre-grouped questions and optional notices). This is **not yet a drop-in replacement for the entire TS `hubMessages` workflow**. It must be connected to rules and recognition outputs before full substitution.
- `prepare_settlement` takes `{state,date,historyRows}`. Requires already-frozen order-history billing rows and computes accounting aggregates, allocations and receipts, with independent Seoul-date semantics.
- The `tests/rust-migration/output` isolated Cargo crate compiles the real module without Tauri; it covers queue safety, option identity, historical mapping, message order and settlement cash separation.

## Native integration already applied
- `src-tauri/src/business_core/mod.rs` and `src-tauri/src/lib.rs` register `business_core_call(domain,operation,payload)`. Only `output` is activated until the other sessions are verified.
- `src/tauri-bridge.ts` exposes `businessCoreCall<T>`.
- `src/WorkflowQueue.tsx` now obtains factory/store export previews from Rust and revalidates against fresh state in Rust after Save As. Existing ExcelJS worksheet and formatting code remains.
- `src/factory-export.ts` and `src/store-export.ts` expose `record*Prepared` for the native-prevalidated path, while legacy synchronous functions remain for existing regression fixtures.
- React/TypeScript message generation, daily settlement UI, full order analysis, rules and most workflow mutations have **not** been migrated yet. Do not declare full Rust migration complete.

## Required interface
```ts
businessCoreCall<FactoryExportPreview>(
  "output", "prepare_factory_export", { state: await window.bando.load(), ids }
)
businessCoreCall<StoreExportPreview>(
  "output", "prepare_store_export", { state: await window.bando.load(), ids }
)
```
Errors reject the promise. For each export the UI obtains a new Rust preview from the latest DB state after native file save and before committing export history, then compares preview revision and frozen row values. A saved file is not treated as a dispatched parcel or factory delivery.

## Tests and build
- Isolated CI: `.github/workflows/migration-output.yml`.
- At `cc5ac9facd774e213a7b4e179972b2c7e8fc6506` the isolated Rust tests passed (GitHub Actions).
- CI with UI integration added: TypeScript production build, all existing Node regressions, Windows-native Rust cargo tests. Check the latest run before claiming results.
- Two existing 20-order sample cases, 19 and 20, failed in the first integration CI run. They predate output migration, and tests were neither removed nor weakened.
- Windows Release and Portable ZIP are **not yet built** from this branch, and no Windows GUI, OCR, or on-site installation result is claimed.

## Next steps
1. Wait only for verified completion of `migration/01-recognition` and `migration/02-rules`; continue own regression work meanwhile.
2. Compare handoff documents and commits, then merge verified commits into this branch (never change the owner branches).
3. Add recognition and rules domains to the existing `business_core_call` dispatcher and connect React consumers with latest-request protection.
4. Replace remaining legacy TS message/payment/settlement and workflow algorithms, while preserving UI-only XLSX serialization.
5. Re-run all TypeScript, Rust and 20-order cases, distinguish baseline failures, inspect the Vite bundle and Windows executable.
6. Build and validate Windows release and offline PaddleOCR Portable ZIP; preserve the last known-good demonstration build.

## Safety contracts
- Do not recompute an approved item's SKU, name or shipping price from mutable catalog data.
- Preserve invoice/account/message/guidance order, manual approval state, sender overrides, freight codes and the daily Excel archive.
- Never interpret successful output preparation as successful disk save or actual shipping.
- Never claim Windows GUI success from Linux tests or a successful Cargo build alone.
