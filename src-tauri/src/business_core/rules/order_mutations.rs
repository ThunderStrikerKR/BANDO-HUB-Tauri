//! Order-level mutations from src/workflow.ts within session-2 ownership.
//! Time and event UUIDs are injected by the caller to preserve determinism.
use serde_json::{json,Value};
use super::{field,find_by_id,flag,has_value,req,required_str,rows,set,str_field};

fn event(state:&mut Value,id:&str,now:&str,actor:&str,action:&str,
    ships:&[String],group:Option<&str>,before:Option<Value>,after:Option<Value>,
    reason:Option<&str>)->Result<(),String>{
    let w=field(state,"workflow");
    if find_by_id(field(w,"events"),id).is_some(){
        return Err("업무 이벤트 ID가 중복됩니다.".into());
    }
    let mut record=json!({"id":id,"at":now,"actor":actor,"action":action,"shipmentIds":ships});
    if let Some(group)=group{set(&mut record,"groupId",json!(group))?;}
    if let Some(before)=before{set(&mut record,"before",before)?;}
    if let Some(after)=after{set(&mut record,"after",after)?;}
    if let Some(reason)=reason{set(&mut record,"reason",json!(reason))?;}
    state["workflow"]["events"].as_array_mut().ok_or("업무 이벤트 목록 누락")?.push(record);
    Ok(())
}
fn sequence_id<'a>(payload:&'a Value,pos:&mut usize)->Result<&'a str,String>{
    let id=rows(field(payload,"eventIds")).get(*pos)
        .and_then(Value::as_str).filter(|s|!s.is_empty())
        .ok_or("재검증 이벤트 ID가 부족합니다.")?;
    *pos+=1;
    Ok(id)
}
fn actor<'a>(payload:&'a Value,state:&'a Value)->&'a str{
    let explicit=str_field(payload,"actor");
    if !explicit.is_empty(){return explicit;}
    let staff=str_field(field(state,"settings"),"operatorName").trim();
    if !staff.is_empty(){staff}else{"직원"}
}
pub(super) fn delete_order(payload:&Value)->Result<Value,String>{
    let mut state=req(payload,"state")?.clone();
    let order_id=required_str(payload,"orderId")?;
    let order_index=rows(field(&state,"orders")).iter()
        .position(|o|str_field(o,"id")==order_id)
        .ok_or("삭제할 발주를 찾을 수 없습니다.")?;
    if has_value(field(&state["orders"][order_index],"deletedAt")){
        return Ok(json!({"state":state}));
    }
    let w=field(&state,"workflow");
    let ship_ids=rows(field(w,"shipments")).iter()
        .filter(|s|str_field(s,"orderId")==order_id)
        .map(|s|str_field(s,"id").to_string()).collect::<Vec<_>>();
    let has_blocker=rows(field(w,"shipments")).iter().any(|s|
        str_field(s,"orderId")==order_id &&
        (flag(s,"transferred")||field(s,"step").as_i64().unwrap_or(0)>=4||
            has_value(field(s,"delivery"))))
        || rows(field(w,"payments")).iter().any(|p|
            rows(field(p,"allocations")).iter().any(|a|
                ship_ids.iter().any(|id|id==str_field(a,"shipmentId"))));
    if has_blocker{
        return Err("입금 확인 / 공장 이관 이후에는 일반 삭제 대신 취소 / 반품 절차를 사용하세요.".into());
    }
    let now=required_str(payload,"now")?;
    let event_id=required_str(payload,"eventId")?;
    let actor=actor(payload,&state).to_string();
    if field(&state,"workflow").is_null(){
        set(&mut state,"workflow",json!({"sources":[],"groups":[],"shipments":[],
            "payments":[],"queue":[],"events":[],"deliveries":[],"changeRequests":[]}))?;
    }
    if find_by_id(field(field(&state,"workflow"),"events"),event_id).is_some(){
        return Err("업무 이벤트 ID가 중복됩니다.".into());
    }
    let mut extra_idx=0;
    for ship_id in &ship_ids{
        let si=rows(field(field(&state,"workflow"),"shipments")).iter()
            .position(|s|str_field(s,"id")==ship_id)
            .ok_or("수정할 배송 건을 확인하세요.")?;
        for q in state["workflow"]["queue"].as_array_mut().ok_or("엑셀 목록 오류")?{
            if str_field(q,"shipmentId")==ship_id&&str_field(q,"status")=="QUEUED"{
                set(q,"status",json!("CANCELLED"))?;
            }
        }
        let ship=&state["workflow"]["shipments"][si];
        let exported=rows(field(field(&state,"workflow"),"queue")).iter().any(|q|
            str_field(q,"shipmentId")==ship_id &&
            ["EXPORTED","STORE_SENT"].contains(&str_field(q,"status")));
        if exported||has_value(field(ship,"delivery")){continue;}
        let old_step=field(ship,"step").as_i64().unwrap_or(0);
        let group_id=str_field(ship,"groupId").to_string();
        set(&mut state["workflow"]["shipments"][si],"transferred",json!(false))?;
        if old_step<=0{continue;}
        set(&mut state["workflow"]["shipments"][si],"step",json!(0))?;
        let confirmations=rows(field(&state["workflow"],"confirmations")).to_vec();
        for c in confirmations {
            let cid=str_field(&c,"id");
            if !rows(field(&c,"shipmentIds")).iter()
                .any(|v|v.as_str()==Some(ship_id.as_str())){continue;}
            let warned=rows(field(&state["workflow"],"events")).iter().any(|e|
                str_field(e,"action")=="입금 승인 재확인 필요"&&
                str_field(e,"before")==cid&&
                rows(field(e,"shipmentIds")).iter()
                    .any(|v|v.as_str()==Some(ship_id.as_str())));
            if warned{continue;}
            event(&mut state,sequence_id(payload,&mut extra_idx)?,now,"시스템",
                "입금 승인 재확인 필요",&[ship_id.clone()],Some(&group_id),
                Some(json!(cid)),None,Some("발주 삭제"))?;
        }
        let s=&mut state["workflow"]["shipments"][si];
        if !field(s,"rechecks").is_array(){set(s,"rechecks",json!([]))?;}
        s["rechecks"].as_array_mut().ok_or("재검증 기록 오류")?.push(
            json!({"at":now,"reason":"발주 삭제","fromStage":old_step,"toStage":0}));
        set(s,"legacyApproval",json!(false))?;
        if old_step>=3 {
            let gi=rows(field(&state["workflow"],"groups")).iter()
                .position(|g|str_field(g,"id")==group_id).ok_or("묶음 연결 오류")?;
            set(&mut state["workflow"]["groups"][gi],"needsNotice",json!(true))?;
        }
        event(&mut state,sequence_id(payload,&mut extra_idx)?,now,"시스템",
            "재검증 필요",&[ship_id.clone()],Some(&group_id),
            Some(json!(old_step)),Some(json!(0)),Some("발주 삭제"))?;
    }
    set(&mut state["orders"][order_index],"deletedAt",json!(now))?;
    set(&mut state["orders"][order_index],"updatedAt",json!(now))?;
    let pending=rows(field(&state,"queue")).iter()
        .filter(|v|v.as_str()!=Some(order_id)).cloned().collect::<Vec<_>>();
    set(&mut state,"queue",json!(pending))?;
    event(&mut state,event_id,now,&actor,"발주 삭제",&ship_ids,
        None,Some(json!(order_id)),Some(json!(now)),None)?;
    Ok(json!({"state":state}))
}
