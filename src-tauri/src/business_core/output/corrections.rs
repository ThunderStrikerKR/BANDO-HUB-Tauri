//! Read-only factory correction status and copy text.
//! Source oracle: src/corrections.ts (correctionStatus / correctionMessage).
//! No state writes, auto-approval or freight recomputation occur here.
use serde_json::{json,Value};
use regex::Regex;

fn s<'a>(v:&'a Value,key:&str)->&'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}
fn list<'a>(v:&'a Value,key:&str)->&'a [Value] {
    v.get(key).and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}
fn printable(v:Option<&Value>)->String {
    match v {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Null)|None => "undefined".into(),
        Some(v) => v.to_string(),
    }
}
fn js_field(v:&Value,key:&str)->String { printable(v.get(key)) }
fn internal_model(name:&str)->String {
    let stripped=Regex::new(r"^\[가상\]\s*").unwrap().replace(name,"").to_string();
    let bytes=stripped.as_bytes();
    if bytes.len()>2 && bytes[0].eq_ignore_ascii_case(&b'B')
        && bytes[1].eq_ignore_ascii_case(&b'D')
        && stripped[2..].chars().next().is_some_and(|c| c.is_whitespace() || c.is_ascii_digit()) {
        stripped[2..].trim_start_matches(char::is_whitespace).into()
    } else {
        stripped
    }
}
fn item_line(recipient:&Value)->String {
    list(recipient,"items").iter().map(|item| format!(
        "{} ({}) × {}",
        internal_model(s(item,"name")),
        js_field(item,"color"),
        js_field(item,"quantity"),
    )).collect::<Vec<_>>().join(" / ")
}
fn optional_fee(value:Option<&Value>)->Option<&Value> {
    value.filter(|v|!v.is_null())
}
fn fee_text(value:Option<&Value>)->String {
    optional_fee(value).map(|v|printable(Some(v)))
        .unwrap_or_else(||"미확정".into())
}
fn status(state:&Value,id:&str)->String {
    list(&state["workflow"],"events").iter().rev()
        .find(|event|s(event,"action")=="정정 요청 상태" && s(event,"before")==id)
        .map(|event|js_field(event,"after"))
        .unwrap_or_else(||"REGISTERED".into())
}
fn message(state:&Value,request:&Value)->Result<String,String> {
    let before=request.get("beforeRecipient").filter(|v|!v.is_null());
    let after=request.get("afterRecipient").filter(|v|!v.is_null());
    let (Some(before),Some(after))=(before,after) else {
        return Err("구조화된 정정 요청을 선택하세요.".into());
    };
    let mut lines=vec![
        "기존 출고 건 정정 요청입니다.".to_string(),
        format!("배송 ID: {}",js_field(request,"shipmentId")),
        "새 출고 주문이 아닙니다.".to_string(),
    ];
    for (field,label) in [
        ("name","수취인"),("address","주소"),("mobile","휴대폰"),
        ("phone","전화"),("note","요청사항"),
    ] {
        if before.get(field)!=after.get(field) {
            lines.push(format!("{}: {} → {}",label,js_field(before,field),js_field(after,field)));
        }
    }
    if before.get("items")!=after.get("items") {
        lines.push(format!("품목: {} → {}",item_line(before),item_line(after)));
    }
    let shipment=list(&state["workflow"],"shipments").iter()
        .find(|ship|s(ship,"id")==s(request,"shipmentId"));
    for (origin,label) in [("FACTORY","공장"),("STORE","매장")] {
        let old=optional_fee(before.get("shippingCharges").and_then(|v|v.get(origin)))
            .or_else(||shipment.and_then(|ship|ship.get("charges").and_then(|v|v.get(origin))));
        let new=optional_fee(after.get("shippingCharges").and_then(|v|v.get(origin)))
            .or(old);
        if old!=new {
            lines.push(format!("{} 운임: {} → {}원",label,fee_text(old),fee_text(new)));
        }
    }
    if before.get("freightCode")!=after.get("freightCode") {
        let before_code=before.get("freightCode").and_then(Value::as_str).unwrap_or("010");
        let after_code=after.get("freightCode").and_then(Value::as_str).unwrap_or("010");
        lines.push(format!("운임 방식: {} → {}",before_code,after_code));
    }
    Ok(lines.join("\n"))
}
pub(super) fn summaries(payload:&Value)->Result<Value,String> {
    let state=payload.get("state").ok_or("정정 조회 상태가 없습니다.")?;
    let shipment_id=payload.get("shipmentId").and_then(Value::as_str)
        .ok_or("배송 ID가 없습니다.")?;
    let records=list(&state["workflow"],"changeRequests").iter()
        .filter(|request|s(request,"shipmentId")==shipment_id)
        .map(|request|{
            let id=s(request,"id");
            let text=if request.get("afterRecipient").is_some_and(|v|!v.is_null()){
                Some(message(state,request)?)
            }else{None};
            Ok(json!({"id":id,"status":status(state,id),"text":text}))
        }).collect::<Result<Vec<Value>,String>>()?;
    Ok(json!({"records":records}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn keeps_original_correction_text_and_event_status() {
        let state=json!({"workflow":{
          "shipments":[{"id":"s1","charges":{"FACTORY":3000}}],
          "events":[{"action":"정정 요청 상태","before":"r1","after":"PENDING_FACTORY"}],
          "changeRequests":[{"id":"r1","shipmentId":"s1",
            "beforeRecipient":{"name":"김민수","address":"서울","mobile":"","phone":"02","note":"",
              "freightCode":"010","items":[{"name":"BD 709","color":"Black","quantity":1}]},
            "afterRecipient":{"name":"김민수","address":"경기","mobile":"","phone":"02","note":"",
              "freightCode":"020","shippingCharges":{"FACTORY":4000},
              "items":[{"name":"BD 709","color":"Black","quantity":1}]}
          }]
        }});
        let r=summaries(&json!({"state":state,"shipmentId":"s1"})).unwrap();
        assert_eq!(r["records"][0]["status"],"PENDING_FACTORY");
        assert_eq!(r["records"][0]["text"],"기존 출고 건 정정 요청입니다.\n배송 ID: s1\n새 출고 주문이 아닙니다.\n주소: 서울 → 경기\n공장 운임: 3000 → 4000원\n운임 방식: 010 → 020");
    }
}
