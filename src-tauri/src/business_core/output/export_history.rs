//! Commit an already-saved factory/store XLSX into the immutable export ledger.
//! Source oracle: recordFactoryExportPrepared / recordStoreExportPrepared.
//! The caller saves XLSX bytes first, then commits this result through SQLite.
use serde_json::{json,Value};
use std::collections::HashSet;

fn string<'a>(value:&'a Value,key:&str)->Result<&'a str,String>{
    value.get(key).and_then(Value::as_str)
        .ok_or_else(||format!("출력 이력 입력 누락: {key}"))
}
fn records<'a>(value:&'a Value,key:&str)->Result<&'a [Value],String>{
    value.get(key).and_then(Value::as_array).map(Vec::as_slice)
        .ok_or_else(||format!("출력 이력 목록 누락: {key}"))
}
fn unique_rows(rows:&[Value],key:&str)->Vec<Value>{
    let mut found=HashSet::new();
    rows.iter().filter_map(|row|row.get(key)).filter(|v|found.insert((*v).clone()))
        .cloned().collect()
}
pub(super) fn finalize(payload:&Value)->Result<Value,String>{
    let state=payload.get("state").ok_or("출력 데이터 누락")?;
    let preview=payload.get("preview").ok_or("출력 미리보기 누락")?;
    let origin=string(payload,"origin")?;
    if origin!="FACTORY"&&origin!="STORE" {
        return Err("출력할 배송지 구분이 올바르지 않습니다.".into());
    }
    let path=string(payload,"savedPath")?;
    if path.trim().is_empty()||!path.to_lowercase().ends_with(".xlsx"){
        return Err("저장된 Excel 파일 경로가 올바르지 않습니다.".into());
    }
    let revision=state.get("revision").and_then(Value::as_i64).unwrap_or(0);
    if Some(revision)!=preview.get("revision").and_then(Value::as_i64) {
        return Err(if origin=="FACTORY"{
            "파일 저장 중 주문 데이터가 변경되었습니다. 저장된 파일은 공장에 전달하지 말고 최신 출고 목록을 다시 확인하세요."
        }else{
            "파일 저장 중 주문 데이터가 변경됐습니다. 이 파일을 사용하지 말고 매장 출고 목록을 다시 확인하세요."
        }.into());
    }
    let ids=preview.get("ids").ok_or("출력할 배송 건이 없습니다.")?;
    // Independently recheck every saved queue snapshot and order before
    // changing status. No previously prepared/stale caller rows are trusted.
    let fresh=super::export::prepare(state,ids,origin)?;
    if fresh.get("rows")!=preview.get("rows"){
        return Err(if origin=="FACTORY"{
            "출력하려는 배송 내용이 변경되었습니다. 방금 저장한 파일은 공장에 전달하지 마세요."
        }else{
            "출력하려는 매장 배송 내용이 변경됐습니다. 파일을 사용하지 말고 다시 검토하세요."
        }.into());
    }
    let at=string(payload,"now")?;
    let export_id=string(payload,"exportId")?;
    let event_id=string(payload,"eventId")?;
    if at.trim().is_empty()||export_id.trim().is_empty()||event_id.trim().is_empty(){
        return Err("출력 이력 시간 또는 고유 ID 누락".into());
    }
    let filename=path.rsplit(|c|c=='/'||c=='\\').next().unwrap_or(path);
    let mut next=state.clone();
    let ids=records(preview,"ids")?;
    if !next.get("exports").is_some_and(Value::is_array)||
       !next.get("workflow").and_then(|w|w.get("queue")).is_some_and(Value::is_array)||
       !next.get("workflow").and_then(|w|w.get("events")).is_some_and(Value::is_array){
        return Err("출력 이력 저장에 필요한 업무 데이터가 없습니다.".into());
    }
    if records(&next,"exports")?.iter().any(|e|e.get("id")==Some(&json!(export_id))){
        return Err("동일한 출력 이력 ID가 이미 있습니다.".into());
    }
    let mut snapshots=Vec::with_capacity(ids.len());
    for id in ids {
        let queue=next["workflow"]["queue"].as_array_mut().ok_or("Excel 대기 목록 누락")?;
        let entry=queue.iter_mut().find(|e|e.get("id")==Some(id))
            .ok_or("Excel 대기 목록의 배송 건이 변경되었습니다.")?;
        entry["status"]=json!("EXPORTED");
        entry["exportId"]=json!(export_id);
        entry["exportedAt"]=json!(at);
        entry["fileOnly"]=json!(true);
        snapshots.push(entry.clone());
    }
    let rows=records(preview,"rows")?;
    let order_ids=unique_rows(rows,"orderId");
    let shipment_ids=unique_rows(rows,"shipmentId");
    next["exports"].as_array_mut().ok_or("Excel 출력 이력 누락")?.push(json!({
        "id":export_id,"at":at,"filename":filename,"savedPath":path,
        "orderIds":order_ids,"queueEntryIds":ids,"snapshots":snapshots
    }));
    let actor=next.get("settings").and_then(|s|s.get("operatorName"))
        .and_then(Value::as_str).unwrap_or("").trim();
    let actor=if actor.is_empty(){"직원"}else{actor};
    next["workflow"]["events"].as_array_mut().ok_or("업무 감사 이력 누락")?.push(json!({
        "id":event_id,"at":at,"actor":actor,
        "action":if origin=="FACTORY"{"공장 발송 Excel 작성"}else{"매장 발송 Excel 작성"},
        "shipmentIds":shipment_ids,
        "after":{"exportId":export_id,"filename":filename}
    }));
    Ok(json!({"next":next,"filename":filename,"exportId":export_id}))
}
