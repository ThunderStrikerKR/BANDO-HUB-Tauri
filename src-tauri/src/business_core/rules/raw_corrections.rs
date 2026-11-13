//! src/working-raw.ts and src/receipt.ts business state operations.
//! The original recognition parser is a separately injected service output.
use serde_json::{json,Value};
use std::collections::HashSet;
use super::{field,find_by_id,flag,has_value,req,required_str,rows,set,str_field};

fn correctable(kind:&str)->bool {
    ["NAME","ADDRESS","CONTACT","CONTACT_INVALID","MODEL",
     "QUANTITY_MISSING","QUANTITY_INVALID","ITEM","UNASSIGNED_EVIDENCE"]
        .contains(&kind)
}
fn working_allowed(state:&Value,order:&Value)->bool{
    let id=str_field(order,"id");
    let w=field(state,"workflow");
    if !rows(field(state,"orders")).iter().any(|o|str_field(o,"id")==id)
        ||flag(order,"paid")||flag(order,"notified")||
        flag(order,"postpaidApproved")||str_field(order,"orderType")=="RETAIL"{
        return false;
    }
    if !super::issues::order_issues(order).iter().any(|issue|
        str_field(issue,"severity")=="ACTION"&&correctable(str_field(issue,"kind"))){
        return false;
    }
    let ships=rows(field(w,"shipments")).iter()
        .filter(|s|str_field(s,"orderId")==id).collect::<Vec<_>>();
    let ship_ids=ships.iter().map(|s|str_field(s,"id").to_string())
        .collect::<HashSet<_>>();
    if ships.iter().any(|s|field(s,"step").as_i64().unwrap_or(0)>=2||
        flag(s,"transferred")||has_value(field(s,"delivery"))){
        return false;
    }
    if rows(field(w,"payments")).iter().any(|p|
        rows(field(p,"allocations")).iter().any(|a|
            ship_ids.contains(str_field(a,"shipmentId")))){
        return false;
    }
    if rows(field(w,"confirmations")).iter().any(|c|
        rows(field(c,"shipmentIds")).iter()
            .any(|id|id.as_str().is_some_and(|x|ship_ids.contains(x)))){
        return false;
    }
    true
}
fn restore_field(target:&mut Value,source:&Value,key:&str)->Result<(),String>{
    if let Some(v)=source.get(key){set(target,key,v.clone())?;}
    else{target.as_object_mut().ok_or("주문 데이터 형식 오류")?.remove(key);}
    Ok(())
}
fn correction_record(payload:&Value,actor:&str,before:&str,after:&str,
    recipients:&Value)->Result<Value,String>{
    let ids=rows(recipients).iter().map(|r|field(r,"id").clone()).collect::<Vec<_>>();
    Ok(json!({"id":required_str(payload,"correctionId")?,
        "at":required_str(payload,"now")?,
        "actor":actor,"reason":required_str(payload,"reason")?.trim(),
        "before":before,"after":after,"affectedRecipientIds":ids}))
}
fn receipt_of(order:&Value)->Value{
    if let Some(r)=order.get("receipt").filter(|r|!r.is_null()){return r.clone();}
    let initial=rows(field(order,"rawHistory")).first()
        .and_then(|e|e.get("raw")).filter(|v|!v.is_null())
        .unwrap_or_else(||field(order,"raw"));
    json!({"original":initial,"at":field(order,"createdAt"),
        "actor":"과거 데이터 / 접수 직원 미확인",
        "clientId":field(order,"clientId"),"legacy":true})
}
pub(super) fn apply(payload:&Value)->Result<Value,String>{
    let action=required_str(payload,"action")?;
    match action {
        "raw_correctable_issue"=>Ok(json!({"correctable":correctable(
            required_str(payload,"kind")?)})),
        "raw_correction_allowed"=>Ok(json!({"allowed":working_allowed(
            req(payload,"state")?,req(payload,"order")?)})),
        "receipt_of"=>Ok(json!({"receipt":receipt_of(req(payload,"order")?)})),
        "correct_working_raw"=>{
            let input=req(payload,"state")?;
            let order=req(payload,"order")?;
            if !working_allowed(input,order){
                return Err("원문 정정 대상 오류가 없거나 입금 / 운임 확정 / 출고 이후입니다. 구조화된 변경 절차를 사용하세요.".into());
            }
            let text=required_str(payload,"text")?;
            let reason=required_str(payload,"reason")?;
            if text.trim().is_empty()||reason.trim().is_empty(){
                return Err("작업용 원문과 정정 사유를 입력하세요.".into());
            }
            let actor=str_field(field(input,"settings"),"operatorName");
            let actor=if actor.is_empty(){"직원"}else{actor};
            let before=field(order,"analysisRaw").as_str()
                .unwrap_or_else(||str_field(order,"raw"));
            if text==before{return Err("변경한 내용이 없습니다.".into());}
            let id=str_field(order,"id");
            let mut working=input.clone();
            let oi=rows(field(&working,"orders")).iter()
                .position(|o|str_field(o,"id")==id)
                .ok_or("편집할 발주를 찾을 수 없습니다.")?;
            set(&mut working["orders"][oi],"raw",json!(before))?;
            let result=super::order_mutations::apply_raw_edit(&json!({
                "state":working,"orderId":id,"raw":text,"actor":actor,
                "strictIdentity":true,
                "parsedRecipients":req(payload,"parsedRecipients")?,
                "eventIds":field(payload,"eventIds"),
                "now":required_str(payload,"now")?
            }))?;
            let mut state=field(&result,"state").clone();
            let target=&mut state["orders"][oi];
            set(target,"raw",field(order,"raw").clone())?;
            set(target,"analysisRaw",json!(text))?;
            for key in ["analysisEvidence","manualClassification"]{
                target.as_object_mut().ok_or("주문 데이터 형식 오류")?.remove(key);
            }
            for key in ["receipt","confirmationSnapshot","confirmedAt"]{
                restore_field(target,order,key)?;
            }
            let record=correction_record(payload,actor,before,text,field(target,"recipients"))?;
            let mut history=rows(field(order,"rawCorrections")).to_vec();
            history.push(record);
            set(target,"rawCorrections",json!(history))?;
            Ok(json!({"state":state}))
        }
        "correct_receipt"=>{
            let input=req(payload,"state")?;
            let order=req(payload,"order")?;
            let text=required_str(payload,"text")?;
            let reason=required_str(payload,"reason")?;
            if reason.trim().is_empty(){
                return Err("붙여넣기 오류 정정 사유를 입력하세요.".into());
            }
            let actor=required_str(payload,"actor")?;
            let id=str_field(order,"id");
            let reconciled=super::reconciliation::reconcile(&json!({
                "state":input,"draft":order,
                "now":required_str(payload,"now")?,
                "eventIds":field(payload,"reconcileEventIds")
            }))?;
            let edited=super::order_mutations::apply_raw_edit(&json!({
                "state":field(&reconciled,"state"),
                "orderId":id,"raw":text,"actor":actor,
                "strictIdentity":false,
                "parsedRecipients":req(payload,"parsedRecipients")?,
                "eventIds":field(payload,"eventIds"),
                "now":required_str(payload,"now")?
            }))?;
            let mut state=field(&edited,"state").clone();
            let oi=rows(field(&state,"orders")).iter()
                .position(|o|str_field(o,"id")==id)
                .ok_or("편집할 발주를 찾을 수 없습니다.")?;
            let target=&mut state["orders"][oi];
            set(target,"receipt",receipt_of(order))?;
            let record=correction_record(payload,actor,str_field(order,"raw"),text,
                field(target,"recipients"))?;
            let mut history=rows(field(order,"rawCorrections")).to_vec();
            history.push(record);
            set(target,"rawCorrections",json!(history))?;
            Ok(json!({"state":state}))
        },
        _=>Err(format!("지원하지 않는 원문 정정 action: {action}"))
    }
}
