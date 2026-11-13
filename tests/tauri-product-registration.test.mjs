import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const read = (path) => readFileSync(new URL("../" + path, import.meta.url), "utf8");

test("Registration UI is connected to the real preview and version-checked state save", () => {
  const ui = read("src/RegistrationManager.tsx");
  const previewAdapter=read("src/native-registration-workbook.ts");
  const previewRust=read("src-tauri/src/business_core/catalog_clients/registration_preview.rs");
  assert.match(ui, /previewNativeRegistrationWorkbook\(current, file\)/);
  assert.match(previewAdapter, /"catalog_clients", "preview_registration_rows"/);
  assert.match(previewRust, /fn matching_category\(/);
  const native=read("src-tauri/src/business_core/catalog_clients/registration.rs");
  assert.match(ui, /"catalog_clients", "prepare_registration_commit"/);
  assert.match(native, /fn existing_matches\(/);
  assert.match(native, /deletedProductKeys/);
  assert.match(native, /registrationBatches/);
  assert.match(ui, /await onSave\(result\.next\)/);
  assert.match(ui, /await window\.bando!\.backup\(\)/);
  assert.ok(ui.indexOf("await window.bando!.backup()") < ui.indexOf("await onSave(result.next)"));
  assert.match(ui, /confirmAction\(/);
  assert.match(ui, /state\.registrationBatches\?\.at\(-1\)/);
  assert.doesNotMatch(ui, /await onRefresh\(\)/);
  assert.match(read("src/app/useAppModel.ts"), /lastCommitted\.current = committed/);
  assert.doesNotMatch(ui, /window\.bando!\.registrationCommit/);
});

test("Workbook registration validates identity and does not overwrite prices", () => {
  const workbook = read("src/product-registration-xlsx.ts");
  assert.match(workbook, /REGISTRATION_HEADERS/);
  assert.match(workbook, /existingMatches\(next, product\)/);
  assert.match(workbook, /validateProduct\(product, registeredProducts\(next\.products\)\)/);
  assert.match(workbook, /deletedProductKeys/);
  assert.match(workbook, /next\.products\.push\(product\)/);
  assert.doesNotMatch(workbook, /Object\.assign\(.*retail/);
});

test("Review blocks rows with invalid categories, ambiguous brands, formulas, duplicates", () => {
  const workbook = read("src/product-registration-xlsx.ts");
  assert.match(workbook, /categoryPath\(all, item\.id\)/);
  assert.match(workbook, /holds\.push\("브랜드/);
  assert.match(workbook, /병합 셀과 수식은 허용하지 않습니다/);
  assert.match(workbook, /"DUPLICATE"/);
  assert.match(workbook, /"HOLD"/);
  assert.match(workbook, /fingerprint/);
  assert.match(workbook, /preview\.revision/);
});

test("Native registration download only accepts the blank template", () => {
  const bridge = read("src/tauri-bridge.ts");
  const rust = read("src-tauri/src/lib.rs");
  assert.match(bridge, /saveRegistrationWorkbook: \(kind, bytes\)/);
  assert.match(rust, /fn save_registration_workbook/);
  assert.match(rust, /if kind != "양식"/);
  assert.match(rust, /WorkbookKind::ProductTemplate/);
  assert.match(rust, /상품 등록 결과는 반도허브 화면에서 확인하세요/);
  assert.match(rust, /\.create_new\(true\)/);
  assert.match(rust, /save_product_workbook, save_registration_workbook/);
});

test("Old price workbook UI is merged into the complete product workbook", () => {
  assert.doesNotMatch(read("src/ProductManager.tsx"), /<ProductPriceWorkbookTools/);
  assert.match(read("src/ProductManager.tsx"), /<ProductSyncWorkbookTools/);
  assert.match(read("src/ProductManager.tsx"), /<RegistrationManager state=\{state\} onSave=\{onSave\}/);
  assert.match(read("src/RegistrationManager.tsx"), /최근 등록 결과/);
  assert.doesNotMatch(read("src/RegistrationManager.tsx"), /최근 등록 결과 다운로드/);
});

test("Excel exports use a native Save As dialog with user-chosen folder and name", () => {
  const rust = read("src-tauri/src/lib.rs");
  const cargo = read("src-tauri/Cargo.toml");
  assert.match(cargo, /tauri-plugin-dialog = "2"/);
  assert.match(rust, /tauri_plugin_dialog::init\(\)/);
  assert.match(rust, /\.blocking_save_file\(\)/);
  assert.match(rust, /\.set_file_name\(filename\)/);
  assert.match(rust, /async fn save_product_workbook/);
  assert.match(rust, /async fn save_registration_workbook/);
  assert.doesNotMatch(rust, /USERPROFILE/);
});

test("Cancelling Save As is not an error or a false success notice", () => {
  const rust = read("src-tauri/src/lib.rs");
  const client = read("src/RegistrationManager.tsx");
  const price = read("src/ProductPriceWorkbookTools.tsx");
  assert.match(rust, /let Some\(selected\) = selected else \{ return Ok\(None\); \}/);
  assert.match(client, /if \(path\) onNotice\("상품 등록 양식을 저장했습니다/);
  assert.match(client, /lastBatch\.rows\.map/);
  assert.match(price, /if \(path\) onNotice\("상품 가격표를 저장했습니다/);
});

test("Excel Save As does not overwrite an existing file or accept another extension", () => {
  const rust = read("src-tauri/src/lib.rs");
  assert.match(rust, /\.create_new\(true\)/);
  assert.match(rust, /eq_ignore_ascii_case\("xlsx"\)/);
  assert.match(rust, /동일한 이름의 파일이 이미 있습니다/);
  assert.match(rust, /Excel 파일은 \.xlsx 확장자로만 저장/);
});
