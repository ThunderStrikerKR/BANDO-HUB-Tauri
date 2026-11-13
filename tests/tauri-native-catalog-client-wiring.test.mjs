import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const read=path=>readFileSync(new URL("../"+path,import.meta.url),"utf8");

test("all active product and client management save paths are native without TS fallback",()=>{
  const clients=read("src/ClientManager.tsx");
  const products=read("src/ProductManager.tsx");
  const clientExcel=read("src/ClientWorkbookTools.tsx");
  const productExcel=read("src/ProductSyncWorkbookTools.tsx");
  const registration=read("src/RegistrationManager.tsx");
  const bridge=read("src/tauri-bridge.ts");
  const dispatcher=read("src-tauri/src/business_core/mod.rs");
  const native=read("src-tauri/src/business_core/catalog_clients.rs");
  assert.match(bridge, /"catalog_clients"/);
  assert.match(dispatcher, /"catalog_clients" => catalog_clients::execute/);
  for(const [source,command] of [
    [clients,"upsert_client"],[clients,"archive_client"],
    [products,"upsert_product"],[products,"archive_product"],
    [clientExcel,"apply_client_workbook"],
    [productExcel,"apply_product_workbook"],
    [registration,"prepare_registration_commit"],
  ]){
    assert.match(source,new RegExp('"catalog_clients", "'+command+'"'));
  }
  for(const command of [
    "preview_client_rows","preview_registration_rows",
    "preview_product_sync_rows",
  ])assert.match(native,new RegExp('"'+command+'"'));
  assert.match(clientExcel,/await previewNativeClientWorkbook\(current, file\)/);
  assert.match(productExcel,/await previewNativeUnifiedProductWorkbook\(state, file\)/);
  assert.match(registration,/await previewNativeRegistrationWorkbook\(current, file\)/);
  assert.doesNotMatch(clientExcel,/applyClientWorkbook\(current, preview\)/);
  assert.doesNotMatch(productExcel,/applyUnifiedProductWorkbook\(state, review\)/);
  assert.doesNotMatch(registration,/prepareRegistrationCommit\(current, preview,/);
});
test("reviewed workbook writes remain backed up before single SQLite save",()=>{
  for(const source of [
    read("src/ClientWorkbookTools.tsx"),
    read("src/ProductSyncWorkbookTools.tsx"),
    read("src/RegistrationManager.tsx")
  ]){
    const backup=source.indexOf("await window.bando!.backup()");
    const save=source.indexOf("await onSave(");
    assert.ok(backup>=0&&save>backup,"native review must back up before saving");
  }
  const save=read("src-tauri/src/lib.rs");
  assert.match(save,/fn state_save\(/);
  assert.match(save,/validate_clients\(&current, &state\)\?/);
  assert.match(save,/validate_brands\(&current, &state\)\?/);
});
