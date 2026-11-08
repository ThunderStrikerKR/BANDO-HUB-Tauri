//! One-time, conservative catalog name enrichment for independent sale units.
//! The mapping records the pre-update stock name and exact price-record ID.
//! Employee-renamed items, order snapshots, prices, and other records are untouched.
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
    // Do NOT replace every prefixed name: staff may have intentionally edited it.
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
    // never by prefix alone, so employee-added wording remains protected.
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
            || !same_official_text(&product["name"], &product["originalName"])
            || !same_official_text(&product["originalName"], &reference["originalName"])
            || product["siteId"] != reference["siteId"]
            || product["siteCode"] != reference["siteCode"]
            || product["catalog"] != reference["catalog"]
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
            // An employee-edited, still prefixed name must never be overwritten.
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

        assert_eq!(apply(&mut db, &base).unwrap(), 4);
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
            "반도스탠드 BD Desk JS-4 Black 검정 / 직원 직접 수정");
        assert_eq!(by_site("245")["name"], prior["products"].as_array().unwrap().iter()
            .find(|p| p["siteId"] == "245").unwrap()["originalName"]);

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
