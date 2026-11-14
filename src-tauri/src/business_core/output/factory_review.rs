//! Native factory reply review badges, per-row resolution and exact
//! employee confirmation copy. Oracles: src/factory-replies.ts and
//! src/factory-conflict-review.ts. Read-only, never approves a conflict.
use serde_json::{json,Value};
use super::super::rules;

fn field<'a>(v:&'a Value,key:&str)->&'a Value {
    v.get(key).unwrap_or(&Value::Null)
}
fn s<'a>(v:&'a Value,key:&str)->&'a str {
    field(v,key).as_str().unwrap_or("")
}
fn rows<'a>(v:&'a Value,key:&str)->&'a [Value] {
    field(v,key).as_array().map(Vec::as_slice).unwrap_or(&[])
}
fn truthy(v:&Value)->bool {
    match v {
        Value::Null|Value::Bool(false)=>false,
        Value::String(s)=>!s.is_empty(),
        Value::Number(n)=>n.as_i64()!=Some(0),
        _=>true,
    }
}
fn resolved(state:&Value,record:&Value,row:&Value,needs_applied:bool)->bool {
    rows(state,"factoryReplies").iter().any(|later|
        s(field(later,"resolves"),"id")==s(record,"id") &&
        field(field(later,"resolves"),"row")==field(row,"row") &&
        (!needs_applied || rows(later,"rows").iter().any(|entry|
            truthy(field(entry,"applied")))))
}
fn requires_review(state:&Value,record:&Value)->bool {
    truthy(field(record,"error")) ||
        rows(record,"rows").iter().any(|row|
            !truthy(field(row,"applied")) && !resolved(state,record,row,true))
}
fn format_number(n:i64)->String {
    let sign=if n<0{"-"}else{""};
    let digits=n.unsigned_abs().to_string();
    let mut result=String::new();
    for (i,ch) in digits.chars().enumerate(){
        if i>0 && (digits.len()-i)%3==0{result.push(',');}
        result.push(ch);
    }
    format!("{sign}{result}")
}
fn amount(value:&Value)->String {
    match value.as_i64(){
        Some(value)=>format!("{}원",format_number(value)),
        None=>"미확인".into(),
    }
}
fn confirm(state:&Value,record:&Value,row:&Value)->Result<String,String> {
    if s(row,"shipmentId").is_empty() ||
        !s(row,"issue").contains("충돌") || truthy(field(row,"applied")) {
        return Err("승인 가능한 회신 충돌 행을 찾지 못했습니다.".into());
    }
    let ship=rows(field(state,"workflow"),"shipments").iter()
        .find(|ship|s(ship,"id")==s(row,"shipmentId"))
        .ok_or("원본 배송 건을 찾지 못했습니다.")?;
    let recipient=rows(state,"orders").iter()
        .find(|order|s(order,"id")==s(ship,"orderId"))
        .and_then(|order|rows(order,"recipients").iter()
            .find(|entry|s(entry,"id")==s(ship,"recipientId")))
        .ok_or("원본 배송 건을 찾지 못했습니다.")?;
    let old=field(ship,"actualFreight").get("FACTORY")
        .unwrap_or_else(||field(recipient,"actualFreight"));
    let tracking=match s(field(ship,"tracking"),"FACTORY"){
        ""=>"미등록",v=>v,
    };
    let row_number=field(row,"row");
    let printed_row=if let Some(n)=row_number.as_i64() {
        n.to_string()
    }else{
        row_number.to_string()
    };
    Ok(format!("{}행 / {}\n기존: {} / 운임 {}\n회신: {} / 운임 {}\n이 한 행만 정정할까요? 기존 값과 원본 파일은 보존됩니다.",
        printed_row,s(row,"name"),tracking,amount(old),
        s(row,"tracking"),amount(field(row,"actual"))))
}
pub(super) fn project(payload:&Value)->Result<Value,String>{
    let state=payload.get("state").ok_or("공장 회신 데이터가 없습니다.")?;
    let mut records=Vec::new();
    for record in rows(state,"factoryReplies"){
        let review=requires_review(state,record);
        let label=if !review{"반영 완료"}
            else if s(record,"status")=="PARTIAL"{"일부 반영"}
            else{"직원 확인 필요"};
        let mut row_data=Vec::new();
        for row in rows(record,"rows"){
            let is_resolved=resolved(state,record,row,true);
            let later=resolved(state,record,row,false);
            let candidate=!truthy(field(row,"applied")) &&
                !s(row,"shipmentId").is_empty() &&
                s(row,"issue").contains("충돌") && !later;
            let (confirmation,confirmation_error)=if candidate{
                match confirm(state,record,row){
                    Ok(text)=>(Some(text),None),
                    Err(error)=>(None,Some(error))
                }
            }else{(None,None)};
            row_data.push(json!({"row":field(row,"row"),"resolved":is_resolved,
                "hasLaterResolution":later,"confirmation":confirmation,
                "confirmationError":confirmation_error}));
        }
        records.push(json!({"id":field(record,"id"),"needsReview":review,
            "notificationLabel":label,"rows":row_data}));
    }
    Ok(json!({"records":records}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn old_factory_receipt_and_latest_review_keep_original_freight(){
        let state=json!({"factoryReplies":[{"id":"f1","status":"REVIEW","rows":[{
            "row":2,"name":"김민수","shipmentId":"s1","issue":"운송장 충돌",
            "tracking":"0012345678","actual":4000,"applied":false
        }]}],"workflow":{"shipments":[{"id":"s1","orderId":"o1",
            "recipientId":"r1","tracking":{"FACTORY":"000099998888"},
            "actualFreight":{"FACTORY":3000}}]},
            "orders":[{"id":"o1","recipients":[{"id":"r1","actualFreight":2500}]}]});
        let projected=project(&json!({"state":state})).unwrap();
        assert_eq!(projected["records"][0]["needsReview"],true);
        assert_eq!(projected["records"][0]["rows"][0]["confirmation"],
            "2행 / 김민수\n기존: 000099998888 / 운임 3,000원\n회신: 0012345678 / 운임 4,000원\n이 한 행만 정정할까요? 기존 값과 원본 파일은 보존됩니다.");
    }
}
