//! Final manual classification, ported from src/orders/manual-classification.ts::applyManual.
//! The grid keeps local UI draft state; this reducer exclusively owns the
//! application of rows, evidence ownership and issue resolution updates.
use serde_json::{json, Value, Map};
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
// Port of parser.ts::addressParts, used by the manual recipient address cell.
// Keys with no evidence must be absent (not null), matching JS undefined.
fn manual_address_parts(value: &str) -> Value {
    let provinces = ["서울특별시","서울","부산광역시","부산","대구광역시","대구",
        "인천광역시","인천","광주광역시","광주","대전광역시","대전",
        "울산광역시","울산","세종특별자치시","세종","경기도","경기",
        "강원특별자치도","강원도","강원","충청북도","충청남도",
        "전북특별자치도","전라북도","전라남도","경상북도","경상남도",
        "제주특별자치도","제주도","제주","충북","충남","전북",
        "전남","경북","경남"];
    let province=provinces.iter().find(|p|value.starts_with(**p) &&
        (value.len()==p.len() || value[p.len()..].chars().next().is_some_and(char::is_whitespace)));
    let rest=province.map_or(value,|p|value[p.len()..].trim());
    let mut result=serde_json::Map::new();
    if let Some(p)=province{result.insert("province".into(),json!(p));}
    fn bounded_capture(re:&str,value:&str)->Option<String> {
        let pattern=regex::Regex::new(re).ok()?;
        let capture = pattern.captures_iter(value).find(|caps|
            caps.get(1).is_some_and(|m|value[m.end()..].chars().next()
                .is_none_or(char::is_whitespace))
        ).and_then(|caps|caps.get(1).map(|m|m.as_str().to_owned()));
        capture
    }
    for (key,pattern) in [
        ("city",r"(?:^|\s)([가-힣]+(?:시|군))"),
        ("district",r"(?:^|\s)([가-힣]+구)"),
        ("town",r"(?:^|\s)([가-힣0-9]+(?:읍|면|동|리))")
    ]{
        if let Some(v)=bounded_capture(pattern,rest){result.insert(key.into(),json!(v));}
    }
    let road_re=regex::Regex::new(
        r"([가-힣A-Za-z0-9·.]+(?:대로|로|길))\s+(\d+(?:-\d+)?)"
    ).unwrap();
    let road=road_re.captures_iter(rest).find(|caps|{
        let end=caps.get(2).unwrap().end();
        !rest[end..].chars().next().is_some_and(|c|c.is_ascii_digit()||c=='개'||c=='대')
    });
    let town=result.get("town").and_then(Value::as_str);
    let lot=town.and_then(|town|{
        regex::Regex::new(&format!(
            r"{}\s+(?:산\s*)?(\d+(?:-\d+)?)",regex::escape(town)
        )).ok()?.captures(rest)
    });
    let matched=road.as_ref().and_then(|c|c.get(0))
        .or_else(||lot.as_ref().and_then(|c|c.get(0)));
    if let Some(road)=road.as_ref(){
        if let Some(r)=road.get(1){result.insert("road".into(),json!(r.as_str()));}
    }
    let building=road.as_ref().and_then(|c|c.get(2))
        .or_else(||lot.as_ref().and_then(|c|c.get(1)));
    if let Some(b)=building{result.insert("building".into(),json!(b.as_str()));}
    if let Some(m)=matched {
        let detail=rest[m.end()..].trim();
        if !detail.is_empty(){result.insert("detail".into(),json!(detail));}
    }
    Value::Object(result)
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
fn valid_quantity_item(item:&Value)->bool{
    let number=field(item,"quantity").as_i64();
    number.is_some_and(|n|n>0 && n<=9_007_199_254_740_991)
        && item.get("quantityConfirmed")!=Some(&Value::Bool(false))
}
fn synchronize(order:&mut Value)->Result<(),String>{
    let previous=field(order,"issueResolutions").as_object()
        .cloned().unwrap_or_default();
    let mut next=previous.clone();
    let current=super::issues::order_issues(order);
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
fn apply_final(payload:&Value)->Result<Value,String>{
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
                && !valid_quantity_item(item) {
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

pub(super) fn apply(payload: &Value) -> Result<Value, String> {
    let action = required_str(payload, "action")?;
    if action == "set_manual_recipient_field" {
        let mut model = req(payload,"model")?.clone();
        let cell = req(payload,"cell")?;
        let field_name = required_str(cell,"field")?;
        if !["name","address","phone","mobile","note"].contains(&field_name) {
            return Err("입력 필드를 확인하세요.".into());
        }
        let rid = required_str(cell,"recipientId")?;
        let value = required_str(payload,"value")?;
        let row = model["rows"].as_array_mut().ok_or("배송 행을 선택하세요.")?
            .iter_mut().find(|r|str_field(r,"id")==rid)
            .ok_or("배송 행을 선택하세요.")?;
        set(row,field_name,json!(value))?;
        if field_name=="address" {
            set(row,"addressParts",manual_address_parts(value))?;
            row.as_object_mut().ok_or("수취인 데이터 오류")?.remove("addressStatus");
        }
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
    apply_final(payload)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn address_fields_follow_original_parts_shape() {
        assert_eq!(manual_address_parts(""),json!({}));
        assert_eq!(manual_address_parts("서울특별시 강남구 테헤란로 10 101호"),
            json!({"province":"서울특별시","district":"강남구","road":"테헤란로",
                "building":"10","detail":"101호"}));
        assert_eq!(manual_address_parts("경기도 수원시 팔달구 인계동 123"),
            json!({"province":"경기도","city":"수원시","district":"팔달구",
                "town":"인계동","building":"123"}));
    }
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
                "assignments":{"0:3":{"recipientId":"r","itemId":"i","field":"product","value":"BD 709"}}},
            "assignmentOrder":["0:3"]});
        let result=apply(&p).unwrap();
        assert_eq!(result["order"]["raw"],"가상");
        assert_eq!(result["order"]["recipients"][0]["items"][0]["origin"],"FACTORY");
        assert_eq!(result["order"]["recipients"][0]["items"][0]["sources"][0]["targetId"],"i");
        assert_eq!(result["order"]["manualClassification"]["assignments"],
            p["model"]["assignments"]);
    }
}
