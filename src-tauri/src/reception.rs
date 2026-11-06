//! Tauri v0.0.2 reception boundary. All checks run before beginning a snapshot write.
//! The React UI performs richer delivery and pricing checks; these Rust invariants
//! defend the permanent order record against an incomplete/stale client payload.
use serde_json::Value;
#[cfg(test)]
use serde_json::json;
use std::collections::{HashMap, HashSet};

fn list<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    value.get(key).and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}

fn identifier<'a>(value: &'a Value, label: &str) -> Result<&'a str, String> {
    value.get("id").and_then(Value::as_str).filter(|s| !s.trim().is_empty())
        .ok_or_else(|| format!("{label} ID 누락"))
}

fn is_confirmed(order: &Value) -> bool {
    order.get("confirmedAt").and_then(Value::as_str).is_some_and(|s| !s.is_empty())
}

/// A working-copy correction must match the change actually persisted.
/// The immutable customer-supplied original remains in order.raw and receipt.original.
fn validate_new_correction(old: &Value, next: &Value, correction: &Value) -> Result<(), String> {
    identifier(correction, "정정")?;
    let before = old["analysisRaw"].as_str().or_else(|| old["raw"].as_str())
        .ok_or("정정 이전 작업용 원문이 없습니다.")?;
    let after = next["analysisRaw"].as_str()
        .ok_or("정정 이후 작업용 원문이 없습니다.")?;
    if before == after
        || correction["before"].as_str() != Some(before)
        || correction["after"].as_str() != Some(after)
    {
        return Err("접수 정정의 전후 원문이 실제 변경과 일치하지 않습니다.".into());
    }
    for key in ["at", "actor", "reason"] {
        if !correction[key].as_str().is_some_and(|s| !s.trim().is_empty()) {
            return Err("접수 정정에는 시각, 담당자, 사유가 모두 필요합니다.".into());
        }
    }
    if !list(correction, "affectedRecipientIds").iter()
        .all(|id| id.as_str().is_some_and(|s| !s.trim().is_empty()))
        || list(correction, "affectedRecipientIds").is_empty()
    {
        return Err("접수 정정의 영향받은 배송 건을 확인하세요.".into());
    }
    Ok(())
}

fn valid_new_order(order: &Value, next: &Value) -> Result<(), String> {
    let id = identifier(order, "주문")?;
    if order["receptionVersion"].as_u64() != Some(1) {
        return Err("새 주문은 접수 검수 절차를 거쳐야 합니다.".into());
    }
    if !is_confirmed(order) {
        return Err("주문 확인 완료 전에는 정식 주문으로 저장할 수 없습니다.".into());
    }
    let when = order["confirmedAt"].as_str().ok_or("주문 확정 시각이 없습니다.")?;
    let snapshot = order.get("confirmationSnapshot").ok_or("최초 주문 스냅샷이 없습니다.")?;
    if snapshot["at"].as_str() != Some(when)
        || snapshot["raw"] != order["raw"]
        || snapshot["data"]["id"].as_str() != Some(id)
        || snapshot["data"]["raw"] != order["raw"]
        || snapshot["recipients"] != order["recipients"]
        || snapshot["data"]["recipients"] != order["recipients"]
        || order["receipt"]["original"] != order["raw"]
        || order["receipt"]["at"].as_str() != Some(when)
    {
        return Err("최초 원문과 확정 스냅샷이 일치하지 않습니다.".into());
    }
    if order["orderType"].as_str() != Some("RETAIL") {
        let client_id = order["clientId"].as_str().ok_or("거래처를 선택하세요.")?;
        if client_id.is_empty() || !list(next, "clients").iter().any(|c| c["id"].as_str() == Some(client_id) && c.get("deletedAt").is_none_or(Value::is_null)) {
            return Err("확정 주문의 거래처를 확인하세요.".into());
        }
        if snapshot["client"]["id"].as_str() != Some(client_id) {
            return Err("최초 확정 거래처 정보가 일치하지 않습니다.".into());
        }
    }
    let recipients = list(order, "recipients");
    if recipients.is_empty() {
        return Err("배송 건이 없는 발주는 확정할 수 없습니다.".into());
    }
    let products: HashMap<&str, &Value> = list(next, "products").iter()
        .filter_map(|p| p["id"].as_str().map(|id| (id, p))).collect();
    let mut recipient_ids = HashSet::new();
    for recipient in recipients {
        let rid = identifier(recipient, "수취인")?;
        if !recipient_ids.insert(rid) { return Err("중복된 수취인 ID가 있습니다.".into()); }
        if list(recipient, "items").is_empty() {
            return Err("상품이 없는 배송 건은 확정할 수 없습니다.".into());
        }
        for item in list(recipient, "items") {
            let quantity = item["quantity"].as_i64().unwrap_or(0);
            if quantity <= 0 { return Err("수량을 1 이상의 정수로 입력하세요.".into()); }
            let pid = item["productId"].as_str().ok_or("상품을 선택하세요.")?;
            let vid = item["variantId"].as_str().ok_or("상품 옵션을 선택하세요.")?;
            let product = products.get(pid).ok_or("등록되지 않은 상품입니다.")?;
            if product["active"] == false || product.get("deletedAt").is_some_and(|v| !v.is_null())
                || !list(product, "variants").iter().any(|v| v["id"].as_str() == Some(vid)) {
                return Err("사용 가능한 상품과 옵션을 확인하세요.".into());
            }
        }
    }
    let shipments: Vec<&Value> = list(&next["workflow"], "shipments").iter()
        .filter(|s| s["orderId"].as_str() == Some(id) && s.get("legacyArchived").and_then(Value::as_bool) != Some(true))
        .collect();
    if shipments.is_empty() || shipments.iter().any(|s| s["step"].as_i64().unwrap_or(0) < 1)
        || !recipient_ids.iter().all(|rid| shipments.iter().any(|s| s["recipientId"].as_str() == Some(rid))) {
        return Err("배송 건 전체의 주문 확인을 완료해야 합니다.".into());
    }
    let shipment_ids: HashSet<&str> = shipments.iter().filter_map(|s| s["id"].as_str()).collect();
    let has_event = list(&next["workflow"], "events").iter().any(|event| {
        event["action"].as_str() == Some("주문 확인 완료")
            && list(event, "shipmentIds").iter().filter_map(Value::as_str).any(|id| shipment_ids.contains(id))
    });
    if !has_event { return Err("주문 확인 완료 기록이 없습니다.".into()); }
    Ok(())
}

/// Rejection here aborts the entire SQLite transaction, including index and audit updates.
pub(crate) fn validate_reception(previous: &Value, next: &Value) -> Result<(), String> {
    let previous_orders: HashMap<&str, &Value> = list(previous, "orders").iter()
        .filter_map(|o| o["id"].as_str().map(|id| (id, o))).collect();
    // Detect duplicate IDs before any other per-order validation. A malformed
    // first row must not hide a duplicate ID in the same incoming snapshot.
    let mut seen = HashSet::new();
    for order in list(next, "orders") {
        let id = identifier(order, "주문")?;
        if !seen.insert(id) { return Err("주문 ID가 중복되었습니다.".into()); }
    }
    for order in list(next, "orders") {
        let id = identifier(order, "주문")?;
        if let Some(old) = previous_orders.get(id) {
            if !is_confirmed(old) && is_confirmed(order) {
                valid_new_order(order, next)?;
            }
            if is_confirmed(old) {
                if old["confirmedAt"] != order["confirmedAt"]
                    || old["raw"] != order["raw"]
                    || old["confirmationSnapshot"] != order["confirmationSnapshot"]
                    || old["receipt"] != order["receipt"] {
                    return Err("확정된 주문의 최초 원문과 확정 기록은 변경할 수 없습니다.".into());
                }
                if old["orderType"] != order["orderType"] || old["senderSnapshot"] != order["senderSnapshot"] {
                    return Err("확정된 주문의 주문 유형과 송하인은 변경할 수 없습니다.".into());
                }
            }
            let old_corrections = list(old, "rawCorrections");
            let new_corrections = list(order, "rawCorrections");
            if new_corrections.len() < old_corrections.len()
                || old_corrections.iter().zip(new_corrections).any(|(a,b)| a != b) {
                return Err("이미 등록한 접수 원문 정정 이력은 변경하거나 삭제할 수 없습니다.".into());
            }
            if !is_confirmed(order) &&
                (old["receipt"] != order["receipt"] || new_corrections.len() != old_corrections.len()) {
                return Err("확정 전 초안은 원문 감사 기록을 저장할 수 없습니다.".into());
            }
            if new_corrections.len() > old_corrections.len() {
                if !is_confirmed(old) || !is_confirmed(order) ||
                    new_corrections.len() != old_corrections.len() + 1 {
                    return Err("접수 원문 정정은 확정 주문에서 한 건씩 등록하세요.".into());
                }
                validate_new_correction(old, order, &new_corrections[old_corrections.len()])?;
            } else if is_confirmed(old) && old["analysisRaw"] != order["analysisRaw"] {
                return Err("정정 이력 없이 작업용 원문을 변경할 수 없습니다.".into());
            }
        } else {
            valid_new_order(order, next)?;
            if !list(order, "rawCorrections").is_empty() {
                return Err("최초 주문 확정과 원문 정정은 분리해서 저장하세요.".into());
            }
        }
    }
    // A confirmed order can be soft-deleted; it must not silently disappear.
    for old in list(previous, "orders") {
        if is_confirmed(old) {
            let id = identifier(old, "기존 주문")?;
            if !seen.contains(id) { return Err("확정 주문은 기록에서 제거할 수 없습니다.".into()); }
        }
    }
    Ok(())
}

pub(crate) fn new_archive_entries(previous: &Value, next: &Value) -> Result<Vec<(String,String,Value)>, String> {
    let prev: HashMap<&str, &Value> = list(previous, "orders").iter()
        .filter_map(|o| o["id"].as_str().map(|id| (id, o))).collect();
    let mut archive = Vec::new();
    let mut new_ids = HashSet::new();
    let historical_ids: HashSet<&str> = list(previous, "orders").iter()
        .flat_map(|o| list(o, "rawCorrections"))
        .filter_map(|c| c["id"].as_str()).collect();
    for order in list(next, "orders") {
        let id = identifier(order, "주문")?;
        if is_confirmed(order) && prev.get(id).is_none_or(|old| !is_confirmed(old)) {
            archive.push((format!("receipt:{id}"), id.to_owned(), order["receipt"].clone()));
        }
        let previous_len = prev.get(id).map(|o| list(o, "rawCorrections").len()).unwrap_or(0);
        // Draft analysis never produces permanent audit entries.
        if !is_confirmed(order) { continue; }
        for correction in list(order, "rawCorrections").iter().skip(previous_len) {
            let cid = identifier(correction, "정정")?;
            if historical_ids.contains(cid) || !new_ids.insert(cid) {
                return Err("접수 정정 ID가 다른 기록과 중복됩니다.".into());
            }
            archive.push((format!("correction:{cid}"), id.to_owned(), correction.clone()));
        }
    }
    Ok(archive)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn base() -> Value { json!({"orders":[],"clients":[],"products":[],"workflow":{"shipments":[],"events":[]}}) }
    #[test]
    fn rejects_unconfirmed_new_order() {
        let before=base(); let mut after=base();
        after["orders"] = json!([{"id":"order-a", "receptionVersion":1, "raw":"test"}]);
        assert!(validate_reception(&before,&after).unwrap_err().contains("주문 확인 완료"));
    }
    #[test]
    fn rejects_duplicate_order_id() {
        let before=base(); let mut after=base();
        after["orders"] = json!([{"id":"a"},{"id":"a"}]);
        assert!(validate_reception(&before,&after).unwrap_err().contains("중복"));
    }
    #[test]
    fn locked_original_is_immutable() {
        let mut before=base();
        before["orders"] = json!([{"id":"a","confirmedAt":"2026-11-06", "raw":"original", "confirmationSnapshot":{"at":"2026-11-06"},"receipt":{"original":"original"}}]);
        let mut after=before.clone(); after["orders"][0]["raw"] = json!("tampered");
        assert!(validate_reception(&before,&after).unwrap_err().contains("최초 원문"));
    }
    #[test]
    fn accepts_confirmed_order_with_valid_product_and_event() {
        let before=base(); let mut after=base();
        after["clients"] = json!([{"id":"client-1","name":"대리점"}]);
        after["products"] = json!([{"id":"product-1","active":true,"variants":[{"id":"variant-1"}]}]);
        let rows=json!([{"id":"recipient-1","items":[{"productId":"product-1","variantId":"variant-1","quantity":2}]}]);
        let receipt=json!({"original":"709B 2개", "at":"2026-11-06T08:00:00Z","actor":"test", "clientId":"client-1", "legacy":false});
        after["orders"] = json!([{
            "id":"order-1", "receptionVersion":1, "clientId":"client-1", "orderType":"AGENCY",
            "raw":"709B 2개", "confirmedAt":"2026-11-06T08:00:00Z", "recipients":rows,
            "receipt":receipt, "confirmationSnapshot":{
                "at":"2026-11-06T08:00:00Z", "raw":"709B 2개", "client":{"id":"client-1"},
                "recipients":rows, "data":{"id":"order-1", "raw":"709B 2개", "recipients":rows}
            }
        }]);
        after["workflow"] = json!({
            "shipments":[{"id":"ship-1","orderId":"order-1","recipientId":"recipient-1","step":1}],
            "events":[{"action":"주문 확인 완료","shipmentIds":["ship-1"]}]
        });
        assert!(validate_reception(&before,&after).is_ok());
        let audit=new_archive_entries(&before,&after).unwrap();
        assert_eq!(audit.len(),1);
        assert_eq!(audit[0].0,"receipt:order-1");
        assert_eq!(audit[0].2["original"],"709B 2개");
    }
    #[test]
    fn draft_to_confirmed_receipt_is_archived_once() {
        let mut before=base();
        before["orders"] = json!([{"id":"a","raw":"초안","receptionVersion":1}]);
        let mut after=before.clone();
        after["orders"][0]["confirmedAt"] = json!("2026-11-07T08:00:00Z");
        after["orders"][0]["receipt"] = json!({"original":"초안","at":"2026-11-07T08:00:00Z"});
        let entries=new_archive_entries(&before,&after).unwrap();
        assert_eq!(entries.len(),1);
        assert_eq!(entries[0].0,"receipt:a");
        assert_eq!(new_archive_entries(&after,&after).unwrap().len(),0);
    }
    #[test]
    fn draft_corrections_cannot_enter_permanent_archive() {
        let before=base(); let mut after=base();
        after["orders"] = json!([{"id":"draft","rawCorrections":[{"id":"c1","after":"임시"}]}]);
        assert!(new_archive_entries(&before,&after).unwrap().is_empty());
        let mut next=after.clone();
        next["orders"][0]["rawCorrections"].as_array_mut().unwrap()
            .push(json!({"id":"c2","after":"변경"}));
        assert!(validate_reception(&after,&next).unwrap_err().contains("초안"));
    }
    #[test]
    fn confirmed_working_raw_requires_matching_one_step_audit() {
        let mut before=base();
        before["orders"] = json!([{"id":"a","confirmedAt":"t","raw":"원본",
            "analysisRaw":"수정 전","receipt":{"original":"원본"},
            "confirmationSnapshot":{"at":"t"},"rawCorrections":[]}]);
        let mut after=before.clone();
        after["orders"][0]["analysisRaw"]=json!("수정 후");
        assert!(validate_reception(&before,&after).unwrap_err().contains("정정 이력"));
        after["orders"][0]["rawCorrections"]=json!([{"id":"correction-1","at":"2026-11-07T08:00:00Z",
            "actor":"직원","reason":"잘못 입력된 모델 정정","before":"수정 전","after":"수정 후",
            "affectedRecipientIds":["recipient"]}]);
        assert!(validate_reception(&before,&after).is_ok());
        after["orders"][0]["rawCorrections"][0]["before"]=json!("위조한 원문");
        assert!(validate_reception(&before,&after).unwrap_err().contains("전후 원문"));
    }
    #[test]
    fn duplicate_new_correction_ids_are_rejected() {
        let mut before=base();
        before["orders"]=json!([{"id":"a","confirmedAt":"t"},{"id":"b","confirmedAt":"t"}]);
        let mut after=before.clone();
        for order in after["orders"].as_array_mut().unwrap() {
            order["rawCorrections"]=json!([{"id":"same","after":"수정"}]);
        }
        assert!(new_archive_entries(&before,&after).unwrap_err().contains("중복"));
    }
    #[test]
    fn archive_new_correction_only() {
        let mut before=base();
        before["orders"] = json!([{"id":"a","confirmedAt":"t","rawCorrections":[{"id":"x"}]}]);
        let mut after=before.clone();
        after["orders"][0]["rawCorrections"] = json!([{"id":"x"},{"id":"y","after":"b"}]);
        let rows=new_archive_entries(&before,&after).unwrap();
        assert_eq!(rows.len(),1);
        assert_eq!(rows[0].0,"correction:y");
    }
}
