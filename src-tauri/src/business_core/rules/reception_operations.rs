//! src/orders/reception.ts newReception / replaceReception / persistedReceptionState.
//! Does not save drafts; persists only the filtered clone returned here.
use serde_json::{json,Value};
use std::collections::HashSet;
use super::{field,has_value,req,required_str,rows,set,str_field};

fn new_reception(payload:&Value)->Result<Value,String> {
    let now=required_str(payload,"now")?;
    let id=required_str(payload,"id")?;
    let client_id=str_field(payload,"clientId");
    let order_type=payload.get("orderType").and_then(Value::as_str).unwrap_or("AGENCY");
    Ok(json!({"id":id,"clientId":client_id,"raw":"","channel":"카카오톡",
        "recipients":[],"shippingFee":null,"applyVat":false,
        "vatAmount":null,"status":"RECEIVED","notified":false,
        "paid":false,"postpaidApproved":false,"freightCode":"010",
        "createdAt":now,"updatedAt":now,"orderType":order_type,
        "receptionVersion":1}))
}
fn replace_reception(payload:&Value)->Result<Value,String>{
    let original=req(payload,"order")?;
    if has_value(field(original,"confirmedAt")){
        return Err("확정된 발주 원문은 변경할 수 없습니다.".into());
    }
    let raw=required_str(payload,"raw")?;
    // JS .length counts UTF-16 code units, not Unicode scalar values.
    if raw.encode_utf16().count()>100_000 {
        return Err("발주 원문은 100,000자 이내로 붙여넣어 주세요.".into());
    }
    let client_id=if raw.trim().is_empty(){""}else{str_field(original,"clientId")};
    let mut seed=json!({"id":str_field(original,"id"),
        "now":required_str(payload,"now")?,
        "clientId":client_id,
        "orderType":str_field(original,"orderType")});
    if seed["orderType"].is_null(){set(&mut seed,"orderType",json!("AGENCY"))?;}
    let mut next=new_reception(&seed)?;
    set(&mut next,"id",field(original,"id").clone())?;
    set(&mut next,"raw",json!(raw))?;
    set(&mut next,"createdAt",field(original,"createdAt").clone())?;
    if !raw.trim().is_empty() {
        if let Some(snapshot)=original.get("clientSnapshot"){
            set(&mut next,"clientSnapshot",snapshot.clone())?;
        }
    }
    Ok(next)
}
pub(super) fn apply(payload:&Value)->Result<Value,String>{
    let action=required_str(payload,"action")?;
    match action {
        "new_reception"=>Ok(json!({"order":new_reception(payload)?})),
        "replace_reception"=>Ok(json!({"order":replace_reception(payload)?})),
        "persisted_reception_state"=>{
            let before=req(payload,"before")?;
            let mut proposed=req(payload,"state")?.clone();
            let known=rows(field(before,"orders")).iter()
                .map(|o|str_field(o,"id").to_string()).collect::<HashSet<_>>();
            let drafts=rows(field(&proposed,"orders")).iter()
                .filter(|o|field(o,"receptionVersion").as_i64()==Some(1)
                    &&!has_value(field(o,"confirmedAt"))
                    &&!known.contains(str_field(o,"id")))
                .map(|o|str_field(o,"id").to_string())
                .collect::<HashSet<_>>();
            if drafts.is_empty(){return Ok(json!({"state":proposed}));}
            proposed["orders"].as_array_mut().ok_or("주문 목록 누락")?
                .retain(|o|!drafts.contains(str_field(o,"id")));
            proposed["queue"].as_array_mut().ok_or("기존 대기 목록 누락")?
                .retain(|id|!id.as_str().is_some_and(|v|drafts.contains(v)));
            if proposed.get("workflow").is_some_and(|w|!w.is_null()){
                let workflow=&proposed["workflow"];
                let sources=rows(field(workflow,"sources")).iter()
                    .filter(|s|drafts.contains(str_field(s,"orderId")))
                    .map(|s|str_field(s,"id").to_string()).collect::<HashSet<_>>();
                let ships=rows(field(workflow,"shipments")).iter()
                    .filter(|s|drafts.contains(str_field(s,"orderId")))
                    .map(|s|str_field(s,"id").to_string()).collect::<HashSet<_>>();
                let groups=rows(field(workflow,"groups")).iter()
                    .filter(|g|sources.contains(str_field(g,"sourceId")))
                    .map(|g|str_field(g,"id").to_string()).collect::<HashSet<_>>();
                proposed["workflow"]["sources"].as_array_mut()
                    .ok_or("업무 원본 목록 누락")?
                    .retain(|s|!sources.contains(str_field(s,"id")));
                proposed["workflow"]["shipments"].as_array_mut()
                    .ok_or("배송건 목록 누락")?
                    .retain(|s|!ships.contains(str_field(s,"id")));
                proposed["workflow"]["groups"].as_array_mut()
                    .ok_or("묶음 목록 누락")?
                    .retain(|g|!groups.contains(str_field(g,"id")));
                proposed["workflow"]["events"].as_array_mut()
                    .ok_or("이벤트 목록 누락")?
                    .retain(|e|!rows(field(e,"shipmentIds")).iter()
                        .any(|s|s.as_str().is_some_and(|v|ships.contains(v)))
                        &&!(has_value(field(e,"groupId")) &&
                            groups.contains(str_field(e,"groupId"))));
                let w=&proposed["workflow"];
                if rows(field(w,"queue")).iter().any(|q|
                    ships.contains(str_field(q,"shipmentId")))||
                   rows(field(w,"payments")).iter().any(|p|
                    rows(field(p,"allocations")).iter().any(|a|
                        ships.contains(str_field(a,"shipmentId"))))||
                   rows(field(w,"confirmations")).iter().any(|c|
                    rows(field(c,"shipmentIds")).iter()
                        .any(|id|id.as_str().is_some_and(|v|ships.contains(v)))){
                    return Err("접수 초안에는 입금 / 출고 기록을 만들 수 없습니다.".into());
                }
            }
            Ok(json!({"state":proposed}))
        }
        _=>Err(format!("지원하지 않는 접수 action: {action}"))
    }
}