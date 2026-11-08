//! One-time, conservative catalog name enrichment for independent sale units.
//! The mapping records the pre-update stock name and exact price-record ID.
//! The branded prefix alone is removed from active employee-edited names;
//! all other wording, order snapshots, prices and records remain untouched.
use super::*;
use serde_json::Value;

pub(super) fn apply_to_state(state: &mut Value) -> Result<usize, String> {
    let mapping: Value = serde_json::from_str(include_str!(
        "../resources/product-name-enrichment-20261109.json"
    )).map_err(err)?;
    let updates = mapping["changes"].as_array()
        .ok_or("상품명 변경 목록이 누락됐습니다.")?;
    let products = state["products"].as_array_mut()
        .ok_or("상품명 갱신 전 상품 목록을 확인할 수 없습니다.")?;
    let mut changed = 0_usize;
    for update in updates {
        let Some(product) = products.iter_mut().find(|p| p["id"] == update["id"]) else {
            continue;
        };
        if product["name"] != update["oldName"]
            || product["originalName"] != update["originalName"]
            || product["variants"].as_array().is_none_or(|v| v.len() != 1)
            || product["variants"][0]["id"] != update["priceRecordId"]
            || product["deletedAt"].as_str().is_some()
            || product["supersededBy"].as_str().is_some()
        {
            continue; // Do not overwrite employee edits or ambiguous records.
        }
        let Some(new_name) = update["newName"].as_str() else {
            return Err("상품명 변경 목록의 새 이름이 올바르지 않습니다.".into());
        };
        if new_name.trim().is_empty() || new_name.contains('◆') {
            return Err("상품명 데이터에는 공장 엑셀용 구분 기호를 저장할 수 없습니다.".into());
        }
        product["name"] = Value::String(new_name.to_string());
        changed += 1;
    }

    // Older SQLite databases can still contain official website titles such as
    // "반도스탠드 BD Desk JS-3 Black 검정 (자바라 길이 43cm)".
    // Only use the full curated name when the source text matches exactly.
    // The complete, independently curated 360-item catalog is authoritative
    // only when the stored name is exactly the unedited official original.
    let catalog: Value = serde_json::from_str(include_str!("../resources/state-seed.json"))
        .map_err(err)?;
    let reference = catalog["products"].as_array()
        .ok_or("공식 상품명 기준표가 누락됐습니다.")?;
    let mut catalog_by_id = std::collections::HashMap::new();
    for candidate in reference {
        let id = candidate["id"].as_str()
            .ok_or("공식 상품명 기준표의 상품 ID가 누락됐습니다.")?;
        if catalog_by_id.insert(id, candidate).is_some() {
            return Err(format!("공식 상품명 기준표의 상품 ID가 중복됐습니다: {id}"));
        }
    }
    // Source importers sometimes collapse spaces in expressions such as
    // "자바라 길이" -> "자바라길이". Compare only whitespace-insensitively,
    // never by prefix alone; fallback below keeps all employee-added wording.
    let same_official_text = |a: &Value, b: &Value| -> bool {
        match (a.as_str(), b.as_str()) {
            (Some(left), Some(right)) =>
                left.chars().filter(|ch| !ch.is_whitespace())
                    .eq(right.chars().filter(|ch| !ch.is_whitespace())),
            _ => false,
        }
    };
    for product in products.iter_mut() {
        let Some(id) = product["id"].as_str() else { continue };
        let Some(reference) = catalog_by_id.get(id) else { continue };
        let Some(existing_name) = product["name"].as_str() else { continue };
        if !existing_name.starts_with("반도스탠드 ")
            || !same_official_text(&product["name"], &reference["originalName"])
            || product["variants"].as_array().is_none_or(|v| v.len() != 1)
            || product["variants"][0]["id"] != reference["variants"][0]["id"]
            || product["deletedAt"].as_str().is_some()
            || product["supersededBy"].as_str().is_some()
            || product["priceHistory"].as_array().is_some_and(|history|
                history.iter().any(|entry| entry["field"] == "name"))
        {
            continue;
        }
        let Some(curated) = reference["name"].as_str() else {
            return Err(format!("상품 {id}의 정리된 상품명이 누락됐습니다."));
        };
        if curated.trim().is_empty()
            || curated.starts_with("반도스탠드 ")
            || curated.contains('◆')
        {
            return Err(format!("상품 {id}의 정리된 상품명 표기가 올바르지 않습니다."));
        }
        product["name"] = Value::String(curated.to_string());
        changed += 1;
    }

    // Guaranteed display cleanup: preexisting DB rows may lack siteCode,
    // catalog or source metadata, or contain genuine employee-edited names.
    // The strict mapping above cannot identify all such rows. Remove ONLY
    // the unwanted leading brand token; never change the remaining product
    // wording, identity, price, description, or historical snapshots.
    for product in products.iter_mut() {
        if product["deletedAt"].as_str().is_some()
            || product["supersededBy"].as_str().is_some()
        {
            continue;
        }
        let Some(existing) = product["name"].as_str() else { continue };
        let Some(tail) = existing.strip_prefix("반도스탠드 ") else { continue };
        let clean = tail.trim_start();
        if clean.is_empty() {
            return Err("상품명에서 브랜드명을 제거하면 이름이 비어 갱신할 수 없습니다.".into());
        }
        product["name"] = Value::String(clean.to_string());
        changed += 1;
    }

    // Update the exact previously seeded Desk labels only. Every visible
    // selling configuration remains an independent item with one price ID.
    // Employee-specific product labels are never overwritten.
    let desk_old_names = [
        ("bando-site-247", "BD Desk TS-1 / 미니형 마이크 스탠드"),
        ("bando-site-248", "BD Desk TS-2 / 미니형 마이크 스탠드"),
        ("bando-site-249", "BD Desk TS-3 / 미니형 마이크 스탠드"),
        ("bando-site-250", "BD Desk IS-3 / 바 길이 26cm"),
        ("bando-site-251", "BD Desk IS-2 / 바 길이 15cm"),
        ("bando-site-252", "BD Desk IS-1 / 바 길이 10cm"),
    ];
    for (id, old_name) in desk_old_names {
        let Some(reference) = catalog_by_id.get(id) else {
            return Err(format!("Desk 제품 기준표 누락: {id}"));
        };
        let Some(product) = products.iter_mut().find(|p| p["id"] == id) else {
            continue;
        };
        if product["name"].as_str() != Some(old_name)
            || product["variants"].as_array().is_none_or(|v| v.len() != 1)
            || product["variants"][0]["id"] != reference["variants"][0]["id"]
            || product["deletedAt"].as_str().is_some()
            || product["supersededBy"].as_str().is_some()
        {
            continue;
        }
        let Some(new_name) = reference["name"].as_str() else {
            return Err(format!("Desk 제품 새 이름 누락: {id}"));
        };
        if new_name.contains('◆') || new_name.trim().is_empty() {
            return Err(format!("Desk 제품명 규칙 위반: {id}"));
        }
        product["name"] = Value::String(new_name.to_string());
        // "길이 확인 필요" was an old placeholder, not an actual specification.
        if product["subtitle"].as_str() == Some("길이 확인 필요") {
            product["subtitle"] = Value::String(String::new());
        }
        changed += 1;
    }

    // These are physically duplicate sale configurations, not separate
    // options. Keep both original IDs and frozen order references in SQLite,
    // but retire the redundant standalone site listings from all new sales.
    let retired_music_trays = [
        ("bando-site-77", "bando-77-single",
         "sku:bando-site-237:bando-237-P00000JC000H",
         "bando-237-P00000JC000H"),
        ("bando-site-78", "bando-78-single",
         "sku:bando-site-237:bando-237-P00000JC000I",
         "bando-237-P00000JC000I"),
    ];
    for (duplicate_id, old_variant_id, canonical_id, canonical_variant_id)
        in retired_music_trays
    {
        let Some(canonical) = products.iter().find(|p| p["id"] == canonical_id) else {
            return Err(format!("중복 뮤직 트레이의 정본 상품을 찾을 수 없습니다: {canonical_id}"));
        };
        if canonical["variants"].as_array().is_none_or(|v| v.len() != 1)
            || canonical["variants"][0]["id"] != canonical_variant_id
            || canonical["deletedAt"].as_str().is_some()
            || canonical["supersededBy"].as_str().is_some()
        {
            return Err(format!("중복 뮤직 트레이 정본 식별자가 변경됐습니다: {canonical_id}"));
        }
        let Some(duplicate) = products.iter_mut().find(|p| p["id"] == duplicate_id) else {
            continue;
        };
        if duplicate["variants"].as_array().is_none_or(|v| v.len() != 1)
            || duplicate["variants"][0]["id"] != old_variant_id
            || duplicate["deletedAt"].as_str().is_some()
            || duplicate["supersededBy"].as_str().is_some_and(|to| to != canonical_id)
        {
            continue;
        }
        if duplicate["supersededBy"].as_str() != Some(canonical_id)
            || duplicate["active"] != false
        {
            duplicate["supersededBy"] = Value::String(canonical_id.to_string());
            duplicate["active"] = Value::Bool(false);
            changed += 1;
        }
    }

    // A separated sale item must not list all other colors as its subtitle.
    // Preserve any description the employee has already changed.
    for product in products.iter_mut() {
        let id = product["id"].as_str().unwrap_or("");
        if [
            "sku:bando-site-237:bando-237-P00000JC000H",
            "sku:bando-site-237:bando-237-P00000JC000I",
            "sku:bando-site-237:bando-237-P00000JC000J",
        ].contains(&id)
            && product["subtitle"].as_str() == Some("다크그린, 와인, 그레이 옵션")
        {
            if let Some(object) = product.as_object_mut() {
                object.remove("subtitle");
                changed += 1;
            }
        }
    }

    // Never silently claim completion while a visible active product still
    // carries the same unwanted prefix. All writes happen only after this.
    if let Some(product) = products.iter().find(|p| {
        p["active"] != false
            && p["deletedAt"].as_str().is_none()
            && p["supersededBy"].as_str().is_none()
            && p["name"].as_str().is_some_and(|name| name.starts_with("반도스탠드 "))
    }) {
        return Err(format!(
            "상품명 브랜드 접두어 정리 실패: {}",
            product["id"].as_str().unwrap_or("ID 없음")
        ));
    }
    Ok(changed)
}

pub(super) fn apply(conn: &mut Connection, base: &Path) -> Result<usize, String> {
    let mut state = get_snapshot(conn)?;
    let revision = state["revision"].as_u64()
        .ok_or("상품명 갱신 전 데이터 리비전을 확인할 수 없습니다.")?;
    let changed = apply_to_state(&mut state)?;
    if changed == 0 { return Ok(0); }
    // Already-relational installations need their own verified safety backup.
    // Legacy 303->360 migrations enrich names *inside their prior migration*
    // and thus do not create a second backup or bump revision twice.
    backup_manager::manual_backup(conn, base)?;
    write_snapshot(conn, state, revision, false)?;
    Ok(changed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn changes_exact_old_names_but_not_employee_names_or_prices() {
        let salt = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let base = std::env::temp_dir().join(format!(
            "bando-name-enrichment-{}-{salt}", std::process::id()
        ));
        std::fs::create_dir_all(&base).unwrap();
        let path = base.join("state.sqlite");
        let mut db = initialize_database(&path).unwrap();
        let mut before = get_snapshot(&db).unwrap();
        let first = before["products"].as_array().unwrap().iter()
            .position(|p| p["id"] == "bando-site-312").unwrap();
        let second = before["products"].as_array().unwrap().iter()
            .position(|p| p["id"] == "bando-site-300").unwrap();
        let original_price = before["products"][first]["variants"].clone();
        before["products"][first]["name"] = json!("BD 777");
        before["products"][second]["name"] = json!("직원 직접 지정 이름");
        let before_orders = before["orders"].clone();
        let before_clients = before["clients"].clone();
        let expected_revision = before["revision"].as_u64().unwrap();
        write_snapshot(&mut db, before, expected_revision, false).unwrap();
        assert_eq!(apply(&mut db, &base).unwrap(), 1);
        let after = get_snapshot(&db).unwrap();
        assert_eq!(after["products"][first]["name"], "BD 777 / 고정형 보면대");
        assert_eq!(after["products"][second]["name"], "직원 직접 지정 이름");
        assert_eq!(after["products"][first]["variants"], original_price);
        assert_eq!(after["orders"], before_orders);
        assert_eq!(after["clients"], before_clients);
        assert_eq!(apply(&mut db, &base).unwrap(), 0);
        assert_eq!(backup_manager::list_backups(&base).unwrap().len(), 1);
        drop(db);
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn stored_official_branded_names_migrate_to_curated_names_without_changing_business_data() {
        let salt = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let base = std::env::temp_dir().join(format!(
            "bando-original-title-migration-{}-{salt}", std::process::id()
        ));
        std::fs::create_dir_all(&base).unwrap();
        let mut db = initialize_database(&base.join("state.sqlite")).unwrap();
        let mut state = get_snapshot(&db).unwrap();
        let sites = ["246", "255", "254", "249"];
        let mut changed_ids = Vec::new();
        for product in state["products"].as_array_mut().unwrap() {
            if sites.iter().any(|site| product["siteId"].as_str() == Some(site)) {
                product["name"] = if product["siteId"] == "246" {
                    // A real screen used "자바라길이", while the reference
                    // contains "자바라 길이": both are the same source title.
                    json!("반도스탠드 BD Desk JS-3 Black 검정 (자바라길이 43cm)")
                } else {
                    product["originalName"].clone()
                };
                changed_ids.push(product["id"].as_str().unwrap().to_string());
            }
            // Staff-added wording remains, while the unwanted prefix alone is removed.
            if product["siteId"] == "310" {
                product["name"] = json!(
                    "반도스탠드 BD Desk JS-4 Black 검정 / 직원 직접 수정"
                );
            }
            // Even if the employee set the name back to the original, a recorded
            // manual name edit is authoritative over automatic cleanup.
            if product["siteId"] == "245" {
                product["name"] = product["originalName"].clone();
                product["priceHistory"] = json!([{
                    "field": "name", "source": "MANUAL",
                    "before": "직원 기록 이전 이름", "after": "공식 이름",
                    "at": "2026-11-09T00:00:00+09:00"
                }]);
            }
        }
        assert_eq!(changed_ids.len(), sites.len());
        let prior = state.clone();
        let revision = state["revision"].as_u64().unwrap();
        write_snapshot(&mut db, state, revision, false).unwrap();

        assert_eq!(apply(&mut db, &base).unwrap(), 6);
        let after = get_snapshot(&db).unwrap();
        let by_site = |site: &str| -> Value {
            after["products"].as_array().unwrap().iter()
                .find(|p| p["siteId"].as_str() == Some(site)).unwrap().clone()
        };
        assert_eq!(by_site("246")["name"], "BD Desk JS-3 / 블랙 / 자바라 길이 43cm");
        assert_eq!(by_site("255")["name"], "BD Desk JS-3 / 실버 / 자바라 길이 43cm");
        assert_eq!(by_site("254")["name"], "BD Desk JS-2 / 실버 / 자바라 길이 35cm");
        assert_eq!(by_site("249")["name"], "BD Desk TS-3 / 미니형 마이크 스탠드");
        assert_eq!(by_site("310")["name"],
            "BD Desk JS-4 Black 검정 / 직원 직접 수정");
        assert_eq!(by_site("245")["name"],
            "BD Desk JS-2 Black 검정 (자바라 길이 35cm)");

        for (before, after_product) in prior["products"].as_array().unwrap()
            .iter().zip(after["products"].as_array().unwrap())
        {
            assert_eq!(before["id"], after_product["id"]);
            assert_eq!(before["originalName"], after_product["originalName"]);
            assert_eq!(before["variants"], after_product["variants"]);
            assert_eq!(before["subtitle"], after_product["subtitle"]);
            assert_eq!(before["priceHistory"], after_product["priceHistory"]);
        }
        assert_eq!(after["orders"], prior["orders"]);
        assert_eq!(after["clients"], prior["clients"]);
        assert_eq!(after["aliases"], prior["aliases"]);
        assert_eq!(apply(&mut db, &base).unwrap(), 0);
        assert_eq!(backup_manager::list_backups(&base).unwrap().len(), 1);
        drop(db);
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn metadata_mismatch_and_manual_suffix_still_remove_prefix_only() {
        let catalog: Value = serde_json::from_str(include_str!(
            "../resources/state-seed.json"
        )).unwrap();
        let mut legacy = catalog.clone();
        let target = legacy["products"].as_array_mut().unwrap().iter_mut()
            .find(|p| p["siteId"] == "246").unwrap();
        let original_price = target["variants"].clone();
        let original_name = target["originalName"].clone();
        target["name"] = json!(
            "반도스탠드 BD Desk JS-3 Black 검정 (자바라 길이 43cm) / 직원 별도 메모"
        );
        target["siteCode"] = Value::Null; // Old database has incomplete optional metadata.
        target["priceHistory"] = json!([{"field":"name","source":"MANUAL"}]);
        let before = target.clone();
        assert_eq!(apply_to_state(&mut legacy).unwrap(), 1);
        let updated = legacy["products"].as_array().unwrap().iter()
            .find(|p| p["siteId"] == "246").unwrap();
        assert_eq!(
            updated["name"],
            "BD Desk JS-3 Black 검정 (자바라 길이 43cm) / 직원 별도 메모"
        );
        assert_eq!(updated["originalName"], original_name);
        assert_eq!(updated["variants"], original_price);
        assert_eq!(updated["siteCode"], before["siteCode"]);
        assert_eq!(updated["priceHistory"], before["priceHistory"]);
        assert_eq!(apply_to_state(&mut legacy).unwrap(), 0);
    }

    #[test]
    fn missing_site_metadata_does_not_block_curated_name_when_official_title_matches() {
        let catalog: Value = serde_json::from_str(include_str!(
            "../resources/state-seed.json"
        )).unwrap();
        let mut legacy = catalog.clone();
        let target = legacy["products"].as_array_mut().unwrap().iter_mut()
            .find(|p| p["siteId"] == "255").unwrap();
        target["name"] = target["originalName"].clone();
        target["siteCode"] = Value::Null;
        assert_eq!(apply_to_state(&mut legacy).unwrap(), 1);
        let updated = legacy["products"].as_array().unwrap().iter()
            .find(|p| p["siteId"] == "255").unwrap();
        assert_eq!(updated["name"], "BD Desk JS-3 / 실버 / 자바라 길이 43cm");
        assert_eq!(updated["siteCode"], Value::Null);
        assert_eq!(apply_to_state(&mut legacy).unwrap(), 0);
    }

    #[test]
    fn full_legacy_site_titles_normalize_to_all_360_curated_independent_names() {
        let curated: Value = serde_json::from_str(include_str!(
            "../resources/state-seed.json"
        )).unwrap();
        let mut outdated = curated.clone();
        let mut official = 0;
        for product in outdated["products"].as_array_mut().unwrap() {
            if product["originalName"].as_str().is_some_and(
                |name| name.starts_with("반도스탠드 ")
            ) {
                product["name"] = product["originalName"].clone();
                official += 1;
            }
        }
        assert_eq!(official, 357);
        assert_eq!(apply_to_state(&mut outdated).unwrap(), official);
        assert_eq!(outdated["products"], curated["products"]);
        assert_eq!(apply_to_state(&mut outdated).unwrap(), 0);
    }

    #[test]
    fn actual_sqlite_reopens_old_desk_labels_and_duplicate_trays_without_data_loss() {
        let salt = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let base = std::env::temp_dir().join(format!(
            "bando-desk-tray-dedupe-{}-{salt}", std::process::id()
        ));
        std::fs::create_dir_all(&base).unwrap();
        let mut db = initialize_database(&base.join("state.sqlite")).unwrap();
        let mut before = get_snapshot(&db).unwrap();
        let old_desk = [
            ("247", "BD Desk TS-1 / 미니형 마이크 스탠드"),
            ("248", "BD Desk TS-2 / 미니형 마이크 스탠드"),
            ("249", "BD Desk TS-3 / 미니형 마이크 스탠드"),
            ("250", "BD Desk IS-3 / 바 길이 26cm"),
            ("251", "BD Desk IS-2 / 바 길이 15cm"),
            ("252", "BD Desk IS-1 / 바 길이 10cm"),
        ];
        for product in before["products"].as_array_mut().unwrap() {
            for (site, old_name) in old_desk {
                if product["siteId"].as_str() == Some(site) {
                    product["name"] = json!(old_name);
                    if ["247", "248", "249"].contains(&site) {
                        product["subtitle"] = json!("길이 확인 필요");
                    }
                }
            }
            let id = product["id"].as_str().unwrap_or("");
            if id == "bando-site-77" || id == "bando-site-78" {
                product["active"] = json!(true);
                product.as_object_mut().unwrap().remove("supersededBy");
            }
            if id.starts_with("sku:bando-site-237:") {
                product["subtitle"] = json!("다크그린, 와인, 그레이 옵션");
            }
        }
        let prices = before["products"].as_array().unwrap().iter()
            .map(|p| p["variants"].clone()).collect::<Vec<_>>();
        let orders = before["orders"].clone();
        let clients = before["clients"].clone();
        let revision = before["revision"].as_u64().unwrap();
        write_snapshot(&mut db, before, revision, false).unwrap();

        assert_eq!(apply(&mut db, &base).unwrap(), 11);
        let after = get_snapshot(&db).unwrap();
        let products = after["products"].as_array().unwrap();
        assert_eq!(products.len(), 360);
        assert_eq!(products.iter().filter(|p| p["active"] != false
            && p["supersededBy"].as_str().is_none()
            && p["deletedAt"].as_str().is_none()).count(), 358);
        for (site, expected) in [
            ("247", "BD Desk TS-1 / Bar 길이 15cm"),
            ("248", "BD Desk TS-2 / Bar 길이 22cm"),
            ("249", "BD Desk TS-3 / Bar 길이 32cm"),
            ("250", "BD Desk IS-3 / Bar 길이 26cm"),
            ("251", "BD Desk IS-2 / Bar 길이 15cm"),
            ("252", "BD Desk IS-1 / Bar 길이 10cm"),
        ] {
            let p = products.iter().find(|p| p["siteId"].as_str() == Some(site)).unwrap();
            assert_eq!(p["name"], expected);
            assert!(p["subtitle"].as_str().unwrap_or("").is_empty());
        }
        for (id, successor) in [
            ("bando-site-77", "sku:bando-site-237:bando-237-P00000JC000H"),
            ("bando-site-78", "sku:bando-site-237:bando-237-P00000JC000I"),
        ] {
            let duplicate = products.iter().find(|p| p["id"] == id).unwrap();
            assert_eq!(duplicate["active"], false);
            assert_eq!(duplicate["supersededBy"], successor);
            assert_eq!(duplicate["variants"][0]["retail"], 32000);
        }
        for p in products.iter().filter(|p| p["id"].as_str()
            .is_some_and(|id| id.starts_with("sku:bando-site-237:"))) {
            assert!(p["subtitle"].as_str().unwrap_or("").is_empty());
        }
        assert_eq!(prices, products.iter().map(|p| p["variants"].clone())
            .collect::<Vec<_>>());
        assert_eq!(after["orders"], orders);
        assert_eq!(after["clients"], clients);
        assert_eq!(apply(&mut db, &base).unwrap(), 0);
        assert_eq!(backup_manager::list_backups(&base).unwrap().len(), 1);
        drop(db);
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn curated_seed_names_are_idempotent_and_do_not_create_a_backup() {
        let salt = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let base = std::env::temp_dir().join(format!(
            "bando-new-seed-names-{}-{salt}", std::process::id()
        ));
        std::fs::create_dir_all(&base).unwrap();
        let db = initialize_database(&base.join("state.sqlite")).unwrap();
        assert_eq!(get_snapshot(&db).unwrap()["products"].as_array().unwrap().len(), 360);
        drop(db);
        assert!(backup_manager::list_backups(&base).unwrap().is_empty());
        std::fs::remove_dir_all(base).unwrap();
    }
}
