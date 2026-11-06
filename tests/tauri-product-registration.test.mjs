import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const read = (path) => readFileSync(new URL("../" + path, import.meta.url), "utf8");

test("Registration UI is connected to the real preview and version-checked state save", () => {
  const ui = read("src/RegistrationManager.tsx");
  assert.match(ui, /previewRegistrationWorkbook\(current, file\)/);
  assert.match(ui, /prepareRegistrationCommit\(current, preview,/);
  assert.match(ui, /await onSave\(result\.next\)/);
  assert.match(ui, /await onRefresh\(\)/);
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

test("Native download only accepts two fixed registration XLSX names", () => {
  const bridge = read("src/tauri-bridge.ts");
  const rust = read("src-tauri/src/lib.rs");
  assert.match(bridge, /saveRegistrationWorkbook: \(kind, bytes\)/);
  assert.match(rust, /fn save_registration_workbook/);
  assert.match(rust, /"양식" => "상품등록양식"/);
  assert.match(rust, /"결과" => "상품등록결과"/);
  assert.match(rust, /\.create_new\(true\)/);
  assert.match(rust, /save_product_workbook, save_registration_workbook/);
});

test("Price workbook remains separate from the registration workbook", () => {
  assert.match(read("src/ProductPriceWorkbookTools.tsx"), /previewPriceWorkbook/);
  assert.match(read("src/ProductManager.tsx"), /<RegistrationManager state=\{state\} onSave=\{onSave\}/);
  assert.match(read("src/product-registration-xlsx.ts"), /exportRegistrationResults/);
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
  assert.match(client, /if \(path\) onNotice\("상품 등록 결과를 저장했습니다/);
  assert.match(price, /if \(path\) onNotice\("상품 가격표를 저장했습니다/);
});

test("Excel Save As does not overwrite an existing file or accept another extension", () => {
  const rust = read("src-tauri/src/lib.rs");
  assert.match(rust, /\.create_new\(true\)/);
  assert.match(rust, /eq_ignore_ascii_case\("xlsx"\)/);
  assert.match(rust, /동일한 이름의 파일이 이미 있습니다/);
  assert.match(rust, /상품 Excel 파일은 \.xlsx 확장자로만 저장/);
});
