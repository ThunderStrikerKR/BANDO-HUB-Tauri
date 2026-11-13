//! Historical workflow migration from src/workflow.ts::migrateWorkflow.
//! This pure JSON boundary runs the existing Rust reconciliation first, then
//! maps the legacy order status into workflow shipment records. It never
//! recalculates, erases, or reallocates historical payments and receipt data.
use serde_json::{json,Value};
use std::collections::HashSet;
use super::{field,find_by_id,flag,has_value,req,required_str,rows,safe,set,str_field};
use super::{reconciliation,workflow};

fn shipping_origins(row:&Value)->Vec<String>{
    let mut unique=HashSet::<String>::new();
    let mut origins=Vec::new();
    for item in rows(field(row,"items")){
        let origin=str_field(item,"origin").to_string();
        if unique.insert(origin.clone()){origins.push(origin);}
    }
    origins
}
fn legacy_step(order:&Value)->i64 {
    if flag(order,"paid")||flag(order,"postpaidApproved")||
        matches!(str_field(order,"status"),"QUEUED"|"EXPORTED") {
        4
    }else if flag(order,"notified"){3}else{0}
}
pub(super) fn migrate(payload:&Value)->Result<Value,String>{
    let input=req(payload,"state")?;
    let timestamp=required_str(payload,"now")?;
    let provided_ids=rows(field(payload,"eventIds"));
    // All events emitted by reconcile must consume the SAME ordered UUID
    // stream as the original TS call. Reconciliation returns the count used.
    let first=reconciliation::reconcile(&json!({
        "state":input,"now":timestamp,"eventIds":provided_ids
    }))?;
    let mut state=req(&first,"state")?.clone();
    let offset=field(&first,"emittedEvents").as_u64().unwrap_or(0) as usize;
    let mut cursor=offset;
    let ship_count=rows(field(field(&state,"workflow"),"shipments")).len();
    for si in 0..ship_count {
        let ship=state["workflow"]["shipments"][si].clone();
        let oid=str_field(&ship,"orderId");
        let order=find_by_id(field(&state,"orders"),oid)
            .ok_or("배송 건의 발주서 / 수취인 / 거래처 연결을 확인하세요.")?.clone();
        let recipient=find_by_id(field(&order,"recipients"),str_field(&ship,"recipientId"))
            .ok_or("배송 건의 발주서 / 수취인 / 거래처 연결을 확인하세요.")?.clone();
        if workflow::party(&state,&order).is_none(){
            return Err("배송 건의 발주서 / 수취인 / 거래처 연결을 확인하세요.".into());
        }
        let step=legacy_step(&order);
        set(&mut state["workflow"]["shipments"][si],"step",json!(step))?;
        set(&mut state["workflow"]["shipments"][si],"legacyApproval",json!(step==4))?;
        let sender=reconciliation::sender_for(&state,&order);
        set(&mut state["workflow"]["shipments"][si],"sender",sender.clone())?;
        let origins=shipping_origins(&recipient);
        if rows(field(&order,"recipients")).len()==1 &&
            safe(field(&order,"shippingFee")).is_some(){
            set(&mut state["workflow"]["shipments"][si],"chargeMode",json!("MANUAL"))?;
            if origins.len()==1{
                set(&mut state["workflow"]["shipments"][si]["charges"],&origins[0],
                    field(&order,"shippingFee").clone())?;
            }
        }
        if step>=2 {
            let version=field(&state["workflow"]["shipments"][si],"freightVersion").clone();
            set(&mut state["workflow"]["shipments"][si],"confirmedFreightVersion",version)?;
        }
        if step>=3 {
            // Original billing -> groupAccount -> groupOrder needs an active
            // shipment in the group. An exclusively archived group cannot
            // be re-billed during legacy migration.
            let group_id=str_field(&ship,"groupId");
            let active=rows(field(&state["workflow"],"shipments")).iter()
                .any(|candidate|str_field(candidate,"groupId")==group_id &&
                    !flag(candidate,"legacyArchived")&&
                    !find_by_id(field(&state,"orders"),str_field(candidate,"orderId"))
                        .is_some_and(|order|has_value(field(order,"deletedAt"))));
            if !active{return Err("묶음의 배송 건이 없습니다.".into());}
            let signature=reconciliation::billing(&state,si)?;
            set(&mut state["workflow"]["shipments"][si],"billingSignature",json!(signature))?;
        }
        if str_field(&order,"status")=="EXPORTED" {
            set(&mut state["workflow"]["shipments"][si],"transferred",json!(true))?;
            set(&mut state["workflow"]["shipments"][si],"legacyArchived",json!(true))?;
        } else if rows(field(input,"queue")).iter().any(|q|
            q.as_str()==Some(str_field(&order,"id"))) {
            // Source calls shipmentTotals on a COPY of the shipment with
            // transferred=false, so frozen queue snapshots are not reused.
            let original_transferred=flag(&state["workflow"]["shipments"][si],"transferred");
            set(&mut state["workflow"]["shipments"][si],"transferred",json!(false))?;
            let totals=workflow::shipment_totals(&state,str_field(&ship,"id"))?;
            set(&mut state["workflow"]["shipments"][si],"transferred",
                json!(original_transferred))?;
            for origin in &origins {
                let mut selected=recipient.clone();
                let items=rows(field(&recipient,"items")).iter()
                    .filter(|i|str_field(i,"origin")==origin).cloned()
                    .collect::<Vec<Value>>();
                set(&mut selected,"items",json!(items))?;
                let entry=json!({
                    "id":format!("excel:{}:{origin}",str_field(&ship,"id")),
                    "shipmentId":field(&ship,"id"),
                    "origin":origin,
                    "at":field(&order,"updatedAt"),
                    "actor":"마이그레이션",
                    "status":"QUEUED",
                    "legacy":true,
                    "snapshot":{
                        "recipient":selected,
                        "sender":sender,
                        "freightCode":workflow::shipment_freight_code(&order,&recipient),
                        "total":field(&totals,"total"),
                        "vat":field(&totals,"vat"),
                        "subtotal":field(&totals,"subtotal"),
                        "shipping":field(&totals,"shipping")
                    }
                });
                state["workflow"]["queue"].as_array_mut()
                    .ok_or("엑셀 목록 누락")?.push(entry);
            }
            set(&mut state["workflow"]["shipments"][si],"transferred",json!(true))?;
        }
        let id=provided_ids.get(cursor).and_then(Value::as_str)
            .filter(|v|!v.trim().is_empty())
            .ok_or_else(||format!("기존 상태 보존 이벤트 ID 누락 (index {cursor})"))?;
        cursor+=1;
        if find_by_id(field(field(&state,"workflow"),"events"),id).is_some(){
            return Err("업무 이벤트 ID가 중복됩니다.".into());
        }
        let event=json!({
            "id":id,"at":timestamp,"actor":"마이그레이션",
            "action":"기존 주문 상태 보존",
            "shipmentIds":[str_field(&ship,"id")],
            "groupId":field(&ship,"groupId"),
            "after":{
                "step":step,
                "status":field(&order,"status"),
                "receiptCreated":false
            }
        });
        state["workflow"]["events"].as_array_mut()
            .ok_or("업무 이벤트 목록 누락")?.push(event);
    }
    Ok(json!({"state":state}))
}
