//! Order-level mutations from src/workflow.ts within session-2 ownership.
//! Time and event UUIDs are injected by the caller to preserve determinism.
use serde_json::{json,Value};
use std::collections::HashSet;
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


// This is the workflow half of src/workflow.ts::applyOrderRawEdit.
// The recognition parser is session 1's authority: parsedRecipients is
// specifically the unchanged parseOrder(raw, selectedClient, state) output.
// No product recognition, guessed IDs, timestamps or SQLite writes happen here.
fn set_if_present(target:&mut Value,key:&str,source:&Value)->Result<(),String>{
    if let Some(value)=source.get(key){set(target,key,value.clone())?;}
    else{target.as_object_mut().ok_or("수취인 정보 형식 오류")?.remove(key);}
    Ok(())
}
fn source_texts(item:&Value,field_name:&str)->Vec<Value>{
    rows(field(item,"sources")).iter()
        .filter(|span|str_field(span,"field")==field_name)
        .map(|span|field(span,"text").clone()).collect()
}
fn retarget_sources(item:&mut Value,id:&str)->Result<(),String>{
    if let Some(sources)=item.get_mut("sources").and_then(Value::as_array_mut){
        for span in sources{set(span,"targetId",json!(id))?;}
    }
    Ok(())
}
fn merge_parsed_item(incoming:&Value,previous:&Value)->Result<Value,String>{
    let changed=source_texts(previous,"quantity")!=source_texts(incoming,"quantity");
    let manual=flag(previous,"manuallyConfirmed")&&field(previous,"raw")==field(incoming,"raw");
    let id=str_field(previous,"id");
    let mut item=if manual{previous.clone()}else{incoming.clone()};
    if manual{set_if_present(&mut item,"sources",incoming)?;}
    set(&mut item,"id",json!(id))?;
    if changed {
        set_if_present(&mut item,"quantity",incoming)?;
        set_if_present(&mut item,"quantityConfirmed",incoming)?;
        let mut combined=rows(field(&item,"issues")).iter()
            .filter(|v|v.as_str().is_some_and(|s|!s.contains("수량")))
            .cloned().collect::<Vec<_>>();
        combined.extend(rows(field(incoming,"issues")).iter()
            .filter(|v|v.as_str().is_some_and(|s|s.contains("수량"))).cloned());
        set(&mut item,"issues",json!(combined))?;
        item.as_object_mut().ok_or("상품 정보 형식 오류")?.remove("quantityApproval");
    }
    retarget_sources(&mut item,id)?;
    Ok(item)
}
fn raw_downgrade(state:&mut Value,payload:&Value,ship_index:usize,
    event_cursor:&mut usize)->Result<(),String>{
    let ship=state["workflow"]["shipments"][ship_index].clone();
    let before=field(&ship,"step").as_i64().unwrap_or(0);
    if before<=0{return Ok(());}
    let sid=str_field(&ship,"id").to_string();
    let gid=str_field(&ship,"groupId").to_string();
    let now=required_str(payload,"now")?;
    set(&mut state["workflow"]["shipments"][ship_index],"step",json!(0))?;
    // Exact downgrade() event order: each un-invalidated confirmation first.
    let confirmations=rows(field(&state["workflow"],"confirmations")).to_vec();
    for confirmation in confirmations{
        if !rows(field(&confirmation,"shipmentIds")).iter()
            .any(|v|v.as_str()==Some(sid.as_str())){continue;}
        let cid=str_field(&confirmation,"id");
        let warned=rows(field(&state["workflow"],"events")).iter().any(|e|
            str_field(e,"action")=="입금 승인 재확인 필요"&&
            field(e,"before")==field(&confirmation,"id")&&
            rows(field(e,"shipmentIds")).iter()
                .any(|v|v.as_str()==Some(sid.as_str())));
        if warned{continue;}
        event(state,sequence_id(payload,event_cursor)?,now,"시스템",
            "입금 승인 재확인 필요",&[sid.clone()],Some(&gid),
            Some(json!(cid)),None,Some("발주 원문 편집"))?;
    }
    let ship=&mut state["workflow"]["shipments"][ship_index];
    if !field(ship,"rechecks").is_array(){set(ship,"rechecks",json!([]))?;}
    ship["rechecks"].as_array_mut().ok_or("재검증 기록 오류")?.push(json!({
        "at":now,"reason":"발주 원문 편집","fromStage":before,"toStage":0
    }));
    set(ship,"legacyApproval",json!(false))?;
    if before>=3{
        let group_index=rows(field(&state["workflow"],"groups")).iter()
            .position(|g|str_field(g,"id")==gid).ok_or("현재 주문 묶음을 찾지 못했습니다.")?;
        set(&mut state["workflow"]["groups"][group_index],"needsNotice",json!(true))?;
    }
    event(state,sequence_id(payload,event_cursor)?,now,"시스템",
        "재검증 필요",&[sid],Some(&gid),
        Some(json!(before)),Some(json!(0)),Some("발주 원문 편집"))?;
    Ok(())
}
pub(super) fn apply_raw_edit(payload:&Value)->Result<Value,String>{
    let mut state=req(payload,"state")?.clone();
    let id=required_str(payload,"orderId")?;
    let raw=required_str(payload,"raw")?;
    let oi=rows(field(&state,"orders")).iter()
        .position(|o|str_field(o,"id")==id && !has_value(field(o,"deletedAt")))
        .ok_or("편집할 발주를 찾을 수 없습니다.")?;
    if raw.trim().is_empty(){return Err("발주 원문을 입력하세요.".into());}
    if str_field(&state["orders"][oi],"raw")==raw{return Ok(json!({"state":state}));}
    let mut order=state["orders"][oi].clone();
    if !field(&state,"workflow").is_object(){
        set(&mut state,"workflow",json!({"sources":[],"groups":[],"shipments":[],
            "payments":[],"queue":[],"events":[],"deliveries":[],"changeRequests":[]}))?;
    }
    let ship_indexes=rows(field(&state["workflow"],"shipments")).iter().enumerate()
        .filter(|(_,s)|str_field(s,"orderId")==id).map(|(i,_)|i)
        .collect::<Vec<_>>();
    let shipped=rows(field(&state["workflow"],"queue")).iter().any(|q|
        ["EXPORTED","STORE_SENT"].contains(&str_field(q,"status")) &&
        ship_indexes.iter().any(|si|str_field(&state["workflow"]["shipments"][*si],"id")
            ==str_field(q,"shipmentId")));
    let delivered=ship_indexes.iter().any(|si|
        has_value(field(&state["workflow"]["shipments"][*si],"delivery")));
    if shipped||delivered{
        return Err("이미 전달 / 배송한 발주는 원문을 다시 분석할 수 없습니다. 변경 요청으로 처리하세요.".into());
    }
    let parsed=req(payload,"parsedRecipients")?.as_array()
        .ok_or("분석된 수취인 목록을 입력하세요.")?.clone();
    let old=rows(field(&order,"recipients")).to_vec();
    let strict=flag(payload,"strictIdentity");
    let mut used=HashSet::<String>::new();
    let mut selected=Vec::new();
    for (index,incoming) in parsed.iter().enumerate(){
        let contact_match=old.iter().find(|prior|!used.contains(str_field(prior,"id"))&&
            ((!str_field(incoming,"mobile").is_empty()&&
                 str_field(incoming,"mobile")==str_field(prior,"mobile"))||
             (!str_field(incoming,"phone").is_empty()&&
                 str_field(incoming,"phone")==str_field(prior,"phone"))));
        let name_match=old.iter().find(|prior|!used.contains(str_field(prior,"id"))&&
            !str_field(incoming,"name").is_empty()&&
            str_field(incoming,"name")==str_field(prior,"name"));
        let index_match=if strict{None}else{
            old.get(index).filter(|prior|!used.contains(str_field(prior,"id")))
        };
        let mut row=incoming.clone();
        if let Some(previous)=contact_match.or(name_match).or(index_match){
            let previous_id=str_field(previous,"id").to_string();
            let paid=rows(field(&state["workflow"],"payments")).iter().any(|payment|
                rows(field(payment,"allocations")).iter().any(|allocation|
                    ship_indexes.iter().any(|si|{
                        let ship=&state["workflow"]["shipments"][*si];
                        str_field(ship,"id")==str_field(allocation,"shipmentId")&&
                        str_field(ship,"recipientId")==previous_id
                    })));
            if paid && str_field(previous,"name")!=str_field(&row,"name")&&
               str_field(previous,"mobile")!=str_field(&row,"mobile"){
                return Err("입금이 연결된 수취인을 다른 사람으로 바꿀 수 없습니다. 입금 배분을 먼저 확인하세요.".into());
            }
            used.insert(previous_id.clone());
            set(&mut row,"id",json!(previous_id))?;
            set_if_present(&mut row,"vatDefault",previous)?;
            set_if_present(&mut row,"vatOverride",previous)?;
            let mut used_items=HashSet::<String>::new();
            let items=rows(field(&row,"items")).to_vec();
            let mut merged=Vec::new();
            for incoming_item in &items{
                let previous_item=rows(field(previous,"items")).iter().find(|old_item|
                    !used_items.contains(str_field(old_item,"id"))&&
                    field(old_item,"raw")==field(incoming_item,"raw"))
                    .or_else(||rows(field(previous,"items")).iter().find(|old_item|
                        !used_items.contains(str_field(old_item,"id"))&&
                        field(old_item,"productId")==field(incoming_item,"productId")&&
                        field(old_item,"variantId")==field(incoming_item,"variantId")));
                if let Some(prev_item)=previous_item{
                    let merged_item=merge_parsed_item(incoming_item,prev_item)?;
                    // Mirrors source's Set.add(item.id) after object merge.
                    used_items.insert(str_field(&merged_item,"id").to_string());
                    merged.push(merged_item);
                }else{
                    let mut item=incoming_item.clone();
                    let item_id=str_field(&item,"id").to_string();
                    retarget_sources(&mut item,&item_id)?;
                    merged.push(item);
                }
            }
            set(&mut row,"items",json!(merged))?;
        }
        let rid=str_field(&row,"id").to_string();
        retarget_sources(&mut row,&rid)?;
        selected.push(row);
    }
    set(&mut order,"recipients",json!(selected))?;
    let mut cursor=0;
    for si in &ship_indexes{
        let sid=str_field(&state["workflow"]["shipments"][*si],"id").to_string();
        for q in state["workflow"]["queue"].as_array_mut().ok_or("엑셀 목록 오류")?{
            if str_field(q,"shipmentId")==sid && str_field(q,"status")=="QUEUED"{
                set(q,"status",json!("CANCELLED"))?;
            }
        }
        set(&mut state["workflow"]["shipments"][*si],"transferred",json!(false))?;
        raw_downgrade(&mut state,payload,*si,&mut cursor)?;
    }
    let now=required_str(payload,"now")?;
    let actor=actor(payload,&state).to_string();
    let previous_raw=field(&order,"raw").clone();
    if !field(&order,"rawHistory").is_array(){set(&mut order,"rawHistory",json!([]))?;}
    order["rawHistory"].as_array_mut().ok_or("원문 이력 오류")?
        .push(json!({"at":now,"raw":previous_raw,"actor":actor}));
    let client_id=rows(field(&state,"clients")).iter()
        .find(|c|str_field(c,"id")==str_field(&order,"clientId"))
        .map(|c|str_field(c,"id"))
        .or_else(||order.get("clientSnapshot").map(|c|str_field(c,"id")))
        .unwrap_or("");
    for (key,value) in [
        ("raw",json!(raw)),("analysisRaw",json!(raw)),
        ("analysisClientId",json!(client_id)),("updatedAt",json!(now)),
        ("pricesLocked",json!(false)),("notified",json!(false)),
        ("paid",json!(false)),("postpaidApproved",json!(false)),
        ("status",json!("REVIEW")),("shippingMode",json!("AUTO"))
    ]{set(&mut order,key,value)?;}
    for key in ["messageEdits","groupMessageEdits"] {
        order.as_object_mut().ok_or("주문 정보 형식 오류")?.remove(key);
    }
    state["orders"][oi]=order;
    let source_ids=rows(field(&state["workflow"],"sources")).iter()
        .filter(|s|str_field(s,"orderId")==id)
        .map(|s|str_field(s,"id").to_string()).collect::<HashSet<_>>();
    for group in state["workflow"]["groups"].as_array_mut().ok_or("묶음 목록 오류")?{
        if source_ids.contains(str_field(group,"sourceId")){
            group.as_object_mut().ok_or("묶음 정보 오류")?.remove("messageEdits");
        }
    }
    let ids=ship_indexes.iter().map(|si|
        str_field(&state["workflow"]["shipments"][*si],"id").to_string()).collect::<Vec<_>>();
    event(&mut state,sequence_id(payload,&mut cursor)?,now,&actor,
        "원문 편집",&ids,None,Some(previous_raw),Some(json!(raw)),None)?;
    let leftovers=rows(field(payload,"eventIds")).iter().skip(cursor).cloned().collect::<Vec<_>>();
    let reconciled=super::reconciliation::reconcile(&json!({
        "state":state,"now":now,"eventIds":leftovers
    }))?;
    Ok(json!({"state":field(&reconciled,"state")}))
}
