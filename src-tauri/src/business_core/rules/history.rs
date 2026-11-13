//! Read-only order history: exactly the previous src/app/order-history.ts rules.
 //! Both history UI and daily settlement consume this one Rust projection.
 //! Never reprice confirmed orders against today's catalog.
use super::{field,find_by_id,flag,has_value,pricing,rows,str_field,workflow};
use chrono::{DateTime,FixedOffset,NaiveDate};
use serde_json::{json,Value};
use std::collections::HashSet;

fn client_for<'a>(state:&'a Value,order:&'a Value)->Option<Value>{
    let saved=field(order,"clientSnapshot");
    if str_field(order,"orderType")=="RETAIL" {
        if has_value(saved){return Some(saved.clone())}
        let settings=field(state,"settings");
        let name="반도스탠드";
        return Some(json!({
            "postcode":str_field(settings,"senderPostcode"),"id":"","name":name,
            "displayName":name,"address":str_field(settings,"senderAddress"),
            "phone":str_field(settings,"senderPhone"),"mobile":str_field(settings,"senderMobile"),
            "contact":"","tier":"retail","payment":"POSTPAID",
            "shippingFeeExcluded":false,"active":true,"identifiers":"","overrides":{}
        }))
    }
    if (has_value(field(order,"confirmedAt"))||flag(order,"pricesLocked")) && has_value(saved){
        return Some(saved.clone())
    }
    find_by_id(field(state,"clients"),str_field(order,"clientId")).cloned()
        .or_else(||has_value(saved).then(||saved.clone()))
}
fn active_shipments<'a>(state:&'a Value,id:&str)->Vec<&'a Value>{
    let w=field(state,"workflow");
    rows(field(w,"shipments")).iter().filter(|ship|{
        str_field(ship,"orderId")==id && !flag(ship,"legacyArchived") &&
        !find_by_id(field(w,"groups"),str_field(ship,"groupId"))
            .is_some_and(|g|has_value(field(g,"deletedAt")))
    }).collect()
}
fn only_deleted_groups(state:&Value,order_id:&str)->bool{
    let w=field(state,"workflow");
    let groups=rows(field(w,"groups")).iter().filter(|group|{
        rows(field(w,"shipments")).iter().any(|s|
            str_field(s,"orderId")==order_id && str_field(s,"groupId")==str_field(group,"id"))
    }).collect::<Vec<_>>();
    !groups.is_empty() && groups.iter().all(|g|has_value(field(g,"deletedAt")))
}
fn date_seoul(raw:&str)->String{
    if raw.is_empty(){return String::new()}
    if let Ok(t)=DateTime::parse_from_rfc3339(raw) {
        let seoul=FixedOffset::east_opt(9*3600).unwrap();
        return t.with_timezone(&seoul).format("%Y-%m-%d").to_string()
    }
    // JS Date.parse treats ISO dates without a timezone as local time.
    if let Ok(d)=NaiveDate::parse_from_str(raw,"%Y-%m-%d"){
        return d.format("%Y-%m-%d").to_string()
    }
    if let Some(date)=raw.get(..10){
        if NaiveDate::parse_from_str(date,"%Y-%m-%d").is_ok(){
            return date.to_owned()
        }
    }
    String::new()
}
fn status(state:&Value,order_id:&str)->String{
    let order=find_by_id(field(state,"orders"),order_id);
    let ships=active_shipments(state,order_id);
    if ships.is_empty(){
        return if order.is_some_and(|o|str_field(o,"status")=="EXPORTED"){
            "엑셀 추출 완료"
        }else{"처리 중"}.into()
    }
    if ships.iter().any(|s|!flag(s,"transferred")){return "처리 중".into()}
    let ids=ships.iter().map(|s|str_field(s,"id")).collect::<HashSet<_>>();
    let entries=rows(field(field(state,"workflow"),"queue")).iter()
        .filter(|q|ids.contains(str_field(q,"shipmentId")) &&
            str_field(q,"status")!="CANCELLED").collect::<Vec<_>>();
    if ships.iter().any(|s| !entries.iter().any(|e|
        str_field(e,"shipmentId")==str_field(s,"id"))) ||
        entries.iter().any(|e|str_field(e,"status")=="QUEUED"){
        return "엑셀 추출 대기".into()
    }
    if !entries.iter().all(|e|
        ["EXPORTED","STORE_SENT"].contains(&str_field(e,"status"))){
        return "엑셀 추출 대기".into()
    }
    let factory=entries.iter().filter(|e|str_field(e,"origin")=="FACTORY").collect::<Vec<_>>();
    let replies=rows(field(state,"factoryReplies")).iter()
        .flat_map(|reply|rows(field(reply,"rows"))).collect::<Vec<_>>();
    let complete=!factory.is_empty() && factory.iter().all(|entry|{
        let id=str_field(entry,"shipmentId");
        let tracking=ships.iter().find(|s|str_field(s,"id")==id)
            .map(|s|str_field(field(s,"tracking"),"FACTORY").trim())
            .unwrap_or("");
        !tracking.is_empty() && replies.iter().any(|row|flag(row,"applied")
            && str_field(row,"shipmentId")==id && str_field(row,"tracking")==tracking)
    });
    if complete{"공장 회신 완료"}else{"엑셀 추출 완료"}.into()
}
fn component(parts:&[Value],key:&str)->Value{
    if parts.is_empty(){return Value::Null}
    let mut sum=0_i64;
    for part in parts{
        let Some(n)=field(part,key).as_i64() else{return Value::Null};
        let Some(next)=sum.checked_add(n) else{return Value::Null};
        sum=next;
    }
    json!(sum)
}
pub(super) fn list(state:&Value,query:&str,date:&str)->Result<Value,String>{
    let query_lower=query.to_lowercase();
    let mut result=Vec::new();
    for order in rows(field(state,"orders")){
        let id=str_field(order,"id");
        if has_value(field(order,"deletedAt"))||only_deleted_groups(state,id)||
            (field(order,"receptionVersion").as_i64()==Some(1) &&
                !has_value(field(order,"confirmedAt"))){continue}
        let day=if has_value(field(order,"confirmedAt")){
            str_field(order,"confirmedAt")
        }else{str_field(order,"createdAt")};
        if !date.is_empty() && date_seoul(day)!=date{continue}
        let client=client_for(state,order);
        let client_name=client.as_ref().map(|v|str_field(v,"name")).unwrap_or("");
        let searchable=format!("{client_name} {}",str_field(order,"raw")).to_lowercase();
        if !searchable.contains(&query_lower){continue}
        let ships=active_shipments(state,id);
        // TS shipmentContext requires both the exact recipient and a client,
        // except when the frozen bill exists (which TS obtains before contexts).
        let mut parts=Vec::new();
        let mut recipients=Vec::new();
        if !ships.is_empty(){
            for ship in &ships{
                let shipment_id=str_field(ship,"id");
                parts.push(workflow::shipment_totals(state,shipment_id)?);
            }
            for ship in &ships{
                let recipient=rows(field(order,"recipients")).iter()
                    .find(|r|str_field(r,"id")==str_field(ship,"recipientId"));
                if client.is_none()||recipient.is_none(){
                    return Err("배송 건의 발주서 / 수취인 / 거래처 연결을 확인하세요.".into())
                }
                recipients.push(recipient.unwrap().clone());
            }
        }else{
            recipients=rows(field(order,"recipients")).to_vec();
            if let Some(c)=client.as_ref(){parts.push(pricing::totals(order,c)?)}
        }
        let billing=json!({
            "subtotal":component(&parts,"subtotal"),
            "shipping":component(&parts,"shipping"),
            "vat":component(&parts,"vat"),
            "total":component(&parts,"total")
        });
        let row=json!({
            "order":order,"client":client,"recipients":recipients,
            "total":if ships.is_empty(){
                field(&billing,"total").clone()
            }else{component(&parts,"total")},
            "billing":billing,
            "shipmentIds":ships.iter().map(|s|str_field(s,"id")).collect::<Vec<_>>(),
            "deleted":only_deleted_groups(state,id),
            "status":status(state,id)
        });
        result.push(row);
    }
    Ok(json!(result))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn legacy_export_and_missing_shipments(){
        let state=json!({"orders":[
            {"id":"legacy","raw":"legacy","status":"EXPORTED","createdAt":"2026-11-13",
                "recipients":[],"clientId":"c1"}
        ],"clients":[],"workflow":{"shipments":[],"queue":[],"groups":[]}});
        let rows=list(&state,"","2026-11-13").unwrap();
        assert_eq!(rows[0]["status"],"엑셀 추출 완료");
        assert_eq!(rows[0]["total"],Value::Null);
    }
    #[test] fn factory_reply_completes_only_with_applied_matching_tracking(){
        let state=json!({"orders":[{"id":"o1","clientId":"c1","raw":"709","createdAt":"2026-11-13",
            "recipients":[{"id":"r1","items":[] }]}],
            "clients":[{"id":"c1","tier":"wholesale"}],
            "workflow":{"shipments":[{"id":"s1","orderId":"o1","recipientId":"r1",
                "groupId":"g1","transferred":true,"tracking":{"FACTORY":"000123456789"}}],
                "groups":[{"id":"g1"}],
                "queue":[{"shipmentId":"s1","origin":"FACTORY","status":"EXPORTED",
                    "snapshot":{"subtotal":0,"shipping":0,"vat":0,"total":0}}]},
            "factoryReplies":[{"rows":[{"shipmentId":"s1","tracking":"000123456789","applied":true}]}]});
        let rows=list(&state,"","").unwrap();
        assert_eq!(rows[0]["status"],"공장 회신 완료");
        assert_eq!(rows[0]["billing"]["total"],0);
    }
}
