//! Copy-notice audit state transition from src/message-model.ts.
use serde_json::{json,Value};
use super::{field,flag,req,required_str,rows,str_field};

pub(super) fn record(payload:&Value)->Result<Value,String>{
    let mut state=req(payload,"state")?.clone();
    let group=required_str(payload,"groupId")?;
    let ty=required_str(payload,"copyType")?;
    let token=required_str(payload,"token")?;
    if !["REQUEST","PAYMENT"].contains(&ty){
        return Err("복사 메시지 종류를 확인하세요.".into());
    }
    if !field(&state,"workflow").is_object() ||
       !field(&state["workflow"],"events").is_array(){
        return Err("메시지 복사 감사 기록이 없습니다.".into());
    }
    // An already-recorded clipboard transaction is idempotent by token.
    if rows(field(&state["workflow"],"events")).iter().any(|e|
        str_field(e,"action")=="메시지 복사" &&
        str_field(field(e,"after"),"token")==token){
        return Ok(json!({"state":state}));
    }
    let deleted_group=rows(field(&state["workflow"],"groups")).iter().any(|g|
        str_field(g,"id")==group && !field(g,"deletedAt").is_null());
    let ship_ids=if deleted_group{Vec::new()}else{
        rows(field(&state["workflow"],"shipments")).iter()
            .filter(|s|str_field(s,"groupId")==group && !flag(s,"legacyArchived")&&
                !rows(field(&state,"orders")).iter().any(|o|
                    str_field(o,"id")==str_field(s,"orderId") &&
                    !field(o,"deletedAt").is_null()))
            .map(|s|field(s,"id").clone()).collect::<Vec<_>>()
    };
    let mut after=json!({"type":ty,"token":token});
    if ty=="PAYMENT" {
        after["signature"]=json!(required_str(payload,"signature")?);
    }
    let actor=str_field(field(&state,"settings"),"operatorName");
    let actor=if actor.is_empty(){"직원".to_owned()}else{actor.to_owned()};
    let event=json!({
        "id":required_str(payload,"eventId")?,
        "at":required_str(payload,"now")?,
        "actor":actor,
        "groupId":group,
        "shipmentIds":ship_ids,
        "action":"메시지 복사",
        "after":after
    });
    state["workflow"]["events"].as_array_mut()
        .ok_or("메시지 복사 감사 기록이 없습니다.")?.push(event);
    Ok(json!({"state":state}))
}
