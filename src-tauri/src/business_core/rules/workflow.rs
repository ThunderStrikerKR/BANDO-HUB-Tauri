//! Workflow decision layer. The caller supplies all timestamps and new IDs.
//! Integration must persist the returned state using the existing SQLite transaction.
use serde_json::{json, Value};
use super::{checked_sum, field, find_by_id, flag, has_value, req, required_str, rows, safe, set, str_field};
use super::pricing;

fn index_by_id(values: &Value, id: &str) -> Option<usize> {
    rows(values).iter().position(|v|str_field(v,"id")==id)
}
fn shipment_indices(state: &Value, id: &str) -> Result<(usize,usize,usize),String> {
    let shipments = field(field(state,"workflow"),"shipments");
    let si = index_by_id(shipments,id).ok_or_else(||"수정할 배송 건을 확인하세요.".to_string())?;
    let ship = &rows(shipments)[si];
    let oi = index_by_id(field(state,"orders"),str_field(ship,"orderId"))
        .ok_or_else(||"배송 건의 발주서 / 수취인 / 거래처 연결을 확인하세요.".to_string())?;
    let ri = index_by_id(field(&state["orders"][oi],"recipients"),str_field(ship,"recipientId"))
        .ok_or_else(||"배송 건의 발주서 / 수취인 / 거래처 연결을 확인하세요.".to_string())?;
    Ok((si,oi,ri))
}
fn group_indices(state: &Value, id: &str) -> Result<(usize,Vec<usize>),String> {
    let w=field(state,"workflow");
    let gi=index_by_id(field(w,"groups"),id)
        .ok_or_else(||"현재 주문 묶음을 찾지 못했습니다.".to_string())?;
    if has_value(field(&w["groups"][gi],"deletedAt")) {
        return Err("묶음의 배송 건이 없습니다.".into());
    }
    let shipments:Vec<usize>=rows(field(w,"shipments")).iter().enumerate()
        .filter(|(_,s)|str_field(s,"groupId")==id && !flag(s,"legacyArchived")
            && !find_by_id(field(state,"orders"),str_field(s,"orderId"))
                .is_some_and(|o|has_value(field(o,"deletedAt"))))
        .map(|(i,_)|i).collect();
    if shipments.is_empty() {return Err("묶음의 배송 건이 없습니다.".into());}
    Ok((gi,shipments))
}
fn group_step(state: &Value, group_id: &str) -> Result<i64,String> {
    let (_,ids)=group_indices(state,group_id)?;
    Ok(ids.iter().filter_map(|i|field(&state["workflow"]["shipments"][*i],"step").as_i64())
        .min().unwrap_or(0))
}
fn party<'a>(state: &'a Value, order: &'a Value) -> Option<&'a Value> {
    if (has_value(field(order,"confirmedAt")) || flag(order,"pricesLocked") ||
        str_field(order,"orderType")=="RETAIL") &&
        has_value(field(order,"clientSnapshot")) {
        return Some(field(order,"clientSnapshot"));
    }
    find_by_id(field(state,"clients"),str_field(order,"clientId"))
        .or_else(||order.get("clientSnapshot"))
}
fn row_origins(row: &Value) -> Vec<&str> {
    let mut origins:Vec<&str>=Vec::new();
    for i in rows(field(row,"items")) {
        let origin=str_field(i,"origin");
        if !origins.contains(&origin) {origins.push(origin);}
    }
    origins
}
fn shipment_freight_code<'a>(order: &'a Value, row: &'a Value) -> &'a str {
    if has_value(field(row,"freightCode")) {str_field(row,"freightCode")}
    else {str_field(order,"freightCode")}
}
fn shipment_vat(order: &Value, row: &Value) -> bool {
    if let Some(v)=field(row,"vatOverride").as_bool() {return v;}
    if let Some(v)=field(row,"vatDefault").as_bool() {return v;}
    flag(order,"applyVat")
}
fn fee_total(ship: &Value, row: &Value, order: &Value) -> Option<i64> {
    if shipment_freight_code(order,row)=="020" {return Some(0);}
    let os=row_origins(row);
    if os.is_empty() {return None;}
    os.iter().map(|origin|safe(field(field(ship,"charges"),origin)))
        .collect::<Option<Vec<_>>>().and_then(checked_sum)
}
fn frozen_snapshot<'a>(state: &'a Value, ship: &Value) -> Option<&'a Value> {
    if !flag(ship,"transferred") || has_value(field(ship,"latestRecipient")) {return None;}
    rows(field(field(state,"workflow"),"queue")).iter()
        .find(|q|str_field(q,"shipmentId")==str_field(ship,"id") &&
            str_field(q,"status")!="CANCELLED")
        .and_then(|q|q.get("snapshot"))
}
pub(super) fn shipment_totals(state: &Value, shipment_id: &str) -> Result<Value,String> {
    let (si,oi,ri)=shipment_indices(state,shipment_id)?;
    let ship=&state["workflow"]["shipments"][si];
    if let Some(snap)=frozen_snapshot(state,ship) {
        return Ok(json!({
            "subtotal":field(snap,"subtotal"),"shipping":field(snap,"shipping"),
            "vat":field(snap,"vat"),"total":field(snap,"total")
        }));
    }
    let order=&state["orders"][oi];
    let row=field(order,"recipients").as_array()
        .and_then(|rs|rs.get(ri))
        .ok_or_else(||"수취인 정보를 확인하세요.".to_string())?;
    let client=party(state,order).ok_or_else(||"거래처 정보를 확인하세요.".to_string())?;
    let mut view=order.clone();
    set(&mut view,"recipients",json!([row]))?;
    set(&mut view,"freightCode",json!(shipment_freight_code(order,row)))?;
    set(&mut view,"applyVat",json!(shipment_vat(order,row)))?;
    set(&mut view,"shippingFee",json!(fee_total(ship,row,order)))?;
    set(&mut view,"pricesLocked",json!(false))?;
    set(&mut view,"vatAmount",Value::Null)?;
    pricing::totals(&view,client)
}
fn account_for<'a>(state: &'a Value,group:&Value,order:&Value,client:&Value) -> Option<&'a Value> {
    let settings=field(state,"settings");
    let accounts=field(settings,"accounts");
    if str_field(group,"accountMode")=="MANUAL" || str_field(order,"accountMode")=="MANUAL" {
        let id=if str_field(group,"accountMode")=="MANUAL" {str_field(group,"accountId")}
            else {str_field(order,"accountId")};
        return find_by_id(accounts,id);
    }
    if str_field(order,"orderType")!="RETAIL" {
        let preferred=str_field(client,"preferredAccountId");
        if let Some(a)=find_by_id(accounts,preferred) {return Some(a);}
    }
    let all_items:Vec<&Value>=rows(field(order,"recipients")).iter()
        .flat_map(|r|rows(field(r,"items")).iter()).collect();
    let only_mall=!all_items.is_empty() && all_items.iter().all(|i| {
        if !str_field(i,"catalog").is_empty() {return str_field(i,"catalog")=="BANDOMALL";}
        let product=find_by_id(field(state,"products"),str_field(i,"productId"));
        product.is_some_and(|p|str_field(p,"catalog")=="BANDOMALL")
    });
    let id=if only_mall {str_field(field(settings,"brandAccounts"),"BANDOMALL")}
        else {str_field(field(settings,"brandAccounts"),"BANDOSTAND")};
    find_by_id(accounts,if id.is_empty() {str_field(settings,"defaultAccountId")} else {id})
}
fn valid_contact(value:&str)->bool {
    let digits:String=value.chars().filter(|c|![' ','(',')','.','-'].contains(c)).collect();
    let numeric=digits.chars().all(|c|c.is_ascii_digit());
    numeric && ((digits.starts_with('0') && (9..=11).contains(&digits.len())) ||
        (digits.starts_with("050") && digits.len()==12)) &&
        (!digits.starts_with("010") || digits.len()==11)
}
fn valid_address(row:&Value,legacy:bool)->bool {
    let address=str_field(row,"address").trim();
    if address.is_empty() || (legacy && str_field(row,"addressStatus")=="CONFIRMED") {return legacy && !address.is_empty();}
    if str_field(row,"addressStatus")=="INCOMPLETE" || (address.contains('#') || address.contains('@')) {return false;}
    // Conservative non-regex equivalent for common road / lot / PO box forms.
    let markers=["대로","로","길","동 ","리 ","읍 ","면 ","사서함"];
    markers.iter().any(|m|address.match_indices(m).any(|(i,_)| {
        address[i+m.len()..].trim_start().chars().next().is_some_and(|c|c.is_ascii_digit())
    }))
}
fn basic_issues(order:&Value,recipient:&Value,client:&Value) -> Vec<String> {
    let mut issues=Vec::new();
    let name=if str_field(recipient,"name").is_empty() {"수취인"}
        else {str_field(recipient,"name")};
    if str_field(recipient,"name").trim().is_empty() {issues.push(format!("{name}: 수취인 이름을 확인하세요"));}
    if !valid_address(recipient,field(order,"receptionVersion").as_i64()!=Some(1)) {
        issues.push(format!("{name}: 상세 배송주소가 부족합니다"));
    }
    let phone=str_field(recipient,"phone");
    let mobile=str_field(recipient,"mobile");
    if !valid_contact(phone) && !valid_contact(mobile) {
        issues.push(format!("{name}: 연락처를 확인하세요"));
    }
    if !rows(field(recipient,"unassignedEvidence")).is_empty() {
        issues.push(format!("{name}: 상품 또는 수량 정보가 연결되지 않았습니다"));
    }
    if rows(field(recipient,"items")).is_empty() {issues.push(format!("{name}: 상품명 누락"));}
    for item in rows(field(recipient,"items")) {
        if str_field(item,"productId").is_empty() || str_field(item,"variantId").is_empty() {
            issues.push(format!("{name}: 미등록 상품입니다."));
        }
        if flag(field(item,"modelProposal"),"required") {
            issues.push(format!("{name}: 추천 상품의 고객 확인이 필요합니다"));
        }
        if field(item,"quantityConfirmed").as_bool()==Some(false) {
            issues.push(format!("{name}: 상품에 귀속된 수량을 확정하세요."));
        }
        if field(item,"quantity").as_i64().is_none_or(|n|n<=0) {
            issues.push(format!("{name}: 수량을 확인하세요"));
        }
        if str_field(order,"orderType")!="RETAIL" &&
            !str_field(client,"id").is_empty() &&
            safe(field(item,"unitPrice")).is_none() {
            issues.push(format!("{name}: 판매가를 등록하세요"));
        }
        if rows(field(item,"issues")).iter().any(|v|v.as_str().is_some_and(|s|
            s.contains("색상") || s.contains("옵션"))) {
            issues.push(format!("{name}: 정확한 상품 구성을 확인하세요"));
        }
    }
    issues
}
fn stage_issues(state:&Value,group_id:&str,next:i64) -> Result<Vec<String>,String> {
    let (gi,ids)=group_indices(state,group_id)?;
    let group=&state["workflow"]["groups"][gi];
    let mut issues=Vec::new();
    let mut prepay=false;
    for si in ids {
        let ship=&state["workflow"]["shipments"][si];
        let (_s,oi,ri)=shipment_indices(state,str_field(ship,"id"))?;
        let order=&state["orders"][oi];
        let row=&order["recipients"][ri];
        let client=party(state,order).ok_or_else(||"거래처 정보를 확인하세요.".to_string())?;
        prepay |= str_field(client,"payment")=="PREPAID";
        if next>=1 {
            if str_field(order,"clientId").is_empty() && str_field(order,"orderType")!="RETAIL" {
                issues.push("거래처를 선택하면 단가가 적용됩니다".into());
            }
            issues.extend(basic_issues(order,row,client));
            let sender=field(order,"senderSnapshot");
            if !has_value(sender) && str_field(order,"orderType")=="AGENCY" {
                // An explicit sender extracted from the source must be provided
                // to the stage-1 action, or already present on the order.
                // This cannot be guessed from a dealer's name.
            } else if has_value(sender) {
                if str_field(sender,"name").trim().is_empty() {issues.push("송하인 거래처명을 확인하세요".into());}
                if str_field(sender,"address").trim().is_empty() {issues.push("송하인 거래처 주소를 확인하세요".into());}
                if str_field(sender,"phone").trim().is_empty() &&
                    str_field(sender,"mobile").trim().is_empty() {
                    issues.push("송하인 거래처 연락처를 확인하세요".into());
                }
            }
            for item in rows(field(row,"items")) {
                if let Some(p)=find_by_id(field(state,"products"),str_field(item,"productId")) {
                    if has_value(field(p,"deletedAt")) || has_value(field(p,"supersededBy")) ||
                        field(p,"active").as_bool()==Some(false) {
                        issues.push("판매 상태 확인 필요".into());
                    }
                }
            }
        }
        if next>=2 && str_field(order,"orderType")!="RETAIL" {
            if fee_total(ship,row,order).is_none() {
                issues.push(format!("{}: 배송 운임을 확인하세요",str_field(row,"name")));
            }
            if field(shipment_totals(state,str_field(ship,"id"))?,"total").is_null() {
                issues.push(format!("{}: 청구액 미확정",str_field(row,"name")));
            }
        }
        if next>=3 && str_field(order,"orderType")!="RETAIL" {
            if field(ship,"step").as_i64().unwrap_or(0)<2 &&
                shipment_freight_code(order,row)!="020" {
                issues.push(format!("{}: 운임 적용 필요",str_field(row,"name")));
            }
            let account=account_for(state,group,order,client);
            if account.is_none_or(|a|["bank","number","holder"].iter().any(|k|
                str_field(a,k).trim().is_empty())) {
                issues.push("입금 계좌를 등록 / 선택하세요".into());
            }
            if flag(group,"needsNotice") {issues.push("변경된 금액 / 계좌 재안내 필요".into());}
        }
        if next>=4 && str_field(order,"orderType")!="RETAIL" {
            if field(ship,"step").as_i64().unwrap_or(0)<3 {
                issues.push(format!("{}: 계좌 안내 완료 필요",str_field(row,"name")));
            }
            if str_field(client,"payment")=="PREPAID" && !flag(ship,"legacyApproval") {
                let due=payment_due(state,ship,order,client)?;
                if due.is_none_or(|v|v>0) {
                    issues.push(format!("{}: 입금 부족 {}원",str_field(row,"name"),
                        due.map(|v|v.to_string()).unwrap_or_else(||"확인 필요".into())));
                }
            }
        }
    }
    let _=prepay;
    issues.sort();
    issues.dedup();
    Ok(issues)
}
fn payment_due(state:&Value,ship:&Value,order:&Value,client:&Value)->Result<Option<i64>,String>{
    let t=shipment_totals(state,str_field(ship,"id"))?;
    let total=safe(field(&t,"total"));
    let group_id=str_field(ship,"groupId");
    let group=find_by_id(field(field(state,"workflow"),"groups"),group_id)
        .ok_or_else(||"현재 주문 묶음을 찾지 못했습니다.".to_string())?;
    let account=account_for(state,group,order,client);
    let key=|a:&Value|json!([field(a,"id"),str_field(a,"bank").trim(),
        str_field(a,"number").trim(),str_field(a,"holder").trim()]);
    let paid=rows(field(field(state,"workflow"),"payments")).iter()
        .filter(|p|str_field(p,"dealerId")==str_field(order,"clientId") &&
            account.is_some_and(|a|key(field(p,"account"))==key(a)))
        .flat_map(|p|rows(field(p,"allocations")).iter())
        .filter(|a|str_field(a,"shipmentId")==str_field(ship,"id"))
        .filter_map(|a|safe(field(a,"amount"))).sum::<i64>();
    let acknowledged=rows(field(field(state,"workflow"),"confirmations")).iter()
        .filter(|p|str_field(p,"dealerId")==str_field(order,"clientId") &&
            account.is_some_and(|a|key(field(p,"announcedAccount"))==key(a)))
        .flat_map(|p|rows(field(p,"allocations")).iter())
        .filter(|a|str_field(a,"shipmentId")==str_field(ship,"id"))
        .filter_map(|a|safe(field(a,"amount"))).sum::<i64>();
    Ok(total.map(|t|(t-paid-acknowledged.min((t-paid).max(0))).max(0)))
}
pub(super) fn evaluate(payload:&Value)->Result<Value,String> {
    let state=req(payload,"state")?;
    let group_id=required_str(payload,"groupId")?;
    let (gi,ids)=group_indices(state,group_id)?;
    let step=group_step(state,group_id)?;
    let needs_notice=flag(&state["workflow"]["groups"][gi],"needsNotice");
    let next=if needs_notice && step>=2 {3} else {step+1};
    let issues=if next<=4 {stage_issues(state,group_id,next)?} else {Vec::new()};
    Ok(json!({"step":step,"nextStep":next,"issues":issues,
        "shipmentsCount":ids.len(),"needsNotice":needs_notice,
        "transferred":ids.iter().any(|i|flag(&state["workflow"]["shipments"][*i],"transferred"))}))
}
fn append_event(state:&mut Value,payload:&Value,action:&str,ids:&[String],
    before:Value,after:Value,group_id:&str)->Result<(),String> {
    let id=required_str(payload,"eventId")?;
    let now=required_str(payload,"now")?;
    let actor=str_field(payload,"actor");
    if find_by_id(&state["workflow"]["events"],id).is_some() {
        return Err("업무 이벤트 ID가 중복됩니다.".into());
    }
    let event=json!({"id":id,"at":now,"actor":if actor.is_empty() {"직원(이름 미설정)"}else{actor},
        "action":action,"shipmentIds":ids,"groupId":group_id,
        "before":before,"after":after});
    state["workflow"]["events"].as_array_mut().ok_or("업무 이벤트 목록 누락")?.push(event);
    Ok(())
}
fn ensure_clock(payload:&Value)->Result<(),String>{
    if required_str(payload,"now")?.trim().is_empty(){return Err("현재 시각을 입력하세요.".into());}
    if required_str(payload,"eventId")?.trim().is_empty(){return Err("이벤트 ID를 입력하세요.".into());}
    Ok(())
}
pub(super) fn apply(payload:&Value)->Result<Value,String> {
    ensure_clock(payload)?;
    let mut state=req(payload,"state")?.clone();
    let action=required_str(payload,"action")?;
    match action {
        "advance_group" => {
            let id=required_str(payload,"groupId")?;
            let (gi,ships)=group_indices(&state,id)?;
            if ships.iter().any(|i|flag(&state["workflow"]["shipments"][*i],"transferred")) {
                return Err("이미 엑셀 관리 목록으로 이관한 배송 건입니다.".into());
            }
            let step=group_step(&state,id)?;
            let notice=flag(&state["workflow"]["groups"][gi],"needsNotice");
            if step>=4 && !notice {return Err("처리완료 버튼으로 이관하세요.".into());}
            let next=if notice && step>=2 {3} else {step+1};
            let issues=stage_issues(&state,id,next)?;
            let blocking:Vec<String>=if notice && next==3 {
                issues.into_iter().filter(|s|!s.contains("변경된 금액 / 계좌 재안내 필요")).collect()
            } else {issues};
            if !blocking.is_empty(){return Err(blocking.join("\n"));}
            let first=&state["workflow"]["shipments"][ships[0]];
            let (_,oi,_)=shipment_indices(&state,str_field(first,"id"))?;
            if str_field(&state["orders"][oi],"orderType")=="RETAIL" {
                return Err("소매 주문은 전용 작성 화면에서 접수하세요.".into());
            }
            let now=required_str(payload,"now")?.to_string();
            let actor=if str_field(payload,"actor").trim().is_empty() {
                "직원(이름 미설정)".to_string()
            } else {str_field(payload,"actor").to_string()};
            let client=party(&state,&state["orders"][oi])
                .ok_or_else(||"거래처 정보를 확인하세요.".to_string())?.clone();
            let mut notices:Option<Value>=None;
            if next==3 {
                let group=&state["workflow"]["groups"][gi];
                let account=account_for(&state,group,&state["orders"][oi],&client)
                    .ok_or_else(||"등록된 계좌를 선택하세요.".to_string())?.clone();
                let notice_id=required_str(payload,"noticeId")?;
                let payment_message=required_str(payload,"paymentMessage")?;
                let mut amounts=serde_json::Map::new();
                for si in &ships {
                    let id=str_field(&state["workflow"]["shipments"][*si],"id");
                    let amount=safe(field(&shipment_totals(&state,id)?,"total"))
                        .ok_or("청구액 미확정")?;
                    amounts.insert(id.to_string(),json!(amount));
                }
                let total=checked_sum(amounts.values().filter_map(safe))
                    .ok_or("금액 합계를 확인하세요.")?;
                notices=Some(json!({"id":notice_id,"at":now,"actor":actor,
                    "shipmentIds":ships.iter().map(|i|str_field(&state["workflow"]["shipments"][*i],"id"))
                        .collect::<Vec<_>>(),
                    "amounts":Value::Object(amounts),"total":total,"account":account,
                    "message":payment_message}));
            }
            if next==1 && field(&state["orders"][oi],"receptionVersion").as_i64()==Some(1)
                && !has_value(field(&state["orders"][oi],"confirmedAt")) {
                let sender=payload.get("sender").or_else(||state["orders"][oi].get("senderSnapshot"))
                    .ok_or("최초 주문 확인에 필요한 송하인 정보를 입력하세요.")?.clone();
                let order=&mut state["orders"][oi];
                set(order,"confirmedAt",json!(now))?;
                set(order,"createdAt",json!(now))?;
                set(order,"receipt",json!({"original":field(order,"raw"),
                    "at":now,"actor":actor,"clientId":field(order,"clientId"),"legacy":false}))?;
                set(order,"clientSnapshot",client.clone())?;
                set(order,"senderSnapshot",sender)?;
                set(order,"pricesLocked",json!(true))?;
                set(order,"status",json!("STATEMENT"))?;
                let mut data=order.clone();
                data.as_object_mut().ok_or("주문 JSON 형식 오류")?.remove("confirmationSnapshot");
                let snapshot=json!({"at":now,"raw":field(order,"raw"),"client":client,
                    "recipients":field(order,"recipients"),"data":data});
                set(order,"confirmationSnapshot",snapshot)?;
            }
            if let Some(notice_value)=notices {
                state["workflow"]["groups"][gi]["notices"].as_array_mut()
                    .ok_or("안내 이력 누락")?.push(notice_value);
                set(&mut state["workflow"]["groups"][gi],"needsNotice",json!(false))?;
            }
            let ship_ids=ships.iter().map(|i|str_field(&state["workflow"]["shipments"][*i],"id").to_string()).collect::<Vec<_>>();
            for si in &ships {
                let ship_id=str_field(&state["workflow"]["shipments"][*si],"id").to_string();
                let (_index,oi,ri)=shipment_indices(&state,&ship_id)?;
                if next==1 {
                    let sender=field(&state["orders"][oi],"senderSnapshot").clone();
                    set(&mut state["workflow"]["shipments"][*si],"sender",sender)?;
                }
                if next==2 {
                    let charges=field(&state["workflow"]["shipments"][*si],"charges").clone();
                    let verified=field(&state["workflow"]["shipments"][*si],"freightVersion").clone();
                    set(&mut state["orders"][oi]["recipients"][ri],"shippingCharges",charges)?;
                    set(&mut state["workflow"]["shipments"][*si],"chargeMode",json!("MANUAL"))?;
                    set(&mut state["workflow"]["shipments"][*si],"confirmedFreightVersion",verified)?;
                }
                if next==3 {
                    // Session 3 should feed the exact message/account billing
                    // signature from the existing host logic before persistence.
                    let signature=req(payload,"billingSignature")?.clone();
                    set(&mut state["workflow"]["shipments"][*si],"billingSignature",signature)?;
                }
                if field(&state["workflow"]["shipments"][*si],"step").as_i64().unwrap_or(0)<next {
                    set(&mut state["workflow"]["shipments"][*si],"step",json!(next))?;
                    set(&mut state["workflow"]["shipments"][*si]["completedAt"],
                        &next.to_string(),json!(now))?;
                }
            }
            let label=match next {1=>"주문 확인 완료",2=>"운임 적용",
                3=>"계좌 안내 완료",4=>if str_field(&client,"payment")=="POSTPAID" {"후불 출고 승인"}
                    else {"입금 확인 완료"}, _=>return Err("잘못된 진행 단계".into())};
            append_event(&mut state,payload,label,&ship_ids,json!(step),json!(next),id)?;
            Ok(json!({"state":state,"step":next}))
        }
        "undo_group" => {
            let id=required_str(payload,"groupId")?;
            let (gi,ships)=group_indices(&state,id)?;
            if ships.iter().any(|i|flag(&state["workflow"]["shipments"][*i],"transferred")) {
                return Err("엑셀 관리 목록에서 이관 복구를 먼저 진행하세요.".into());
            }
            let step=group_step(&state,id)?;
            if step==0 {return Err("첫 단계입니다.".into());}
            if step==4 && !rows(field(state.get("workflow").unwrap_or(&Value::Null),"confirmations")).is_empty() {
                return Err("입금 승인 취소 기록의 재검증이 필요합니다.".into());
            }
            for si in &ships {
                let current=field(&state["workflow"]["shipments"][*si],"step").as_i64().unwrap_or(0);
                set(&mut state["workflow"]["shipments"][*si],"step",json!(if step==4 {3} else {current.min(step-1)}))?;
                set(&mut state["workflow"]["shipments"][*si],"legacyApproval",json!(false))?;
            }
            if step<=3 && !rows(field(&state["workflow"]["groups"][gi],"notices")).is_empty() {
                set(&mut state["workflow"]["groups"][gi],"needsNotice",json!(true))?;
            }
            if step!=4 {
                let ship_ids=ships.iter().map(|i|str_field(&state["workflow"]["shipments"][*i],"id").to_string()).collect::<Vec<_>>();
                append_event(&mut state,payload,"이전 단계 취소",&ship_ids,
                    json!(step),json!(step-1),id)?;
            }
            Ok(json!({"state":state,"step":if step==4 {3} else {step-1}}))
        }
        "set_shipment_freight" => {
            let ship_id=required_str(payload,"shipmentId")?;
            let origin=required_str(payload,"origin")?;
            if !["STORE","FACTORY"].contains(&origin) {return Err("이 배송 건의 출고지가 아닙니다.".into());}
            let value=req(payload,"value")?;
            if !value.is_null() && safe(value).is_none() {return Err("운임은 원 단위 정수로 입력하세요.".into());}
            let (si,oi,ri)=shipment_indices(&state,ship_id)?;
            if flag(&state["workflow"]["shipments"][si],"transferred") {
                return Err("수정할 배송 건을 확인하세요.".into());
            }
            if !row_origins(&state["orders"][oi]["recipients"][ri]).contains(&origin) {
                return Err("이 배송 건의 출고지가 아닙니다.".into());
            }
            let group_id=str_field(&state["workflow"]["shipments"][si],"groupId").to_string();
            let previous=field(&state["workflow"]["shipments"][si]["charges"],origin).clone();
            set(&mut state["workflow"]["shipments"][si]["charges"],origin,value.clone())?;
            let charges=field(&state["workflow"]["shipments"][si],"charges").clone();
            set(&mut state["orders"][oi]["recipients"][ri],"shippingCharges",charges)?;
            set(&mut state["workflow"]["shipments"][si],"chargeMode",json!("MANUAL"))?;
            let old_step=field(&state["workflow"]["shipments"][si],"step").as_i64().unwrap_or(0);
            if previous!=*value && old_step>1 {
                let gi=index_by_id(field(&state["workflow"],"groups"),&group_id)
                    .ok_or("현재 주문 묶음을 찾지 못했습니다.")?;
                set(&mut state["workflow"]["shipments"][si],"step",json!(1))?;
                if old_step>=3 {set(&mut state["workflow"]["groups"][gi],"needsNotice",json!(true))?;}
                set(&mut state["workflow"]["shipments"][si],"legacyApproval",json!(false))?;
                if !rows(field(&state["workflow"],"confirmations")).is_empty() {
                    return Err("입금 재확인 이벤트 입력이 필요합니다.".into());
                }
                state["workflow"]["shipments"][si]["rechecks"].as_array_mut().map(|v|v.push(json!({
                    "at":required_str(payload,"now")?,"reason":"직원이 운임 변경",
                    "fromStage":old_step,"toStage":1
                })));
            }
            append_event(&mut state,payload,"배송 건 운임 수정",&[ship_id.to_string()],
                json!({"origin":origin,"value":previous}),
                json!({"origin":origin,"value":value}),&group_id)?;
            let result_step=field(&state["workflow"]["shipments"][si],"step").clone();
            Ok(json!({"state":state,"step":result_step}))
        }
        _ => Err(format!("지원하지 않는 업무 action: {action}")),
    }
}
