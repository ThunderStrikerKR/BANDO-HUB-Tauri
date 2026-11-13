//! Reconciliation port from src/workflow.ts. Mutations are pure JSON.
//! IDs and timestamps for newly emitted events are caller-supplied.
use serde_json::{json,Value};
use super::{field, find_by_id, flag, has_value, req, required_str, rows, set, str_field};
use super::shipping;

fn workflow_empty() -> Value {
    json!({"sources":[],"groups":[],"shipments":[],"payments":[],
        "queue":[],"events":[],"deliveries":[],"changeRequests":[]})
}
struct Audit<'a> {
    payload:&'a Value,
    position:usize,
}
impl Audit<'_> {
    fn emit(&mut self,state:&mut Value,action:&str,shipment_ids:&[String],
        group_id:&str,before:Option<Value>,after:Option<Value>,reason:Option<&str>,
        actor:&str) -> Result<(),String> {
        let id=rows(field(self.payload,"eventIds")).get(self.position)
            .and_then(Value::as_str).filter(|v|!v.trim().is_empty())
            .ok_or_else(||format!("재조정 이벤트 ID 누락 (index {})",self.position))?;
        self.position+=1;
        if find_by_id(field(field(state,"workflow"),"events"),id).is_some() {
            return Err("업무 이벤트 ID가 중복됩니다.".into());
        }
        let mut event=json!({"id":id,"at":required_str(self.payload,"now")?,
            "actor":actor,"action":action,"shipmentIds":shipment_ids,"groupId":group_id});
        if let Some(v)=before {set(&mut event,"before",v)?;}
        if let Some(v)=after {set(&mut event,"after",v)?;}
        if let Some(v)=reason {set(&mut event,"reason",json!(v))?;}
        state["workflow"]["events"].as_array_mut()
            .ok_or("업무 이벤트 목록 누락")?.push(event);
        Ok(())
    }
}
fn party<'a>(state:&'a Value,order:&'a Value)->Option<&'a Value> {
    if (has_value(field(order,"confirmedAt")) || flag(order,"pricesLocked") ||
        str_field(order,"orderType")=="RETAIL") &&
        has_value(field(order,"clientSnapshot")) {
        return Some(field(order,"clientSnapshot"));
    }
    find_by_id(field(state,"clients"),str_field(order,"clientId"))
        .or_else(||order.get("clientSnapshot"))
}
fn sender_for(state:&Value,order:&Value)->Value {
    if has_value(field(order,"senderSnapshot")) {
        return field(order,"senderSnapshot").clone();
    }
    if ["DEALER","RETAIL"].contains(&str_field(order,"orderType")) {
        let settings=field(state,"settings");
        let name=if str_field(settings,"senderName").trim().is_empty() {"반도스탠드"}
            else {str_field(settings,"senderName").trim()};
        return json!({"postcode":str_field(settings,"senderPostcode"),"id":"",
            "name":name,"displayName":name,
            "address":str_field(settings,"senderAddress"),
            "phone":str_field(settings,"senderPhone"),
            "mobile":str_field(settings,"senderMobile"),
            "contact":"","tier":"retail","payment":"POSTPAID",
            "shippingFeeExcluded":false,"active":true,"identifiers":"","overrides":{}});
    }
    party(state,order).cloned().unwrap_or(Value::Null)
}
fn signature(order:&Value,recipient:&Value,sender:&Value)->String {
    let sender_data=json!([field(sender,"name"),field(sender,"displayName"),
        field(sender,"address"),field(sender,"phone"),field(sender,"mobile"),
        field(sender,"payment")]);
    let recipient_data=json!([field(recipient,"name"),field(recipient,"address"),
        field(recipient,"addressStatus"),field(recipient,"phone"),field(recipient,"mobile"),
        field(recipient,"note")]);
    let items=rows(field(recipient,"items")).iter().map(|i|json!([
        field(i,"id"),field(i,"productId"),field(i,"variantId"),field(i,"color"),
        field(i,"quantity"),field(i,"quantityConfirmed"),field(i,"unitPrice"),
        field(i,"origin"),field(i,"issues")
    ])).collect::<Vec<_>>();
    // Explicit key order is significant: TS stores JSON.stringify output.
    format!("{{\"dealer\":{},\"sender\":{},\"recipient\":{},\"items\":{}}}",
        field(order,"clientId"),sender_data,recipient_data,json!(items))
}
fn downgrade(state:&mut Value,audit:&mut Audit<'_>,index:usize,to:i64,reason:&str)
    ->Result<(),String> {
    let ship=state["workflow"]["shipments"][index].clone();
    let before=field(&ship,"step").as_i64().unwrap_or(0);
    if before<=to {return Ok(());}
    let ship_id=str_field(&ship,"id").to_string();
    let group_id=str_field(&ship,"groupId").to_string();
    set(&mut state["workflow"]["shipments"][index],"step",json!(to))?;
    if to<4 {
        let confirmed=rows(field(&state["workflow"],"confirmations")).iter()
            .filter(|c|rows(field(c,"shipmentIds")).iter()
                .any(|id|id.as_str()==Some(&ship_id)))
            .filter(|c|!rows(field(&state["workflow"],"events")).iter().any(|e|
                str_field(e,"action")=="입금 승인 재확인 필요" &&
                field(e,"before")==field(c,"id") &&
                rows(field(e,"shipmentIds")).iter()
                    .any(|id|id.as_str()==Some(&ship_id))))
            .map(|c|field(c,"id").clone()).collect::<Vec<_>>();
        for id in confirmed {
            audit.emit(state,"입금 승인 재확인 필요",&[ship_id.clone()],
                &group_id,Some(id),None,Some(reason),"시스템")?;
        }
    }
    if !field(&state["workflow"]["shipments"][index],"rechecks").is_array(){
        set(&mut state["workflow"]["shipments"][index],"rechecks",json!([]))?;
    }
    state["workflow"]["shipments"][index]["rechecks"].as_array_mut()
        .ok_or("재검증 이력 오류")?.push(json!({
            "at":required_str(audit.payload,"now")?,"reason":reason,
            "fromStage":before,"toStage":to
        }));
    set(&mut state["workflow"]["shipments"][index],"legacyApproval",json!(false))?;
    if before>=3 {
        let gi=rows(field(&state["workflow"],"groups")).iter()
            .position(|g|str_field(g,"id")==group_id)
            .ok_or("현재 주문 묶음을 찾지 못했습니다.")?;
        set(&mut state["workflow"]["groups"][gi],"needsNotice",json!(true))?;
    }
    audit.emit(state,"재검증 필요",&[ship_id],&group_id,
        Some(json!(before)),Some(json!(to)),Some(reason),"시스템")
}
fn billing(state:&Value,index:usize)->Result<String,String> {
    let ship=&state["workflow"]["shipments"][index];
    let group_id=str_field(ship,"groupId");
    let group=find_by_id(field(&state["workflow"],"groups"),group_id)
        .ok_or("현재 주문 묶음을 찾지 못했습니다.")?;
    let order=find_by_id(field(state,"orders"),str_field(ship,"orderId"))
        .ok_or("배송 건의 발주서 / 수취인 / 거래처 연결을 확인하세요.")?;
    let recipient=find_by_id(field(order,"recipients"),str_field(ship,"recipientId"))
        .ok_or("배송 건의 발주서 / 수취인 / 거래처 연결을 확인하세요.")?;
    let client=party(state,order).ok_or("거래처 정보를 확인하세요.")?;
    let account=super::workflow::account_for(state,group,order,client);
    let account_key=if let Some(a)=account {
        serde_json::to_string(&json!([field(a,"id"),
            str_field(a,"bank").trim(),str_field(a,"number").trim(),
            str_field(a,"holder").trim()])).map_err(|e|e.to_string())?
    } else {String::new()};
    let vat=field(recipient,"vatOverride").as_bool()
        .or_else(||field(recipient,"vatDefault").as_bool())
        .unwrap_or(flag(order,"applyVat"));
    let collect=if has_value(field(recipient,"freightCode")) {
        str_field(recipient,"freightCode")=="020"
    } else {str_field(order,"freightCode")=="020"};
    let str_json=|s:&str|serde_json::to_string(s).unwrap_or_else(|_|"null".to_string());
    let suffix=if collect {",\"collect\":true"} else {""};
    Ok(format!("{{\"info\":{},\"fees\":{},\"vat\":{},\"account\":{}{suffix}}}",
        field(ship,"infoSignature"),field(ship,"charges"),vat,str_json(&account_key)))
}
pub(super) fn reconcile(payload:&Value)->Result<Value,String> {
    let input=req(payload,"state")?;
    let mut state=input.clone();
    let mut audit=Audit{payload,position:0};
    if let Some(draft)=payload.get("draft").filter(|d|d.is_object() &&
        !has_value(field(d,"deletedAt")) &&
        (!str_field(d,"clientId").is_empty() || str_field(d,"orderType")=="RETAIL") &&
        (find_by_id(field(&state,"clients"),str_field(d,"clientId")).is_some() ||
            has_value(field(d,"clientSnapshot")))) {
        let id=str_field(draft,"id");
        if let Some(i)=rows(field(&state,"orders")).iter()
            .position(|o|str_field(o,"id")==id) {
            state["orders"][i]=draft.clone();
        } else {
            state["orders"].as_array_mut().ok_or("주문 목록 누락")?.push(draft.clone());
        }
    }
    if !field(&state,"workflow").is_object() {
        set(&mut state,"workflow",workflow_empty())?;
    }
    if !field(&state["workflow"],"confirmations").is_array() {
        set(&mut state["workflow"],"confirmations",json!([]))?;
    }
    let order_count=rows(field(&state,"orders")).len();
    for oi in 0..order_count {
        let mut order=state["orders"][oi].clone();
        let order_id=str_field(&order,"id").to_string();
        let dealer_id=str_field(&order,"clientId").to_string();
        if has_value(field(&order,"deletedAt")) ||
            (dealer_id.is_empty() && str_field(&order,"orderType")!="RETAIL") ||
            (find_by_id(field(&state,"clients"),&dealer_id).is_none() &&
                !has_value(field(&order,"clientSnapshot"))) {
            continue;
        }
        super::issues::synchronize(&mut order)?;
        state["orders"][oi]=order.clone();
        let source_id=format!("source:{order_id}");
        let root_id=format!("group:{order_id}");
        if !rows(field(&state["workflow"],"sources")).iter().any(|s|
            str_field(s,"orderId")==order_id) {
            let number=rows(field(&state["workflow"],"sources")).iter()
                .filter_map(|s|field(s,"number").as_i64()).max().unwrap_or(0).max(0)+1;
            state["workflow"]["sources"].as_array_mut()
                .ok_or("원문 목록 누락")?.push(json!({
                    "number":number,"id":source_id,"orderId":order_id,
                    "dealerId":dealer_id,"raw":field(&order,"raw"),
                    "createdAt":field(&order,"createdAt")
                }));
        }
        let source=rows(field(&state["workflow"],"sources")).iter()
            .find(|s|str_field(s,"orderId")==order_id)
            .ok_or("원문 기록 누락")?;
        let actual_source_id=str_field(source,"id").to_string();
        if find_by_id(field(&state["workflow"],"groups"),&root_id).is_none() {
            let mut root=json!({"id":root_id,"sourceId":actual_source_id,
                "dealerId":dealer_id,"rootGroupId":root_id,
                "createdAt":field(&order,"createdAt"),"notices":[],
                "needsNotice":false});
            if let Some(edits)=order.get("messageEdits") {
                set(&mut root,"messageEdits",edits.clone())?;
            }
            state["workflow"]["groups"].as_array_mut()
                .ok_or("묶음 목록 누락")?.push(root);
        }
        // The TypeScript clientChangeIssue prevents changes once financial
        // or dispatch evidence exists; earlier steps may be reassigned.
        let group_ids=rows(field(&state["workflow"],"groups")).iter()
            .filter(|g|str_field(g,"sourceId")==actual_source_id)
            .map(|g|str_field(g,"id").to_string()).collect::<Vec<_>>();
        let affected=rows(field(&state["workflow"],"shipments")).iter()
            .filter(|s|str_field(s,"orderId")==order_id &&
                group_ids.iter().any(|gid|gid==str_field(s,"groupId")) &&
                find_by_id(field(&state["workflow"],"groups"),str_field(s,"groupId"))
                    .is_some_and(|g|str_field(g,"dealerId")!=dealer_id))
            .collect::<Vec<_>>();
        if affected.iter().any(|s|flag(s,"transferred") ||
            field(s,"step").as_i64().unwrap_or(0)>=4 ||
            has_value(field(s,"delivery")) ||
            rows(field(&state["workflow"],"payments")).iter().any(|p|
                rows(field(p,"allocations")).iter().any(|a|
                    str_field(a,"shipmentId")==str_field(s,"id"))) ||
            rows(field(&state["workflow"],"queue")).iter().any(|q|
                str_field(q,"shipmentId")==str_field(s,"id") &&
                str_field(q,"status")!="CANCELLED")) {
            return Err("입금 / 출고 이력이 있는 주문은 거래처를 바로 변경할 수 없습니다. 기존 건을 확인한 뒤 새 주문으로 접수하세요.".into());
        }
        for gid in group_ids {
            let gi=rows(field(&state["workflow"],"groups")).iter()
                .position(|g|str_field(g,"id")==gid)
                .ok_or("현재 주문 묶음을 찾지 못했습니다.")?;
            let old_dealer=str_field(&state["workflow"]["groups"][gi],"dealerId").to_string();
            if old_dealer!=dealer_id {
                set(&mut state["workflow"]["groups"][gi],"dealerId",json!(dealer_id))?;
                let ship_ids=rows(field(&state["workflow"],"shipments")).iter()
                    .filter(|s|str_field(s,"groupId")==gid)
                    .map(|s|str_field(s,"id").to_string()).collect::<Vec<_>>();
                let actor=str_field(field(&state,"settings"),"operatorName").trim().to_string();
                audit.emit(&mut state,"거래처 변경",&ship_ids,&gid,
                    Some(json!(old_dealer)),Some(json!(dealer_id)),None,
                    if actor.is_empty() {"직원"} else {&actor})?;
            }
            if let Some(edits)=order.get("groupMessageEdits") {
                if let Some(value)=edits.get(&gid) {
                    set(&mut state["workflow"]["groups"][gi],"messageEdits",value.clone())?;
                } else {
                    state["workflow"]["groups"][gi].as_object_mut()
                        .ok_or("묶음 정보 오류")?.remove("messageEdits");
                }
            }
            if let Some(account)=field(&order,"groupAccounts").get(&gid) {
                set(&mut state["workflow"]["groups"][gi],"accountMode",
                    field(account,"mode").clone())?;
                set(&mut state["workflow"]["groups"][gi],"accountId",
                    field(account,"id").clone())?;
            }
        }
        let recipient_count=rows(field(&state["orders"][oi],"recipients")).len();
        for ri in 0..recipient_count {
            let mut recipient=state["orders"][oi]["recipients"][ri].clone();
            if rows(field(&recipient,"items")).is_empty() &&
                ["name","address","phone","mobile"].iter()
                    .all(|key|str_field(&recipient,key).is_empty()) {
                continue;
            }
            let order=state["orders"][oi].clone();
            let client=party(&state,&order).ok_or("거래처 정보를 확인하세요.")?.clone();
            let sender=sender_for(&state,&order);
            let info=signature(&order,&recipient,&sender);
            let mut single=order.clone();
            set(&mut single,"recipients",json!([recipient]))?;
            let reco=shipping::recommend(&single,&state)?;
            let ship_id=format!("shipment:{order_id}:{}",str_field(&recipient,"id"));
            let mut index=rows(field(&state["workflow"],"shipments")).iter().position(|s|
                str_field(s,"orderId")==order_id &&
                str_field(s,"recipientId")==str_field(&recipient,"id"));
            let frozen=index.is_some() && (has_value(field(&order,"confirmedAt")) ||
                flag(&order,"pricesLocked"));
            if index.is_none() {
                if recipient.get("vatDefault").is_none() {
                    let value=if rows(field(input,"orders")).iter().any(|o|
                        str_field(o,"id")==order_id) {
                        flag(&order,"applyVat")
                    } else {flag(&client,"defaultApplyVat")};
                    set(&mut recipient,"vatDefault",json!(value))?;
                    state["orders"][oi]["recipients"][ri]=recipient.clone();
                }
                let ship=json!({"recipientSnapshot":recipient,
                    "id":ship_id,"sourceId":actual_source_id,"orderId":order_id,
                    "recipientId":field(&recipient,"id"),"groupId":root_id,
                    "step":0,"completedAt":{},"charges":{},"chargeMode":"AUTO",
                    "freightVersion":field(&reco,"version"),"infoSignature":info,
                    "transferred":false});
                state["workflow"]["shipments"].as_array_mut()
                    .ok_or("배송 건 목록 누락")?.push(ship);
                index=Some(rows(field(&state["workflow"],"shipments")).len()-1);
            }
            let si=index.ok_or("배송 건 누락")?;
            if flag(&state["workflow"]["shipments"][si],"transferred") ||
                flag(&state["workflow"]["shipments"][si],"legacyArchived") {continue;}
            if str_field(&state["workflow"]["shipments"][si],"infoSignature")!=info {
                downgrade(&mut state,&mut audit,si,0,
                    "수취인 / 상품 / 수량 / 가격 / 출고지 / 송하인 변경")?;
                set(&mut state["workflow"]["shipments"][si],"infoSignature",json!(info))?;
            }
            let old_version=field(&state["workflow"]["shipments"][si],"freightVersion");
            let step=field(&state["workflow"]["shipments"][si],"step").as_i64().unwrap_or(0);
            if !frozen && old_version!=field(&reco,"version") &&
                !(step>=2 && str_field(&state["workflow"]["shipments"][si],"chargeMode")=="MANUAL") {
                downgrade(&mut state,&mut audit,si,1,"적용 운임 기준 변경")?;
                set(&mut state["workflow"]["shipments"][si],"freightVersion",
                    field(&reco,"version").clone())?;
            }
            let old_snapshot=field(&state["workflow"]["shipments"][si],"recipientSnapshot");
            let old_code=old_snapshot.get("freightCode")
                .filter(|v|!v.is_null())
                .unwrap_or_else(||field(&order,"freightCode"));
            let new_code=field(&recipient,"freightCode");
            let new_code=if new_code.is_null(){field(&order,"freightCode")}else{new_code};
            if old_snapshot.is_object() && old_code!=new_code {
                downgrade(&mut state,&mut audit,si,1,"운임 구분 변경")?;
            }
            set(&mut state["workflow"]["shipments"][si],"recipientSnapshot",recipient.clone())?;
            let previous_charges=field(&state["workflow"]["shipments"][si],"charges").clone();
            let mut charges=previous_charges.clone();
            if !charges.is_object() {charges=json!({});}
            let origins=rows(field(&recipient,"items")).iter()
                .map(|i|str_field(i,"origin").to_string()).collect::<Vec<_>>();
            for origin in ["FACTORY","STORE"] {
                if !origins.iter().any(|x|x==origin) {
                    charges.as_object_mut().ok_or("운임 형식 오류")?.remove(origin);
                }
            }
            if has_value(field(&recipient,"shippingCharges")) {
                set(&mut state["workflow"]["shipments"][si],"chargeMode",json!("MANUAL"))?;
                for origin in &origins {
                    let v=field(field(&recipient,"shippingCharges"),origin);
                    set(&mut charges,origin,v.clone())?;
                }
            } else if str_field(&state["workflow"]["shipments"][si],"chargeMode")=="AUTO" && !frozen {
                for origin in &origins {
                    let v=rows(field(&reco,"bundles")).iter()
                        .find(|b|str_field(b,"origin")==origin)
                        .map(|b|field(b,"recommendation")).unwrap_or(&Value::Null);
                    set(&mut charges,origin,v.clone())?;
                }
            }
            if flag(&client,"shippingFeeExcluded") {
                for origin in &origins {set(&mut charges,origin,json!(0))?;}
            }
            set(&mut state["workflow"]["shipments"][si],"charges",charges.clone())?;
            if previous_charges!=charges {
                downgrade(&mut state,&mut audit,si,1,"추천 운임 변경")?;
            }
        }
    }
    let count=rows(field(&state["workflow"],"shipments")).len();
    for si in 0..count {
        let ship=state["workflow"]["shipments"][si].clone();
        let order=find_by_id(field(&state,"orders"),str_field(&ship,"orderId"));
        let exists=order.is_some_and(|o|rows(field(o,"recipients")).iter().any(|r|
            str_field(r,"id")==str_field(&ship,"recipientId")));
        if !exists && !flag(&ship,"legacyArchived") {
            if flag(&ship,"transferred") ||
                rows(field(&state["workflow"],"payments")).iter().any(|p|
                    rows(field(p,"allocations")).iter().any(|a|
                        str_field(a,"shipmentId")==str_field(&ship,"id"))) {
                return Err("이관 / 입금 기록이 있는 배송 건은 삭제할 수 없습니다.".into());
            }
            set(&mut state["workflow"]["shipments"][si],"legacyArchived",json!(true))?;
            audit.emit(&mut state,"배송 건 제외",
                &[str_field(&ship,"id").to_string()],str_field(&ship,"groupId"),
                None,None,None,"직원")?;
        }
    }
    for si in 0..count {
        let ship=state["workflow"]["shipments"][si].clone();
        if field(&ship,"step").as_i64().unwrap_or(0)<3 ||
            flag(&ship,"transferred") || flag(&ship,"legacyArchived") ||
            !has_value(field(&ship,"billingSignature")) {continue;}
        if str_field(&ship,"billingSignature")!=billing(&state,si)? {
            let gi=rows(field(&state["workflow"],"groups")).iter()
                .position(|g|str_field(g,"id")==str_field(&ship,"groupId"))
                .ok_or("현재 주문 묶음을 찾지 못했습니다.")?;
            set(&mut state["workflow"]["groups"][gi],"needsNotice",json!(true))?;
            downgrade(&mut state,&mut audit,si,2,"계좌 / 청구 금액 변경")?;
        }
    }
    Ok(json!({"state":state,"emittedEvents":audit.position}))
}
