//! Native final manual classification reducer, port of
//! src/orders/manual-classification.ts::applyManual and
//! src/validation.ts::synchronizeIssueDecisions.
//! The editable grid is a React draft; Rust owns its approved final state.
use serde_json::{json, Value, Map};
use super::{field, flag, has_value, req, rows, set, str_field};
use super::issues;

fn valid_quantity(item:&Value)->bool{
    let number=field(item,"quantity").as_i64();
    number.is_some_and(|n|n>0 && n<=9_007_199_254_740_991)
        && item.get("quantityConfirmed")!=Some(&Value::Bool(false))
}
fn synchronize(order:&mut Value)->Result<(),String>{
    let previous=field(order,"issueResolutions").as_object()
        .cloned().unwrap_or_default();
    let mut next=previous.clone();
    let current=issues::order_issues(order);
    let now=order.get("updatedAt").cloned();
    let mut present=std::collections::HashSet::new();
    for issue in current {
        let id=str_field(&issue,"issueId").to_owned();
        if id.is_empty(){continue}
        present.insert(id.clone());
        let evidence=issue.get("evidence").filter(|value|!value.is_null())
            .cloned().unwrap_or_else(||field(&issue,"title").clone());
        let old=previous.get(&id);
        let unchanged=old.is_some_and(|old|
            old.get("resolution")==issue.get("resolution")&&
            old.get("evidence")==Some(&evidence));
        let mut decision=Map::new();
        for key in ["resolution","resolutionSource"] {
            if let Some(value)=issue.get(key) {
                decision.insert(key.to_owned(),value.clone());
            }
        }
        decision.insert("evidence".into(),evidence);
        let updated_at=if unchanged {
            old.and_then(|value|value.get("updatedAt")).cloned()
        }else{
            now.clone()
        };
        if let Some(value)=updated_at {
            decision.insert("updatedAt".into(),value);
        }
        next.insert(id,Value::Object(decision));
    }
    for (id,old) in &previous {
        if !present.contains(id) && [
            "PENDING_CUSTOMER","UNRESOLVED","PROVISIONALLY_APPROVED","AUTO_APPLIED",
        ].contains(&str_field(old,"resolution")) {
            let mut updated=old.clone();
            set(&mut updated,"resolution",json!("RESOLVED"))?;
            set(&mut updated,"resolutionSource",json!("직원 수정 또는 현재 원문 반영"))?;
            if let Some(ref now)=now {set(&mut updated,"updatedAt",now.clone())?;}
            next.insert(id.clone(),updated);
        }
    }
    set(order,"issueResolutions",Value::Object(next))
}
pub(super) fn apply(payload:&Value)->Result<Value,String>{
    let order=req(payload,"order")?;
    let model=req(payload,"model")?;
    if has_value(field(order,"confirmedAt")){
        return Err("정식 주문은 수동 분류로 변경할 수 없습니다.".into());
    }
    let model_rows=req(model,"rows")?.as_array().ok_or("배송 행이 없습니다.")?;
    if model_rows.is_empty(){return Err("배송 건수를 설정하세요.".into());}
    for row in model_rows {
        for item in rows(field(row,"items")){
            if (!str_field(item,"productId").is_empty() || !str_field(item,"name").trim().is_empty())
                && !valid_quantity(item) {
                return Err("선택한 상품의 수량을 먼저 확정하세요.".into());
            }
        }
    }
    let mut next=order.clone();
    set(&mut next,"recipients",json!(model_rows))?;
    set(&mut next,"manualClassification",json!({
        "blocks":field(model,"blocks"),"assignments":field(model,"assignments")
    }))?;
    let original=order.get("analysisRaw").filter(|value|!value.is_null())
        .unwrap_or_else(||field(order,"raw"));
    set(&mut next,"analysisRaw",original.clone())?;
    set(&mut next,"analysisClientId",field(order,"clientId").clone())?;
    set(&mut next,"pricesLocked",json!(false))?;
    let order_has_type=order.get("orderType").is_some_and(|v|v.as_str().is_some_and(|s|!s.is_empty()));
    let recipients=next.get_mut("recipients").and_then(Value::as_array_mut)
        .ok_or("배송 행이 없습니다.")?;
    for recipient in recipients.iter_mut(){
        if order_has_type {
            if recipient.get("dispatchOrigin").is_none_or(Value::is_null){
                set(recipient,"dispatchOrigin",json!("FACTORY"))?;
            }
            let origin=field(recipient,"dispatchOrigin").clone();
            if let Some(items)=recipient.get_mut("items").and_then(Value::as_array_mut){
                for item in items {
                    set(item,"origin",origin.clone())?;
                }
            }
        }
        recipient.as_object_mut().ok_or("배송 행 정보 오류")?
            .remove("unassignedEvidence");
        set(recipient,"sources",json!([]))?;
        if let Some(items)=recipient.get_mut("items").and_then(Value::as_array_mut){
            for item in items {
                set(item,"sources",json!([]))?;
            }
        }
    }
    let blocks=rows(field(model,"blocks"));
    let assignments=field(model,"assignments");
    let assign_order=rows(field(payload,"assignmentOrder"));
    let mut ids=assign_order.iter().filter_map(Value::as_str)
        .map(str::to_owned).collect::<Vec<_>>();
    // No silent reordering: the frontend passes Object.keys(assignments).
    // A missing explicit order is invalid when assignment links exist.
    if assignments.as_object().is_some_and(|map|map.len()!=ids.len()) {
        return Err("수동 분류 원문 연결 순서가 일치하지 않습니다.".into());
    }
    let mut seen=std::collections::HashSet::new();
    for id in ids.drain(..) {
        if !seen.insert(id.clone()) {
            return Err("중복된 수동 원문 연결입니다.".into());
        }
        let Some(assignment)=assignments.get(&id) else {
            return Err("존재하지 않는 수동 원문 연결입니다.".into());
        };
        let Some(block)=blocks.iter().find(|b|str_field(b,"id")==id) else {continue};
        let Some(recipient)=recipients.iter_mut().find(|r|
            str_field(r,"id")==str_field(assignment,"recipientId")) else {continue};
        let mut span=block.clone();
        set(&mut span,"recipientId",field(recipient,"id").clone())?;
        let item_id=str_field(assignment,"itemId");
        set(&mut span,"targetId",if item_id.is_empty(){
            field(recipient,"id").clone()
        }else{json!(item_id)})?;
        set(&mut span,"field",field(assignment,"field").clone())?;
        if !item_id.is_empty(){
            if let Some(item)=recipient.get_mut("items").and_then(Value::as_array_mut)
                .and_then(|items|items.iter_mut().find(|item|str_field(item,"id")==item_id)){
                item.get_mut("sources").and_then(Value::as_array_mut)
                    .ok_or("상품 출처 정보 오류")?.push(span);
            }
        }else{
            recipient.get_mut("sources").and_then(Value::as_array_mut)
                .ok_or("수취인 출처 정보 오류")?.push(span);
        }
    }
    synchronize(&mut next)?;
    Ok(json!({"order":next}))
}
