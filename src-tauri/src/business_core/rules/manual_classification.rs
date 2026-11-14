//! Final manual classification, ported from src/orders/manual-classification.ts::applyManual.
//! The grid keeps local UI draft state; this reducer exclusively owns the
//! application of rows, evidence ownership and issue resolution updates.
use serde_json::{json, Value};
use super::{field, has_value, req, required_str, rows, set, str_field};
use std::collections::HashSet;

fn valid_quantity(v: &Value) -> bool {
    v.as_i64().is_some_and(|q| (1..=super::MAX_SAFE).contains(&q))
}
fn pending_quantity(model: &Value) -> bool {
    rows(field(model, "rows")).iter().any(|r|
        rows(field(r, "items")).iter().any(|i|
            (!str_field(i, "productId").is_empty() ||
                !str_field(i, "name").trim().is_empty()) &&
            (!valid_quantity(field(i, "quantity")) ||
                field(i, "quantityConfirmed").as_bool() == Some(false))
        )
    )
}
pub(super) fn apply(payload: &Value) -> Result<Value, String> {
    let action = required_str(payload, "action")?;
    if action != "apply_manual" {
        return Err(format!("지원하지 않는 수동 분류 명령: {action}"));
    }
    let order = req(payload, "order")?;
    let model = req(payload, "model")?;
    if has_value(field(order, "confirmedAt")) {
        return Err("정식 주문은 수동 분류로 변경할 수 없습니다.".into());
    }
    if pending_quantity(model) {
        return Err("선택한 상품의 수량을 먼저 확정하세요.".into());
    }
    if rows(field(model, "rows")).is_empty() {
        return Err("배송 건수를 설정하세요.".into());
    }
    let mut next = order.clone();
    set(&mut next, "recipients", req(model, "rows")?.clone())?;
    set(&mut next, "manualClassification", json!({
        "blocks": req(model, "blocks")?,
        "assignments": req(model, "assignments")?,
    }))?;
    let raw = if !field(order, "analysisRaw").is_null() {
        field(order, "analysisRaw")
    } else { field(order, "raw") };
    if let Some(v) = raw.as_str() {
        set(&mut next, "analysisRaw", json!(v))?;
    } else if !raw.is_null() {
        set(&mut next, "analysisRaw", raw.clone())?;
    }
    if let Some(v) = order.get("clientId") {
        set(&mut next, "analysisClientId", v.clone())?;
    }
    set(&mut next, "pricesLocked", json!(false))?;
    let has_order_type = !field(order, "orderType").is_null() &&
        !matches!(field(order, "orderType").as_str(), Some(""));
    for row in next["recipients"].as_array_mut().ok_or("배송 목록 오류")? {
        if has_order_type {
            if field(row, "dispatchOrigin").is_null() {
                set(row, "dispatchOrigin", json!("FACTORY"))?;
            }
            let origin = field(row, "dispatchOrigin").clone();
            for item in row["items"].as_array_mut().ok_or("상품 목록 오류")? {
                set(item, "origin", origin.clone())?;
            }
        }
        row.as_object_mut().ok_or("수취인 데이터 오류")?.remove("unassignedEvidence");
        set(row, "sources", json!([]))?;
        for item in row["items"].as_array_mut().ok_or("상품 목록 오류")? {
            set(item, "sources", json!([]))?;
        }
    }
    let blocks = rows(field(model, "blocks"));
    let assignments = field(model, "assignments").as_object()
        .ok_or("원문 연결 정보 오류")?;
    for (block_id, assignment) in assignments {
        let Some(block) = blocks.iter().find(|b| str_field(b, "id") == block_id) else {continue};
        let rid = str_field(assignment, "recipientId");
        let Some(row) = next["recipients"].as_array_mut().ok_or("배송 목록 오류")?
            .iter_mut().find(|r|str_field(r, "id") == rid) else {continue};
        let mut span = block.clone();
        let item_id = str_field(assignment, "itemId");
        set(&mut span, "recipientId", json!(rid))?;
        set(&mut span, "targetId", json!(if item_id.is_empty() {rid}else{item_id}))?;
        set(&mut span, "field",field(assignment,"field").clone())?;
        if item_id.is_empty() {
            row["sources"].as_array_mut().ok_or("수취인 원문 연결 오류")?.push(span);
        } else if let Some(item) = row["items"].as_array_mut().ok_or("상품 목록 오류")?
            .iter_mut().find(|i| str_field(i, "id") == item_id) {
            item["sources"].as_array_mut().ok_or("상품 원문 연결 오류")?.push(span);
        }
    }

    let issues = super::issues::order_issues(&next);
    let old = field(&next,"issueResolutions").as_object().cloned().unwrap_or_default();
    let mut decisions = old.clone();
    let present = issues.iter().map(|i|str_field(i,"issueId").to_string())
        .collect::<HashSet<_>>();
    let updated = field(&next,"updatedAt").clone();
    for issue in &issues {
        let id = str_field(issue, "issueId");
        let old_entry = old.get(id);
        let evidence = issue.get("evidence").filter(|v|!v.is_null())
            .unwrap_or_else(||field(issue,"title"));
        let current_resolution = field(issue,"resolution");
        let date = if old_entry.is_some_and(|p|
            field(p,"resolution")==current_resolution &&
            field(p,"evidence")==evidence
        ) { field(old_entry.unwrap(),"updatedAt").clone() } else {updated.clone()};
        decisions.insert(id.into(),json!({
            "resolution":current_resolution,
            "resolutionSource":field(issue,"resolutionSource"),
            "updatedAt":date,"evidence":evidence
        }));
    }
    for (id,previous) in &old {
        if !present.contains(id) &&
            ["PENDING_CUSTOMER","UNRESOLVED","PROVISIONALLY_APPROVED","AUTO_APPLIED"]
                .contains(&str_field(previous,"resolution")) {
            let mut resolved = previous.clone();
            set(&mut resolved,"resolution",json!("RESOLVED"))?;
            set(&mut resolved,"resolutionSource",
                json!("직원 수정 또는 현재 원문 반영"))?;
            set(&mut resolved,"updatedAt",updated.clone())?;
            decisions.insert(id.clone(),resolved);
        }
    }
    set(&mut next,"issueResolutions",Value::Object(decisions))?;
    Ok(json!({"order":next}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_confirmed_and_missing_quantities() {
        let mut p=json!({"action":"apply_manual","order":{"id":"o","raw":"원문"},
            "model":{"rows":[{"id":"r","items":[{"id":"i","name":"BD 709",
                "quantity":null,"quantityConfirmed":false}]}],
                "blocks":[],"assignments":{}}});
        assert!(apply(&p).unwrap_err().contains("수량"));
        p["model"]["rows"][0]["items"][0]["quantity"]=json!(2);
        p["model"]["rows"][0]["items"][0]["quantityConfirmed"]=json!(true);
        p["order"]["confirmedAt"]=json!("2026-11-15T00:00:00Z");
        assert!(apply(&p).unwrap_err().contains("정식 주문"));
    }
    #[test]
    fn retains_original_and_rebuilds_cited_sources() {
        let p=json!({"action":"apply_manual",
            "order":{"id":"o","raw":"가상", "clientId":"c", "orderType":"AGENCY",
                "updatedAt":"2026-11-15T00:00:00Z","issueResolutions":{}},
            "model":{"rows":[{"id":"r","name":"테스트","address":"",
                "phone":"","mobile":"","items":[{"id":"i","name":"BD 709",
                    "quantity":2,"quantityConfirmed":true,"issues":[],
                    "sources":[{"old":"owner"}]}]}],
                "blocks":[{"id":"0:3","start":0,"end":3,"text":"가상7","field":"product"}],
                "assignments":{"0:3":{"recipientId":"r","itemId":"i","field":"product","value":"BD 709"}}}});
        let result=apply(&p).unwrap();
        assert_eq!(result["order"]["raw"],"가상");
        assert_eq!(result["order"]["recipients"][0]["items"][0]["origin"],"FACTORY");
        assert_eq!(result["order"]["recipients"][0]["items"][0]["sources"][0]["targetId"],"i");
        assert_eq!(result["order"]["manualClassification"]["assignments"],
            p["model"]["assignments"]);
    }
}
