//! Source-equivalent group soft-delete and restoration.
//! Port of src/group-trash.ts, not tariff-group deletion or order deletion.
use serde_json::{json,Value};
use super::{field,flag,has_value,req,required_str,rows,set,str_field};

pub(super) fn mutate(payload:&Value)->Result<Value,String>{
    let action=required_str(payload,"action")?;
    let id=required_str(payload,"groupId")?;
    let mut state=req(payload,"state")?.clone();
    let workflow=field(&state,"workflow");
    let gi=rows(field(workflow,"groups")).iter()
        .position(|g|str_field(g,"id")==id);
    match action {
        "delete_group" => {
            let Some(gi)=gi else{return Err("삭제할 묶음을 찾을 수 없습니다.".into());};
            if has_value(field(&state["workflow"]["groups"][gi],"deletedAt")){
                return Ok(json!({"state":state}));
            }
            let shipments=rows(field(&state["workflow"],"shipments")).iter()
                .filter(|s|str_field(s,"groupId")==id).collect::<Vec<_>>();
            let ship_ids=shipments.iter().map(|s|str_field(s,"id").to_string())
                .collect::<Vec<_>>();
            let blocked=shipments.iter().any(|s|flag(s,"transferred")||
                field(s,"step").as_i64().unwrap_or(0)>=4||
                has_value(field(s,"delivery")))
                ||rows(field(&state["workflow"],"payments")).iter().any(|p|
                    rows(field(p,"allocations")).iter().any(|a|
                        ship_ids.iter().any(|sid|sid==str_field(a,"shipmentId"))));
            if blocked {
                return Err("입금 확인 / 공장 이관 이후에는 일반 삭제 대신 별도 취소 절차가 필요합니다.".into());
            }
            let now=required_str(payload,"now")?;
            let event_id=required_str(payload,"eventId")?;
            let actor=str_field(field(&state,"settings"),"operatorName").to_string();
            let actor=if actor.is_empty(){"직원(이름 미설정)".to_string()}else{actor};
            set(&mut state["workflow"]["groups"][gi],"deletedAt",json!(now))?;
            state["workflow"]["events"].as_array_mut().ok_or("업무 이벤트 목록 누락")?.push(json!({
                "id":event_id,"at":now,"actor":actor,"action":"묶음 소프트 삭제",
                "groupId":id,"shipmentIds":ship_ids,
                "before":{"deletedAt":null},"after":{"deletedAt":now}
            }));
        },
        "restore_group" => {
            let Some(gi)=gi else{return Err("복원할 묶음이 없습니다.".into());};
            if !has_value(field(&state["workflow"]["groups"][gi],"deletedAt")){
                return Ok(json!({"state":state}));
            }
            let old=field(&state["workflow"]["groups"][gi],"deletedAt").clone();
            state["workflow"]["groups"][gi].as_object_mut()
                .ok_or("묶음 객체 오류")?.remove("deletedAt");
            let now=required_str(payload,"now")?;
            let event_id=required_str(payload,"eventId")?;
            let actor=str_field(field(&state,"settings"),"operatorName").to_string();
            let actor=if actor.is_empty(){"직원(이름 미설정)".to_string()}else{actor};
            let ship_ids=rows(field(&state["workflow"],"shipments")).iter()
                .filter(|s|str_field(s,"groupId")==id)
                .map(|s|str_field(s,"id").to_string()).collect::<Vec<_>>();
            state["workflow"]["events"].as_array_mut().ok_or("업무 이벤트 목록 누락")?.push(json!({
                "id":event_id,"at":now,"actor":actor,"action":"묶음 복원",
                "groupId":id,"shipmentIds":ship_ids,"before":old,"after":null
            }));
        },
        _=>return Err(format!("지원하지 않는 주문 묶음 action: {action}"))
    }
    Ok(json!({"state":state}))
}