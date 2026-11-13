//! Structured factory/delivery correction workflow from src/corrections.ts.
//! The formatted correctionMessage remains with session 3 messaging.
//! All clock values and generated IDs are supplied by the caller.
use serde_json::{json,Value};
use std::collections::HashSet;
use super::{field,find_by_id,flag,has_value,req,required_str,rows,safe,set,str_field};

fn actor(state:&Value)->String {
    let v=str_field(field(state,"settings"),"operatorName");
    if v.is_empty(){"직원".into()}else{v.into()}
}
fn id<'a>(payload:&'a Value,n:usize)->Result<&'a str,String>{
    rows(field(payload,"ids")).get(n).and_then(Value::as_str)
        .filter(|s|!s.is_empty()).ok_or_else(||format!("정정 이벤트 ID 누락: {n}"))
}
fn push_event(state:&mut Value,payload:&Value,n:usize,action:&str,
    shipment_id:&str,before:Option<Value>,after:Option<Value>)->Result<(),String>{
    let mut e=json!({"id":id(payload,n)?,"at":required_str(payload,"now")?,
        "actor":actor(state),"action":action,"shipmentIds":[shipment_id]});
    if let Some(v)=before{set(&mut e,"before",v)?;}
    if let Some(v)=after{set(&mut e,"after",v)?;}
    state["workflow"]["events"].as_array_mut().ok_or("이벤트 목록 누락")?.push(e);
    Ok(())
}
fn status(state:&Value,request_id:&str)->String{
    rows(field(field(state,"workflow"),"events")).iter()
        .rev().find(|event|str_field(event,"action")=="정정 요청 상태" &&
            str_field(event,"before")==request_id)
        .map(|e|str_field(e,"after").to_string())
        .unwrap_or_else(||"REGISTERED".into())
}
fn log_status(state:&mut Value,payload:&Value,n:usize,
    request_id:&str,ship_id:&str,next:&str)->Result<(),String>{
    push_event(state,payload,n,"정정 요청 상태",ship_id,
        Some(json!(request_id)),Some(json!(next)))
}
fn ship_idx(state:&Value,sid:&str)->Option<usize>{
    rows(field(field(state,"workflow"),"shipments")).iter()
        .position(|s|str_field(s,"id")==sid)
}
fn recipient_idx(state:&Value,si:usize)->Option<(usize,usize)>{
    let ship=&state["workflow"]["shipments"][si];
    let oi=rows(field(state,"orders")).iter()
        .position(|o|str_field(o,"id")==str_field(ship,"orderId"))?;
    let ri=rows(field(&state["orders"][oi],"recipients")).iter()
        .position(|r|str_field(r,"id")==str_field(ship,"recipientId"))?;
    Some((oi,ri))
}
fn linked_client<'a>(state:&'a Value,order:&'a Value)->Option<&'a Value>{
    super::workflow::party(state,order)
}
pub(super) fn apply(payload:&Value)->Result<Value,String>{
    let action=required_str(payload,"action")?;
    let mut state=req(payload,"state")?.clone();
    match action {
        "correction_status"=>{
            let request_id=required_str(payload,"requestId")?;
            return Ok(json!({"status":status(&state,request_id)}));
        }
        "request_correction"=>{
            let sid=required_str(payload,"shipmentId")?;
            let si=ship_idx(&state,sid);
            if si.is_none_or(|si|!flag(&state["workflow"]["shipments"][si],"transferred")){
                return Err("전달한 배송 건을 선택하세요.".into());
            }
            let si=si.unwrap();
            let ship=&state["workflow"]["shipments"][si];
            if has_value(field(ship,"delivery"))||has_value(field(ship,"collectedAt")){
                return Err("택배 수거 / 배송 이후에는 별도 배송 변경 / 반품 처리가 필요합니다.".into());
            }
            let (oi,ri)=recipient_idx(&state,si)
                .ok_or("배송 건의 발주서 / 수취인 / 거래처 연결을 확인하세요.")?;
            let order=&state["orders"][oi];
            let client=linked_client(&state,order)
                .ok_or("배송 건의 발주서 / 수취인 / 거래처 연결을 확인하세요.")?;
            let after=req(payload,"afterRecipient")?;
            let old=&order["recipients"][ri];
            if field(after,"id")!=field(old,"id"){
                return Err("수취인 고유 ID는 변경할 수 없습니다.".into());
            }
            if old==after{return Err("변경한 내용이 없습니다.".into());}
            let known=rows(field(old,"items")).iter()
                .map(|item|str_field(item,"origin").to_string()).collect::<HashSet<_>>();
            if rows(field(after,"items")).iter().any(|item|
                !known.contains(str_field(item,"origin"))){
                return Err("출고지가 바뀌는 정정은 별도 출고 변경 처리가 필요합니다.".into());
            }
            let new_code=after.get("freightCode").filter(|x|!x.is_null())
                .unwrap_or_else(||field(order,"freightCode"));
            if !flag(client,"shippingFeeExcluded")&&new_code.as_str()!=Some("020"){
                let origins=rows(field(after,"items")).iter()
                    .map(|item|str_field(item,"origin").to_string())
                    .collect::<HashSet<_>>();
                for origin in origins {
                    let actual=field(field(after,"shippingCharges"),&origin);
                    let charge=if actual.is_null(){
                        field(field(ship,"charges"),&origin)
                    }else{actual};
                    if safe(charge).is_none(){
                        return Err("정정 운임을 원 단위 정수로 확인하세요.".into());
                    }
                }
            }
            let mut trial=order.clone();
            set(&mut trial,"recipients",json!([after]))?;
            let issues=super::issues::order_issues(&trial);
            let blocking=issues.iter().filter(|issue|
                str_field(issue,"severity")=="ACTION"&&
                field(issue,"blockingStage").as_i64().is_some_and(|v|v<=1))
                .map(|issue|str_field(issue,"title")).collect::<Vec<_>>();
            if !blocking.is_empty(){return Err(blocking.join("\n"));}
            let existing=rows(field(&state["workflow"],"changeRequests")).iter().any(|request|
                str_field(request,"shipmentId")==sid &&
                has_value(field(request,"afterRecipient")) &&
                field(request,"afterRecipient")==after &&
                status(&state,str_field(request,"id"))!="CONFIRMED");
            if existing{return Ok(json!({"state":state}));}
            let request_id=id(payload,0)?.to_string();
            let now=required_str(payload,"now")?;
            let record=json!({
                "id":request_id,"shipmentId":sid,
                "orderId":str_field(order,"id"),
                "at":now,"actor":actor(&state),"text":"배송 정보 정정 요청",
                "beforeRecipient":old,"afterRecipient":after
            });
            state["workflow"]["changeRequests"].as_array_mut()
                .ok_or("정정 요청 목록 누락")?.push(record);
            log_status(&mut state,payload,1,&request_id,sid,"REGISTERED")?;
        }
        "copied_correction"=>{
            let request_id=required_str(payload,"requestId")?;
            let request=find_by_id(field(field(&state,"workflow"),"changeRequests"),request_id)
                .filter(|r|has_value(field(r,"afterRecipient")))
                .ok_or("정정 요청을 선택하세요.")?;
            let sid=str_field(request,"shipmentId").to_string();
            if status(&state,request_id)=="REGISTERED"{
                log_status(&mut state,payload,0,request_id,&sid,"PENDING_FACTORY")?;
            }
        }
        "confirm_correction"=>{
            let request_id=required_str(payload,"requestId")?;
            let request=find_by_id(field(field(&state,"workflow"),"changeRequests"),request_id)
                .filter(|r|has_value(field(r,"afterRecipient"))&&
                    has_value(field(r,"beforeRecipient")))
                .ok_or("정정 요청을 선택하세요.")?.clone();
            let current_status=status(&state,request_id);
            if current_status=="CONFIRMED"{return Ok(json!({"state":state}));}
            if current_status!="PENDING_FACTORY"{
                return Err("변경 문구 복사 후 실제 공장 반영을 확인하세요.".into());
            }
            let sid=str_field(&request,"shipmentId").to_string();
            let si=ship_idx(&state,&sid)
                .ok_or("배송 건과 정정 요청 연결을 확인하세요.")?;
            let ship=&state["workflow"]["shipments"][si];
            if has_value(field(ship,"delivery"))||has_value(field(ship,"collectedAt")){
                return Err("택배 수거 이후 별도 배송 변경 / 반품 처리가 필요합니다.".into());
            }
            let (oi,ri)=recipient_idx(&state,si)
                .ok_or("배송 건의 발주서 / 수취인 / 거래처 연결을 확인하세요.")?;
            let before=field(&request,"beforeRecipient").clone();
            let after=field(&request,"afterRecipient").clone();
            if state["orders"][oi]["recipients"][ri]!=before{
                return Err("다른 정정이 먼저 반영되었습니다. 최신 내역으로 새 요청을 작성하세요.".into());
            }
            let old=&mut state["orders"][oi]["recipients"][ri];
            let current=old.as_object_mut().ok_or("수취인 데이터 오류")?;
            for (key,value) in after.as_object().ok_or("수취인 데이터 오류")?{
                current.insert(key.clone(),value.clone());
            }
            set(&mut state["workflow"]["shipments"][si],"latestRecipient",after.clone())?;
            if has_value(field(&after,"shippingCharges")){
                set(&mut state["workflow"]["shipments"][si],"charges",
                    field(&after,"shippingCharges").clone())?;
            }
            push_event(&mut state,payload,0,"공장 정정 반영 확인",&sid,Some(before),
                Some(json!({"requestId":request_id,"recipient":after})))?;
            log_status(&mut state,payload,1,request_id,&sid,"CONFIRMED")?;
        }
        "mark_factory_delivered"=>{
            let sid=required_str(payload,"shipmentId")?;
            if ship_idx(&state,sid).is_none(){return Err("배송 건을 선택하세요.".into());}
            let indexes=rows(field(&state["workflow"],"queue")).iter().enumerate()
                .filter(|(_,q)|str_field(q,"shipmentId")==sid &&
                    str_field(q,"origin")=="FACTORY" &&
                    str_field(q,"status")=="EXPORTED")
                .map(|(i,_)|i).collect::<Vec<_>>();
            if indexes.is_empty(){return Err("작성한 공장 엑셀이 없습니다.".into());}
            let now=required_str(payload,"now")?.to_string();
            for i in indexes {
                let q=&mut state["workflow"]["queue"][i];
                set(q,"fileOnly",json!(false))?;
                if !has_value(field(q,"factoryDeliveredAt")){
                    set(q,"factoryDeliveredAt",json!(now))?;
                }
            }
            let has_event=rows(field(&state["workflow"],"events")).iter().any(|e|
                str_field(e,"action")=="공장 전달 직원 확인"&&
                rows(field(e,"shipmentIds")).iter().any(|x|x.as_str()==Some(sid)));
            if !has_event{
                push_event(&mut state,payload,0,"공장 전달 직원 확인",sid,None,None)?;
            }
        }
        "mark_collected"=>{
            let sid=required_str(payload,"shipmentId")?;
            let si=ship_idx(&state,sid);
            if si.is_none_or(|i|!flag(&state["workflow"]["shipments"][i],"transferred")){
                return Err("전달한 배송 건을 선택하세요.".into());
            }
            let si=si.unwrap();
            if !has_value(field(&state["workflow"]["shipments"][si],"collectedAt")){
                set(&mut state["workflow"]["shipments"][si],"collectedAt",
                    json!(required_str(payload,"now")?))?;
            }
        }
        "reopen_unsent_export"=>{
            let sid=required_str(payload,"shipmentId")?;
            let si=ship_idx(&state,sid);
            if si.is_none_or(|i|has_value(field(&state["workflow"]["shipments"][i],"delivery"))||
                has_value(field(&state["workflow"]["shipments"][i],"collectedAt"))){
                return Err("현재 배송 상태에서는 복구할 수 없습니다.".into());
            }
            let si=si.unwrap();
            if rows(field(&state["workflow"],"queue")).iter().any(|q|
                str_field(q,"shipmentId")==sid&&str_field(q,"origin")=="STORE"&&
                ["EXPORTED","STORE_SENT"].contains(&str_field(q,"status"))){
                return Err("매장 Excel 출력 또는 발송 이력이 있어 전체 출고를 복구할 수 없습니다.".into());
            }
            let indexes=rows(field(&state["workflow"],"queue")).iter().enumerate()
                .filter(|(_,q)|str_field(q,"shipmentId")==sid &&
                    str_field(q,"origin")=="FACTORY" &&
                    str_field(q,"status")=="EXPORTED")
                .map(|(i,_)|i).collect::<Vec<_>>();
            if indexes.is_empty()||indexes.iter().any(|i|
                field(&state["workflow"]["queue"][*i],"fileOnly").as_bool()!=Some(true)||
                has_value(field(&state["workflow"]["queue"][*i],"factoryDeliveredAt"))){
                return Err("공장 전달 후에는 정정 요청을 사용하세요.".into());
            }
            for i in &indexes {
                let q=&state["workflow"]["queue"][*i];
                let saved=rows(field(&state,"exports")).iter().any(|export|
                    rows(field(export,"snapshots")).iter().any(|snapshot|
                        field(snapshot,"id")==field(q,"id")&&
                        field(snapshot,"snapshot")==field(q,"snapshot")));
                if !saved {
                    return Err("기존 출력 스냅샷을 보존한 뒤 복구하세요.".into());
                }
            }
            let ids=indexes.iter().map(|i|field(&state["workflow"]["queue"][*i],"id").clone())
                .collect::<Vec<_>>();
            for i in indexes {
                set(&mut state["workflow"]["queue"][i],"status",json!("CANCELLED"))?;
            }
            set(&mut state["workflow"]["shipments"][si],"transferred",json!(false))?;
            set(&mut state["workflow"]["shipments"][si],"step",json!(0))?;
            push_event(&mut state,payload,0,"전달 전 출력본 폐기 / 재작성",sid,
                Some(json!(ids)),None)?;
        }
        _=>return Err(format!("지원하지 않는 배송정정 action: {action}"))
    }
    Ok(json!({"state":state}))
}
