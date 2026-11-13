# Rust migration session state
Updated: 2026-11-13 (KST)

- Common base: `d5ea8ed20b8120b844437263c2eb2b8963559e8d`
- Integration branch: `migration/03-integration`
- Recognition branch: `migration/01-recognition` (currently active, not yet accepted/merged)
- Rules branch: `migration/02-rules` (not available at latest check)
- Integration branch latest commit: check GitHub branch head after this document commit.
- Rust output module: implemented and isolated Rust compilation/tests passed.
- Rust Tauri output domain: registered.
- Actual React factory/store Excel preview and post-save recheck: switched to Rust IPC.
- Rust recognition: NOT MERGED.
- Rust rules: NOT MERGED.
- React order parsing/price/message: NOT SWITCHED.
- React daily settlement: NOT SWITCHED; Rust preparation module available.
- Old TS business logic: NOT ALL REMOVED. Legacy export preview retained for existing tests; frontend bundle requires audit.
- CI: independent Rust tests passed. Integrated frontend/native CI must be checked for latest HEAD.
- Known baseline failures: order samples 19 and 20 in existing 20-sample audit; do not delete.
- Windows Release build: NOT DONE.
- Portable ZIP: NOT DONE.
- OCR standalone/Windows execution: NOT VERIFIED.
- On-site demonstration: NOT PERFORMED.

Continuation: read `03-integration.md` and current Actions logs. Fix any integration regressions, then merge *verified* session 1 and 2 commits and complete UI + native wiring. Do not declare complete until the final audit checklist is verified.
