//! Session D: native product and client management rules.
//! XLSX byte parsing and React editor drafts remain UI concerns. A validated
//! state transition is returned to the existing revision-checked SQLite saver.
use serde_json::{json, Value};
#[path = "catalog_clients/client_preview.rs"]
mod client_preview;
#[path = "catalog_clients/registration.rs"]
mod registration;
#[path = "catalog_clients/registration_preview.rs"]
mod registration_preview;
#[path = "catalog_clients/product_sync_preview.rs"]
mod product_sync_preview;
#[path = "catalog_clients/official_import.rs"]
mod official_import;
#[path = "catalog_clients/brands.rs"]
mod brands;
#[path = "catalog_clients/categories.rs"]
mod categories;
#[path = "catalog_clients/queries.rs"]
mod queries;
#[path = "catalog_clients/editor.rs"]
mod editor;
#[path = "catalog_clients/aliases.rs"]
mod aliases;
#[path = "catalog_clients/model_groups.rs"]
mod model_groups;
use unicode_normalization::UnicodeNormalization;
use url::Url;

fn field<'a>(v: &'a Value, name: &str) -> &'a str {
    v.get(name).and_then(Value::as_str).unwrap_or("")
}
fn value_present(v: &Value, name: &str) -> bool {
    !field(v, name).trim().is_empty()
}
fn items<'a>(v: &'a Value, name: &str) -> &'a [Value] {
    v.get(name).and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}
fn valid_money(value: &Value) -> bool {
    value.is_null() || value.as_u64().is_some_and(|n| n <= 9_007_199_254_740_991)
}
fn normalized_name(value: &str) -> String {
    value.nfkc().flat_map(char::to_lowercase)
        .filter(|c| !c.is_whitespace()).collect()
}
fn normalized_color(value: &str) -> String {
    let trimmed = value.trim();
    let key = trimmed.to_lowercase();
    match key.as_str() {
        "gold" | "골드" => "Gold".into(),
        "rose gold" | "로즈골드" => "Rose Gold".into(),
        "cosmo black" | "cosmoblack" | "코스모블랙" => "Cosmo Black".into(),
        "chrome" | "크롬" => "Chrome".into(),
        "black" | "블랙" | "검정" | "검정색" => "Black".into(),
        "gray" | "grey" | "그레이" | "회색" => "Gray".into(),
        "white" | "화이트" | "흰색" => "White".into(),
        "silver" | "실버" => "Silver".into(),
        "red" | "빨강" => "Red".into(),
        "blue" | "파랑" => "Blue".into(),
        "brown" | "브라운" => "Brown".into(),
        "clear" | "클리어" => "Clear".into(),
        "frost" | "프로스트" => "Frost".into(),
        _ => trimmed.into(),
    }
}
fn product_url_ok(value: &str) -> bool {
    let Ok(url) = Url::parse(value) else { return false };
    url.scheme() == "https"
        && ["bandostand.com", "www.bandostand.com",
            "bandomall.co.kr", "www.bandomall.co.kr"]
            .contains(&url.host_str().unwrap_or(""))
        && url.path().starts_with("/product/")
}
fn validate_client(state: &Value, client: &Value) -> Result<(), String> {
    if !value_present(client, "name") {
        return Err("거래처명을 입력하세요.".into());
    }
    if !value_present(client, "address") {
        return Err("거래처 주소를 입력하세요.".into());
    }
    if !value_present(client, "phone") && !value_present(client, "mobile") {
        return Err("거래처 전화번호 또는 휴대폰 번호를 입력하세요.".into());
    }
    let account_id = field(client, "preferredAccountId");
    if !account_id.is_empty()
        && !items(state.get("settings").unwrap_or(&Value::Null), "accounts")
            .iter().any(|a| field(a, "id") == account_id)
    {
        return Err("설정에 등록된 입금 계좌를 선택하세요.".into());
    }
    Ok(())
}
fn validate_product(state: &Value, product: &Value) -> Result<(), String> {
    // src/domain.ts::productSchema and validateProduct: one sale unit only,
    // valid immutable identity, nonnegative safe prices and trusted links.
    for key in ["id", "code", "name", "defaultColor", "createdAt", "updatedAt"] {
        if field(product, key).is_empty() {
            return Err(format!("상품 필수 정보가 없습니다: {key}"));
        }
    }
    if !product.get("category").is_some_and(Value::is_string) {
        return Err("상품 카테고리 정보가 올바르지 않습니다.".into());
    }
    if !["STORE", "FACTORY"].contains(&field(product, "origin")) {
        return Err("상품 출고구분이 올바르지 않습니다.".into());
    }
    if !product.get("active").is_some_and(Value::is_boolean) {
        return Err("상품 거래 상태가 올바르지 않습니다.".into());
    }
    let variants = items(product, "variants");
    if variants.len() != 1 {
        return Err("상품은 한 가지 판매 구성으로만 등록할 수 있습니다. 기존 복수 구성은 각각 별도 상품으로 전환하세요.".into());
    }
    for variant in variants {
        if !value_present(variant, "id") || !value_present(variant, "color") ||
            !["DEMO", "MANUAL", "OFFICIAL"].contains(&field(variant, "source")) ||
            !variant.get("url").is_some_and(Value::is_string) ||
            !["wholesale", "semi", "retail"].iter().all(|key|
                variant.get(*key).is_some_and(valid_money))
        {
            return Err("가격 기록의 필수 정보 또는 금액이 올바르지 않습니다.".into());
        }
    }
    // Preserve the original TS semantics: duplicate detection only applies
    // to a *new* product; editing an existing product is not blocked here.
    let existing = items(state, "products");
    let is_existing = existing.iter().any(|p| field(p, "id") == field(product, "id"));
    if !is_existing {
        let name = normalized_name(field(product, "name"));
        if existing.iter().any(|other| {
            field(other, "id") != field(product, "id")
                && other.get("active") != Some(&Value::Bool(false))
                && !value_present(other, "deletedAt")
                && !value_present(other, "supersededBy")
                && other.get("catalog") == product.get("catalog")
                && normalized_name(field(other, "name")) == name
        }) {
            return Err("같은 상품명이 이미 있습니다. 판매 구성을 구별할 수 있게 이름을 수정하세요.".into());
        }
    }
    if !variants.iter().any(|v|
        normalized_color(field(v, "color")) == normalized_color(field(product, "defaultColor")))
    {
        return Err("상품 색상이 가격 기록과 일치하지 않습니다.".into());
    }
    for variant in variants {
        let link = field(variant, "url");
        if !link.is_empty() && !product_url_ok(link) {
            return Err("상품 링크는 확인된 반도스탠드 / 반도몰 상세페이지 URL을 입력하세요.".into());
        }
    }
    Ok(())
}
fn upsert(state: &Value, entity: &Value, collection: &str) -> Result<Value, String> {
    let id = field(entity, "id");
    if id.is_empty() {
        return Err(format!("{collection} 항목 ID가 없습니다."));
    }
    let mut next = state.clone();
    let collection_rows = next.get_mut(collection).and_then(Value::as_array_mut)
        .ok_or_else(|| format!("{collection} 목록이 없습니다."))?;
    if let Some(index) = collection_rows.iter().position(|row| field(row, "id") == id) {
        collection_rows[index] = entity.clone();
    } else {
        collection_rows.push(entity.clone());
    }
    Ok(json!({"state":next}))
}
/// Original oracle: src/client-workbook.ts::applyClientWorkbook.
/// The Excel parser and per-row draft remain in TypeScript; the approved
/// collection update is owned by Rust and saved by the existing SQLite layer.
fn apply_client_workbook(state: &Value, preview: &Value) -> Result<Value, String> {
    let revision = state.get("revision").and_then(Value::as_i64).unwrap_or(0);
    if revision != preview.get("revision").and_then(Value::as_i64).unwrap_or(-1) {
        return Err("검토 후 거래처 데이터가 변경되었습니다. Excel을 다시 검증하세요.".into());
    }
    if items(preview, "rows").iter().any(|row|
        ["ERROR", "HOLD"].contains(&field(row, "status")))
    {
        return Err("중복 또는 오류 항목이 남아 있어 Excel 변경사항을 저장할 수 없습니다.".into());
    }
    let mut next = state.clone();
    let mut created = 0_i64;
    let mut updated = 0_i64;
    for row in items(preview, "rows") {
        let status = field(row, "status");
        if status != "ADD" && status != "UPDATE" { continue; }
        let Some(client) = row.get("client").filter(|c| !c.is_null()) else { continue };
        validate_client(&next, client)?;
        let clients = next.get_mut("clients").and_then(Value::as_array_mut)
            .ok_or("거래처 목록이 없습니다.")?;
        let id = field(client, "id");
        if status == "ADD" {
            if clients.iter().any(|c| field(c, "id") == id) {
                return Err("거래처 ID 충돌입니다.".into());
            }
            clients.push(client.clone());
            created += 1;
        } else {
            let index = clients.iter().position(|c| field(c, "id") == id
                && !value_present(c, "deletedAt"))
                .ok_or("기존 거래처 정보를 확인할 수 없습니다.")?;
            clients[index] = client.clone();
            updated += 1;
        }
    }
    Ok(json!({"next":next, "created":created, "updated":updated}))
}

/// Original oracle: src/product-sync-workbook.ts::applyProductSyncWorkbook,
/// used also by the unified Excel importer. Preview construction is still
/// TypeScript-owned; the final collection write is a native Rust decision.
fn apply_product_workbook(state: &Value, preview: &Value) -> Result<Value, String> {
    let revision = state.get("revision").and_then(Value::as_i64).unwrap_or(0);
    if revision != preview.get("revision").and_then(Value::as_i64).unwrap_or(-1) {
        return Err("검토 후 데이터가 변경되었습니다. 파일을 다시 검증하세요.".into());
    }
    if items(preview, "rows").iter().any(|row|
        ["ERROR", "HOLD"].contains(&field(row, "status")))
    {
        return Err("상품 Excel에 오류나 중복 의심 항목이 있습니다. 변경사항을 저장하지 않습니다.".into());
    }
    let products = preview.get("products").filter(|v| v.is_array())
        .ok_or("상품 Excel 후보 목록이 없습니다.")?;
    let mut next = state.clone();
    next["products"] = products.clone();
    Ok(json!({
        "next":next,
        "createdProducts":preview.get("createdProducts").cloned().unwrap_or(json!(0)),
        "updatedProducts":preview.get("updatedProducts").cloned().unwrap_or(json!(0)),
        "createdOptions":preview.get("createdOptions").cloned().unwrap_or(json!(0)),
        "updatedOptions":preview.get("updatedOptions").cloned().unwrap_or(json!(0))
    }))
}

fn archive_client(state: &Value, id: &str, at: &str) -> Result<Value, String> {
    if id.is_empty() || at.is_empty() { return Err("거래처 삭제 요청 정보가 없습니다.".into()); }
    let mut next = state.clone();
    let clients = next.get_mut("clients").and_then(Value::as_array_mut)
        .ok_or("거래처 목록이 없습니다.")?;
    let client = clients.iter_mut().find(|client| field(client, "id") == id)
        .ok_or("삭제할 거래처를 찾지 못했습니다.")?;
    client["deletedAt"] = json!(at);
    Ok(json!({"state":next}))
}

/// Original productKey uses a compact upper-case model code and a stable
/// single-sale-variant ID. Deletion must not relink a later catalog import.
fn product_key(product: &Value) -> String {
    let catalog = product.get("catalog").and_then(Value::as_str).unwrap_or_else(|| {
        if items(product, "variants").iter().any(|v| field(v, "source") == "DEMO") {
            "DEMO"
        } else { "BANDOSTAND" }
    });
    let code: String = field(product, "code").trim().chars()
        .flat_map(char::to_uppercase).filter(|c| !c.is_whitespace()).collect();
    let suffix = if product.get("saleUnit") == Some(&Value::Bool(true)) {
        format!("|sale:{}", items(product, "variants").first()
            .map(|v| field(v, "id")).unwrap_or("undefined"))
    } else { String::new() };
    format!("{catalog}|{code}{suffix}")
}
fn archive_product(state: &Value, id: &str, at: &str) -> Result<Value, String> {
    if id.is_empty() || at.is_empty() { return Err("상품 삭제 요청 정보가 없습니다.".into()); }
    let mut next = state.clone();
    let products = next.get_mut("products").and_then(Value::as_array_mut)
        .ok_or("상품 목록이 없습니다.")?;
    let product = products.iter_mut().find(|p| field(p, "id") == id)
        .ok_or("삭제할 상품을 찾지 못했습니다.")?;
    let key = product_key(product);
    product["deletedAt"] = json!(at);
    let mut keys = items(state, "deletedProductKeys").to_vec();
    if !keys.iter().any(|entry| entry.as_str() == Some(key.as_str())) {
        keys.push(json!(key));
    }
    next["deletedProductKeys"] = json!(keys);
    let aliases = items(state, "aliases").iter()
        .filter(|alias| field(alias, "productId") != id)
        .cloned().collect::<Vec<_>>();
    next["aliases"] = json!(aliases);
    Ok(json!({"state":next}))
}

pub fn execute(operation: &str, payload: Value) -> Result<Value, String> {
    // The official cached-link list is a read-only report query and does
    // not require loading the user database state.
    if operation == "official_links" { return queries::execute(operation, &payload); }
    let state = payload.get("state").ok_or("현재 상태가 없습니다.")?;
    match operation {
        "preview_client_rows" => client_preview::preview(&payload),
        "upsert_product_from_editor" => editor::execute(&payload),
        "save_alias" | "alias_problems" | "alias_problems_one" => aliases::execute(operation,&payload),
        "validate_model_groups" | "validate_model_group_products" => model_groups::execute(operation,&payload),
        "client_candidates" | "classified_products" | "category_ids" |
        "management_products" | "search_products" | "representative_products" | "suggest_group_representative" |
        "official_links" => queries::execute(operation, &payload),
        "upsert_brand" | "validate_brands" => brands::execute(operation, &payload),
        "change_category" | "delete_category" | "legacy_add_category" |
        "legacy_rename_category" | "validate_categories" => categories::execute(operation, &payload),
        "apply_official_product_import" => official_import::apply(&payload),
        "prepare_registration_commit" => registration::commit(&payload),
        "preview_registration_rows" => registration_preview::preview(&payload),
        "preview_product_sync_rows" => product_sync_preview::preview(&payload),
        "archive_client" => archive_client(
            state, field(&payload, "clientId"), field(&payload, "at")),
        "archive_product" => archive_product(
            state, field(&payload, "productId"), field(&payload, "at")),
        "apply_client_workbook" => apply_client_workbook(
            state, payload.get("preview").ok_or("거래처 Excel 검토 자료가 없습니다.")?),
        "apply_product_workbook" => apply_product_workbook(
            state, payload.get("preview").ok_or("상품 Excel 검토 자료가 없습니다.")?),
        "validate_client" => {
            validate_client(state, payload.get("client").ok_or("거래처 정보가 없습니다.")?)?;
            Ok(json!({"valid":true}))
        }
        "upsert_client" => {
            let client = payload.get("client").ok_or("거래처 정보가 없습니다.")?;
            validate_client(state, client)?;
            upsert(state, client, "clients")
        }
        "validate_product" => {
            validate_product(state, payload.get("product").ok_or("상품 정보가 없습니다.")?)?;
            Ok(json!({"valid":true}))
        }
        "upsert_product" => {
            let product = payload.get("product").ok_or("상품 정보가 없습니다.")?;
            validate_product(state, product)?;
            upsert(state, product, "products")
        }
        _ => Err(format!("지원하지 않는 상품/거래처 관리 업무입니다: {operation}")),
    }
}

#[cfg(test)]
mod tests {
    use super::execute;
    use serde_json::json;
    fn state() -> serde_json::Value {
        json!({"revision":11,"clients":[],"products":[],"settings":{
            "accounts":[{"id":"account-1"}]},"orders":[{"id":"old-order"}]})
    }
    fn client() -> serde_json::Value {
        json!({"id":"client-1","name":"악기사","address":"서울 종로구",
            "phone":"02-1234-5678","preferredAccountId":"account-1"})
    }
    fn product() -> serde_json::Value {
        json!({"id":"product-1","code":"product-1","name":"BD 709 타공",
            "category":"보면대","origin":"FACTORY","defaultColor":"Black",
            "active":true,"createdAt":"2026-11-13","updatedAt":"2026-11-13",
            "catalog":"BANDOSTAND","variants":[{
                "id":"variant-1","color":"블랙","url":"","source":"MANUAL",
                "wholesale":10000,"semi":11000,"retail":12000
            }]})
    }
    #[test]
    fn client_is_validated_and_unrelated_order_is_preserved() {
        let s=state();
        let result=execute("upsert_client",json!({"state":s,"client":client()})).unwrap();
        assert_eq!(result["state"]["clients"][0]["id"],"client-1");
        assert_eq!(result["state"]["orders"][0]["id"],"old-order");
        assert_eq!(s["clients"].as_array().unwrap().len(),0);
    }
    #[test]
    fn incomplete_client_and_stale_account_cannot_save() {
        let mut c=client();
        c["address"]=json!("");
        assert!(execute("upsert_client",json!({"state":state(),"client":c}))
            .unwrap_err().contains("주소"));
        let mut c=client();
        c["preferredAccountId"]=json!("missing");
        assert!(execute("upsert_client",json!({"state":state(),"client":c}))
            .unwrap_err().contains("계좌"));
    }
    #[test]
    fn product_name_and_color_are_validated_without_editing_past_orders() {
        let s=state();
        let result=execute("upsert_product",json!({"state":s,"product":product()})).unwrap();
        assert_eq!(result["state"]["products"][0]["variants"][0]["wholesale"],10000);
        assert_eq!(result["state"]["orders"][0]["id"],"old-order");
        let mut bad=product();
        bad["defaultColor"]=json!("Rose Gold");
        assert!(execute("upsert_product",json!({"state":s,"product":bad}))
            .unwrap_err().contains("색상"));
    }
    #[test]
    fn a_new_duplicate_product_is_rejected_but_edit_is_allowed() {
        let mut s=state();
        s["products"]=json!([product()]);
        let mut new=product();
        new["id"]=json!("product-2");
        new["name"]=json!("ＢＤ ７０９ 타공");
        assert!(execute("upsert_product",json!({"state":s,"product":new}))
            .unwrap_err().contains("같은 상품명"));
        let mut update=product();
        update["name"]=json!("BD 709 타공 / 수정");
        assert!(execute("upsert_product",json!({"state":s,"product":update})).is_ok());
    }
    #[test]
    fn archival_keeps_history_and_is_not_a_physical_delete() {
        let mut s=state();
        let mut p=product();
        p["saleUnit"]=json!(true);
        p["code"]=json!("bd 709");
        s["products"]=json!([p]);
        s["clients"]=json!([client()]);
        s["aliases"]=json!([
            {"id":"a1","productId":"product-1","text":"보면대"},
            {"id":"a2","productId":"other","text":"기타"}
        ]);
        let result=execute("archive_product",json!({
            "state":s,"productId":"product-1","at":"2026-11-14T00:00:00+09:00"
        })).unwrap();
        assert_eq!(result["state"]["products"][0]["deletedAt"],"2026-11-14T00:00:00+09:00");
        assert_eq!(result["state"]["deletedProductKeys"][0],"BANDOSTAND|BD709|sale:variant-1");
        assert_eq!(result["state"]["aliases"].as_array().unwrap().len(),1);
        assert_eq!(result["state"]["orders"][0]["id"],"old-order");
        let client_result=execute("archive_client",json!({
            "state":result["state"],"clientId":"client-1",
            "at":"2026-11-14T00:00:00+09:00"
        })).unwrap();
        assert_eq!(client_result["state"]["clients"][0]["deletedAt"],
            "2026-11-14T00:00:00+09:00");
        assert_eq!(client_result["state"]["orders"][0]["id"],"old-order");
    }
    #[test]
    fn invalid_archive_target_is_rejected_without_any_replacements() {
        let s=state();
        assert!(execute("archive_product",json!({
            "state":s,"productId":"missing","at":"2026-11-14"
        })).is_err());
        assert!(execute("archive_client",json!({
            "state":s,"clientId":"missing","at":"2026-11-14"
        })).is_err());
    }
    #[test]
    fn approved_workbook_transitions_preserve_all_existing_orders() {
        let s=state();
        let p=product();
        let result=execute("apply_product_workbook",json!({
            "state":s,"preview":{
                "revision":11,"products":[p],"rows":[{"status":"ADD"}],
                "createdProducts":1,"updatedProducts":0,
                "createdOptions":1,"updatedOptions":0
            }
        })).unwrap();
        assert_eq!(result["createdProducts"],1);
        assert_eq!(result["next"]["orders"][0]["id"],"old-order");
        let stale=execute("apply_product_workbook",json!({
            "state":s,"preview":{"revision":10,"products":[],"rows":[]}
        }));
        assert!(stale.unwrap_err().contains("검토 후 데이터"));
        let mut approved=client();
        approved["id"]=json!("client-1");
        let result=execute("apply_client_workbook",json!({
            "state":s,"preview":{"revision":11,"rows":[{"status":"ADD","client":approved}]}
        })).unwrap();
        assert_eq!(result["created"],1);
        assert_eq!(result["next"]["orders"][0]["id"],"old-order");
    }
    #[test]
    fn untrusted_url_and_negative_prices_are_rejected() {
        let s=state();
        let mut p=product();
        p["variants"][0]["url"]=json!("https://evil.example/product/709");
        assert!(execute("validate_product",json!({"state":s,"product":p}))
            .unwrap_err().contains("링크"));
        let mut p=product();
        p["variants"][0]["retail"]=json!(-1);
        assert!(execute("validate_product",json!({"state":s,"product":p})).is_err());
    }
}
