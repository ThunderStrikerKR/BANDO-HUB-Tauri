//! One-time, conservative catalog name enrichment for independent sale units.
//! The mapping records the pre-update stock name and exact price-record ID.
//! Employee-renamed items, order snapshots, prices, and other records are untouched.
use super::*;
use serde_json::Value;

pub(super) fn apply(conn: &mut Connection, base: &Path) -> Result<usize, String> {
    let mapping: Value = serde_json::from_str(include_str!(
        "../resources/product-name-enrichment-20261109.json"
    )).map_err(err)?;
    let updates = mapping["changes"].as_array()
        .ok_or("상품명 변경 목록이 누락됐습니다.")?;
    let mut state = get_snapshot(conn)?;
    let revision = state["revision"].as_u64()
        .ok_or("상품명 갱신 전 데이터 리비전을 확인할 수 없습니다.")?;
    let products = state["products"].as_array_mut()
        .ok_or("상품명 갱신 전 상품 목록을 확인할 수 없습니다.")?;
    let mut changed = 0_usize;
    for update in updates {
        let Some(product) = products.iter_mut().find(|p| p["id"] == update["id"]) else {
            continue; // Another installation may have removed this product.
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
    if changed == 0 { return Ok(0); }
    // Create and verify a full SQLite backup BEFORE touching any business rows.
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
