BANDO HUB Tauri v0.0.4 / TypeScript TS2345 fix

1. Extract this ZIP to any folder.
2. Double-click APPLY_TS2345.cmd.
3. Select your Tauri project ROOT folder (it contains src and BUILD_WINDOWS_TAURI.cmd).
   The folder may still be named BANDO-HUB-Tauri-v0.0.1; that is OK if you patched it up to v0.0.4.
4. Wait for SUCCESS, then run BUILD_WINDOWS_TAURI.cmd in the source folder again.

This patch only changes one line in src/product-price-xlsx.ts.
It leaves Rust, SQLite, pricing data, and other code intact.
The previous file is backed up under %LOCALAPPDATA%\BANDO-HUB\patch-backups.
If SOURCE MISMATCH appears, do not paste code manually. Share the message.
Windows full build / actual Excel roundtrip is not verified here.
