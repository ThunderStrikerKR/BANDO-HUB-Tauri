//! Exact source contract: src/workflow.ts::clientChangeIssue.
//! This is read-only validation; workflow and invoice snapshots are untouched.
use serde_json::{json, Value};
use super::{field,flag,req,required_str,rows,str_field};

pub(super) fn check(payload:&Value)->Result<Value,String>{
    let state=req(payload,"state")?;
    let order=req(payload,"order")?;
    let dealer_id=required_str(payload,"dealerId")?;
    let workflow=field(state,"workflow");
    if workflow.is_null(){return Ok(json!({"issue":null}));}
    let groups=rows(field(workflow,"groups"));
    let payments=rows(field(workflow,"payments"));
    let queue=rows(field(workflow,"queue"));
    let order_id=str_field(order,"id");
    let blocked=rows(field(workflow,"shipments")).iter().any(|ship|{
        if str_field(ship,"orderId")!=order_id{return false;}
        let group_changed=groups.iter().any(|group|
            str_field(group,"id")==str_field(ship,"groupId") &&
            str_field(group,"dealerId")!=dealer_id);
        if !group_changed{return false;}
        let sid=str_field(ship,"id");
        let has_payment=payments.iter().any(|payment|
            rows(field(payment,"allocations")).iter().any(|allocation|
                str_field(allocation,"shipmentId")==sid));
        let queued=queue.iter().any(|entry|
            str_field(entry,"shipmentId")==sid &&
            str_field(entry,"status")!="CANCELLED");
        flag(ship,"transferred") ||
        field(ship,"step").as_i64().is_some_and(|step|step>=4) ||
        !field(ship,"delivery").is_null() &&
            field(ship,"delivery")!=&json!(false) &&
            field(ship,"delivery")!=&json!("") ||
        has_payment || queued
    });
    Ok(json!({"issue":if blocked {
        Some("입금 / 출고 이력이 있는 주문은 거래처를 바로 변경할 수 없습니다. 기존 건을 확인한 뒤 새 주문으로 접수하세요.")
    } else {None}}))
}
