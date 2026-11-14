//! Final manual classification, ported from src/orders/manual-classification.ts::applyManual.
//! The grid keeps local UI draft state; this reducer exclusively owns the
//! application of rows, evidence ownership and issue resolution updates.
use serde_json::{json, Value};
use super::{field, has_value, req, required_str, rows, set, str_field};
use std::collections::HashSet;

// Exact single-cell quantity syntax from parser.ts::quantities and
// manual-classification.ts::setManualValue. A draft can contain a partial
// input, so invalid values yield null rather than an error.
fn quantity_from_input(input: &str) -> Value {
    let text = input.trim();
    if text.is_empty() { return Value::Null; }
    let integer = if !text.is_empty() && text.bytes().all(|b|b.is_ascii_digit()) {
        text.parse::<i64>().ok()
    } else {
        let korean = [("하나",1),("둘",2),("셋",3),("다섯",5),
            ("여섯",6),("일곱",7),("여덟",8),("아홉",9),
            ("한",1),("두",2),("세",3),("네",4),("넷",4),("열",10),
            ("일",1),("이",2),("삼",3),("사",4),("오",5),
            ("육",6),("칠",7),("팔",8),("구",9),("십",10)];
        let prefix = regex::Regex::new(r"(?i)^(\d+|다섯|여섯|일곱|여덟|아홉|하나|둘|셋|넷|한|두|세|네|열|일|이|삼|사|오|육|칠|팔|구|십)\s*(개|대|세트|ea|pcs)$").unwrap();
        let multiplier = regex::Regex::new(r"^[x×*]\s*(\d+)$").unwrap();
        if let Some(caps) = prefix.captures(text) {
            let word = caps.get(1).unwrap().as_str();
            word.parse::<i64>().ok().or_else(||korean.iter()
                .find(|(spelling,_)|*spelling==word).map(|(_,count)|*count))
        } else if let Some(caps) = multiplier.captures(text) {
            caps.get(1).and_then(|m|m.as_str().parse::<i64>().ok())
        } else { None }
    };
    integer.filter(|n|(1..=super::MAX_SAFE).contains(n))
        .map_or(Value::Null, |n|json!(n))
}
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
    if action == "set_manual_recipient_field" {
        let mut model = req(payload,"model")?.clone();
        let cell = req(payload,"cell")?;
        let field_name = required_str(cell,"field")?;
        if !["name","phone","mobile","note"].contains(&field_name) {
            return Err("입력 필드를 확인하세요.".into());
        }
        let rid = required_str(cell,"recipientId")?;
        let value = required_str(payload,"value")?;
        let row = model["rows"].as_array_mut().ok_or("배송 행을 선택하세요.")?
            .iter_mut().find(|r|str_field(r,"id")==rid)
            .ok_or("배송 행을 선택하세요.")?;
        set(row,field_name,json!(value))?;
        if !field(row,"confirmedFields").is_array() {
            set(row,"confirmedFields",json!([]))?;
        }
        let confirmed = row["confirmedFields"].as_array_mut()
            .ok_or("수취인 확인 목록 오류")?;
        if !confirmed.iter().any(|v|v.as_str()==Some(field_name)) {
            confirmed.push(json!(field_name));
        }
        return Ok(json!({"model":model}));
    }
    if action == "parse_manual_quantity" {
        let input = required_str(payload, "value")?;
        let quantity = quantity_from_input(input);
        return Ok(json!({"quantityConfirmed":!quantity.is_null(),
            "quantity":quantity}));
    }
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
    fn edits_recipient_only_without_changing_other_cells() {
        let p=json!({"action":"set_manual_recipient_field",
            "model":{"rows":[{"id":"r","name":"","items":[{"id":"i","quantity":3}]}],
                "blocks":[],"assignments":{}},
            "cell":{"recipientId":"r","field":"name"},
            "value":"가상 고객"});
        let result=apply(&p).unwrap();
        assert_eq!(result["model"]["rows"][0]["name"],"가상 고객");
        assert_eq!(result["model"]["rows"][0]["confirmedFields"],json!(["name"]));
        assert_eq!(result["model"]["rows"][0]["items"][0]["quantity"],3);
    }
    #[test]
    fn parses_original_manual_quantity_tokens() {
        for (input, expected) in [("3",json!(3)),(" 2 개 ",json!(2)),
            ("세트",Value::Null),("한개",json!(1)),("세 세트",json!(3)),
            ("× 7",json!(7)),("x 5",json!(5)),("10cm",Value::Null),
            ("수량 2개",Value::Null),("0",Value::Null),("1.5",Value::Null),
            ("",Value::Null)] {
            assert_eq!(quantity_from_input(input),expected,"{input}");
        }
    }
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
