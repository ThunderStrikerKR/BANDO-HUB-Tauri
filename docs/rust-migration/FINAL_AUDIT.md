# Rust migration final audit — IN PROGRESS

This document reports measurements, **not** a full Rust migration or on-site installation certificate.

| Requirement | Actual verification |
| --- | --- |
| Rust output implementation | Implemented, isolated test crate passes |
| Rust factory/store Excel via real React UI | Tauri IPC code connected; full GUI manual smoke not verified |
| Rust daily settlement via real React UI | Tauri IPC code connected; async stale-response protected |
| Rust message renderer invoked from real UI | NOT DONE, only independent module implemented |
| Session 1 recognition integrated | NOT DONE; standalone owner branch currently fails Rust compile |
| Session 2 rules integrated | NOT DONE; owner branch in progress |
| Core TypeScript algorithms fully removed | NOT DONE, old functions and message logic still exist |
| React TypeScript and Vite build | PASS on latest post-feature-merge code |
| Node regression | 473 PASS / 2 pre-existing known failures (475 total) |
| Rust output standalone tests | PASS |
| Windows Tauri Rust library compile | PASS |
| Windows native library tests | 77 PASS / 2 baseline `kakao_dock.rs` failures / 1 ignored |
| Production JS/HTML asset scan | 12 assets, no source maps or raw TS/TSX/JSX, residual message-template fingerprint remains |
| Windows Release EXE (nonfinal baseline) | PASS in run `43349166374` |
| Portable OCR ZIP (nonfinal baseline) | PASS in run `43349166374`; uploaded as `TSBH-migration03-preview-NOT-FINAL` |
| Latest post-feature-merge Windows candidate | PASS Release EXE and Portable ZIP with OCR assets, Korean-path verification (run `43349685089`), NOT final approval |
| Live Windows GUI, backup/restore and database preservation | NOT VERIFIED end to end |
| On-site installation and final demonstration | NOT PERFORMED |

## Evidence and repositories
- Session 3 branch: https://github.com/ThunderStrikerKR/TSBH/tree/migration/03-integration
- Output and native CI: https://github.com/ThunderStrikerKR/TSBH/actions/workflows/migration-output.yml
- Recognition independent compile failure: https://github.com/ThunderStrikerKR/TSBH/actions/runs/43350613859
- Baseline feature-branch Windows test comparison: https://github.com/ThunderStrikerKR/TSBH/actions/runs/43342892142
- Earlier successful nonfinal OCR ZIP: https://github.com/ThunderStrikerKR/TSBH/actions/runs/43349166374
- Updated Windows candidate run: https://github.com/ThunderStrikerKR/TSBH/actions/runs/43349685089 (artifact ID `14003597952`)

### Confirmed not-yet-resolved recognition compile blockers
- `src-tauri/src/business_core/recognition/model.rs:394`, `:395`: E0425 (unknown `e`)
- `src-tauri/src/business_core/recognition/model.rs:105`: E0597 (regular expression borrow lifetime)
- `src-tauri/src/business_core/recognition/quantity.rs:58`: E0597 (regular expression borrow lifetime)
The owner branch must fix and pass its independent crate test. Session 3 does not bypass or overwrite ownership.

### TypeScript exposure audit
A non-strict scan of the actual Vite assets ran after `npm run build`. Zero source-map files and zero raw TS/TSX/JSX were emitted. One `message-template` fingerprint remained, so full TS algorithm removal has **not** occurred. Absence of other fingerprints alone is not proof of removal: the source-level call graph and final EXE assets still need inspection. The existing TS `factory-export`, `store-export` and `settlement-report` compatibility implementations must be removed or excluded only after Rust replacement and migrated tests are verified.

### Production and demonstration safety
Do not label either successfully packaged preview ZIP as the 2026-11-14 approved demonstration artifact. Rebuild after all three modules integrate and required regression tests pass. Retain the last known-good functioning release separately. No Windows GUI execution or on-site installation was performed in this session.
