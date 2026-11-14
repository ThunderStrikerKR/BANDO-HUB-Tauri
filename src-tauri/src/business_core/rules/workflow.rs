//! Workflow decision layer. The caller supplies all timestamps and new IDs.
//! Integration must persist the returned state using the existing SQLite transaction.
use serde_json::{json, Value};
use super::{checked_sum, field, find_by_id, flag, has_value, req, required_str, rows, safe, set, str_field};
use super::pricing;

pub(super) fn dispatch_state(state: &Value, order_id: &str) -> Result<Value,String> {
    let shipments=rows(field(field(state,"workflow"),"shipments")).iter()
        .filter(|ship|str_field(ship,"orderId")==order_id)
        .collect::<Vec<_>>();
    let completed=!shipments.is_empty() && shipments.iter().all(|ship| {
        let order=find_by_id(field(state,"orders"),order_id);
        let row=order.and_then(|o|find_by_id(field(o,"recipients"),str_field(ship,"recipientId")));
        let Some(row)=row else {return false};
        row_origins(row).iter().all(|origin| {
            let tracking=str_field(field(ship,"tracking"),origin);
            let actual=field(ship,"actualFreight").get(*origin)
                .unwrap_or_else(||field(row,"actualFreight"));
            !tracking.is_empty() && !actual.is_null()
        })
    });
    Ok(json!({"status":if completed {"처리 완료"} else {"처리 중"}}))
}
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
pub(super) fn party<'a>(state: &'a Value, order: &'a Value) -> Option<&'a Value> {
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
pub(super) fn shipment_freight_code<'a>(order: &'a Value, row: &'a Value) -> &'a str {
    if has_value(field(row,"freightCode")) {str_field(row,"freightCode")}
    else {str_field(order,"freightCode")}
}
fn shipment_vat(order: &Value, row: &Value) -> bool {
    if let Some(v)=field(row,"vatOverride").as_bool() {return v;}
    if let Some(v)=field(row,"vatDefault").as_bool() {return v;}
    flag(order,"applyVat")
}
pub(super) fn fee_total(ship: &Value, row: &Value, order: &Value) -> Option<i64> {
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
pub(super) fn account_for<'a>(state: &'a Value,group:&Value,order:&Value,client:&Value) -> Option<&'a Value> {
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
    markers.iter().any(|m|address.match_indices(*m).any(|(i,_)| {
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
fn stage_issues(state:&Value,group_id:&str,next:i64)->Result<Vec<String>,String>{
    super::workflow_issues::stage_issues(state,group_id,next)
}
pub(super) fn payment_due(state:&Value,ship:&Value,order:&Value,client:&Value)->Result<Option<i64>,String>{
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
        .filter_map(|a|safe(field(a,"amount")))
        .try_fold(0_i64, |sum, value| sum.checked_add(value))
        .ok_or("입금액 / 배분액 오류")?;
    let acknowledged=rows(field(field(state,"workflow"),"confirmations")).iter()
        .filter(|p|str_field(p,"dealerId")==str_field(order,"clientId") &&
            account.is_some_and(|a|key(field(p,"announcedAccount"))==key(a)))
        .filter(|p| !rows(field(field(state,"workflow"),"events")).iter().any(|event|
            str_field(event,"action")=="입금 승인 재확인 필요" &&
            field(event,"before")==field(p,"id") &&
            rows(field(event,"shipmentIds")).iter().any(|sid|
                sid.as_str()==Some(str_field(ship,"id")))))
        .flat_map(|p|rows(field(p,"allocations")).iter())
        .filter(|a|str_field(a,"shipmentId")==str_field(ship,"id"))
        .filter_map(|a|safe(field(a,"amount")))
        .try_fold(0_i64, |sum, value| sum.checked_add(value))
        .ok_or("입금액 / 배분액 오류")?;
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
    let mut event=json!({"id":id,"at":now,"actor":if actor.is_empty() {"직원(이름 미설정)"}else{actor},
        "action":action,"shipmentIds":ids});
    // Original TypeScript event() receives optional before/after/groupId
    // arguments. An absent argument serializes as an OMITTED property, not
    // explicit null. Preserve genuine null only for recordActualFreight's
    // "before" evidence when no old freight exists.
    if !["실제 출고 운임 입력","매장 발송 확인"].contains(&action) {
        set(&mut event,"groupId",json!(group_id))?;
    }
    if !["처리완료 / 엑셀 관리 목록 이관","실제 입금 기록",
        "엑셀 이관 복구","매장 발송 확인",
        "전달 후 변경 요청 기록","묶음 입금 계좌 변경",
        "실제 배송 완료 / 운임 검증"].contains(&action) {
        set(&mut event,"before",before)?;
    }
    if !["엑셀 이관 복구","매장 발송 확인"].contains(&action) {
        set(&mut event,"after",after)?;
    }
    if action=="이전 단계 취소" {
        set(&mut event,"reason",json!("입금 기록과 이전 완료 이력은 보존"))?;
    }
    state["workflow"]["events"].as_array_mut().ok_or("업무 이벤트 목록 누락")?.push(event);
    Ok(())
}
fn append_extra_event(state:&mut Value,payload:&Value,id:&str,action:&str,
    ship_ids:&[String],group_id:&str,before:Value,after:Value,actor:&str,reason:&str)
    ->Result<(),String> {
    if find_by_id(field(field(state,"workflow"),"events"),id).is_some() {
        return Err("업무 이벤트 ID가 중복됩니다.".into());
    }
    let mut event=json!({"id":id,"at":required_str(payload,"now")?,
        "actor":actor,"action":action,"shipmentIds":ship_ids,
        "groupId":group_id,"before":before,"reason":reason});
    // The original downgrade event does not supply an "after" argument
    // for confirmation invalidation, only for the stage recheck.
    if action!="입금 승인 재확인 필요" {
        set(&mut event,"after",after)?;
    }
    state["workflow"]["events"].as_array_mut()
        .ok_or("업무 이벤트 목록 누락")?.push(event);
    Ok(())
}
// The receipt source positions are JavaScript UTF-16 offsets, not Rust byte
// indices. Never slice a Korean address or product expression by byte offset.
fn source_expression(raw:&str, start:&Value, end:&Value)->Option<String>{
    let a=usize::try_from(start.as_u64()?).ok()?;
    let b=usize::try_from(end.as_u64()?).ok()?;
    let units=raw.encode_utf16().collect::<Vec<_>>();
    if a>b || b>units.len(){return None;}
    String::from_utf16(&units[a..b]).ok()
}
fn preserve_confirmed_selections(order:&mut Value)->Result<(),String>{
    let raw=str_field(order,"raw").to_string();
    let recipients=order.get_mut("recipients").and_then(Value::as_array_mut)
        .ok_or("수취인 목록 오류")?;
    for recipient in recipients {
        let items=recipient.get_mut("items").and_then(Value::as_array_mut)
            .ok_or("상품 목록 오류")?;
        for item in items {
            if !flag(item,"manuallyConfirmed") ||
                str_field(item,"productId").is_empty() ||
                str_field(item,"variantId").is_empty() {
                continue;
            }
            let span=rows(field(item,"sources")).iter()
                .find(|source|str_field(source,"field")=="product");
            let Some(span)=span else {continue;};
            let text=str_field(span,"text");
            if text.is_empty() || source_expression(&raw,
                field(span,"start"),field(span,"end")).as_deref()!=Some(text) {
                continue;
            }
            set(item,"selectionEvidence",json!({
                "expression":text,"productId":field(item,"productId"),
                "variantId":field(item,"variantId")
            }))?;
        }
    }
    Ok(())
}
fn ensure_clock(payload:&Value)->Result<(),String>{
    if required_str(payload,"now")?.trim().is_empty(){return Err("현재 시각을 입력하세요.".into());}
    if required_str(payload,"eventId")?.trim().is_empty(){return Err("이벤트 ID를 입력하세요.".into());}
    Ok(())
}
pub(super) fn apply(payload:&Value)->Result<Value,String> {
    ensure_clock(payload)?;
    let action=required_str(payload,"action")?;
    let mut state=req(payload,"state")?.clone();
    // All original workflow mutations except the three direct-clone
    // operations first run reconcileWorkflow(input). Keep that transition
    // inside this pure Rust entry point: without it, recipientSnapshot,
    // infoSignature and tariff revisions can remain stale between actions.
    // Any reconcile-created audit IDs are caller-injected independently of
    // the action's own eventId, preserving the original chronology.
    if payload.get("reconcileEventIds").is_some() &&
        !["record_actual_freight","mark_store_sent","record_change_request"]
            .contains(&action) {
        let reconciled=super::reconciliation::reconcile(&json!({
            "state":state,"now":required_str(payload,"now")?,
            "eventIds":field(payload,"reconcileEventIds")
        }))?;
        state=field(&reconciled,"state").clone();
    }
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
                // The Rust output engine renders this frozen text before
                // invoking rules. Keep the pure rules crate independent of
                // the output crate for isolated TS/Rust differential tests.
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
                // The source TS uses senderFor(order,state) during first confirmation.
                // Rust already owns an equivalent sender_for rule, including
                // explicitly supplied sender lines in the source document.
                let sender=payload.get("sender")
                    .filter(|s|!s.is_null())
                    .cloned()
                    .unwrap_or_else(||super::reconciliation::sender_for(
                        &state,&state["orders"][oi]));
                let order=&mut state["orders"][oi];
                // Preserve the explicit staff-to-source product selection
                // before capturing the immutable first-receipt snapshot.
                preserve_confirmed_selections(order)?;
                set(order,"confirmedAt",json!(now))?;
                set(order,"createdAt",json!(now))?;
                let receipt_original=field(order,"raw").clone();
                let receipt_client_id=field(order,"clientId").clone();
                let receipt=json!({"original":receipt_original,
                    "at":now,"actor":actor,"clientId":receipt_client_id,"legacy":false});
                set(order,"receipt",receipt)?;
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
                // advanceGroup resolves rechecks when the new step reaches
                // their original fromStage. It does not erase audit history.
                if let Some(rechecks)=state["workflow"]["shipments"][*si].get_mut("rechecks")
                    .and_then(Value::as_array_mut) {
                    for record in rechecks {
                        if !has_value(field(record,"resolvedAt")) &&
                            field(record,"fromStage").as_i64().is_some_and(|n|next>=n){
                            set(record,"resolvedAt",json!(now))?;
                        }
                    }
                }
                let ship_id=str_field(&state["workflow"]["shipments"][*si],"id").to_string();
                let (_index,oi,ri)=shipment_indices(&state,&ship_id)?;
                if next==1 {
                    let sender=super::reconciliation::sender_for(&state,&state["orders"][oi]);
                    set(&mut state["workflow"]["shipments"][*si],"sender",sender)?;
                }
                if next==2 {
                    let mut individual=state["orders"][oi].clone();
                    let row=state["orders"][oi]["recipients"][ri].clone();
                    set(&mut individual,"recipients",json!([row]))?;
                    let recommendation=super::shipping::recommend(&individual,&state)?;
                    let version=field(&state["workflow"]["shipments"][*si],"freightVersion").clone();
                    let basis_current=version==*field(&recommendation,"version");
                    let charges=field(&state["workflow"]["shipments"][*si],"charges").clone();
                    set(&mut state["orders"][oi]["recipients"][ri],"shippingCharges",charges)?;
                    set(&mut state["workflow"]["shipments"][*si],"chargeMode",json!("MANUAL"))?;
                    set(&mut state["workflow"]["shipments"][*si],"confirmedFreightVersion",version)?;
                    if basis_current {
                        let epoch=field(field(&state,"shipping"),"epoch").as_i64().unwrap_or(1);
                        let applied=rows(field(&recommendation,"bundles")).iter().map(|bundle|
                            json!({"origin":field(bundle,"origin"),
                                "key":field(bundle,"key"),
                                "versions":field(bundle,"versions"),
                                "description":field(bundle,"description")}))
                            .collect::<Vec<_>>();
                        set(&mut state["workflow"]["shipments"][*si],"appliedEpoch",json!(epoch))?;
                        set(&mut state["workflow"]["shipments"][*si],"appliedBundles",json!(applied))?;
                    }
                }
                if next==3 {
                    // Shipment signatures differ by recipient, freight and VAT.
                    // Compute each using the Rust equivalent of TS billing(),
                    // never reuse one group's signature across all recipients.
                    let signature=super::reconciliation::billing(&state,*si)?;
                    set(&mut state["workflow"]["shipments"][*si],
                        "billingSignature",json!(signature))?;
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
            if step==4 {
                // Source undoGroup revokes only confirmations that include
                // an affected shipment and are not already invalidated
                // by a prior recheck event. For partial confirmations retain
                // allocations belonging to unaffected shipments.
                let affected=ships.iter().map(|i|
                    str_field(&state["workflow"]["shipments"][*i],"id").to_string()
                ).collect::<std::collections::HashSet<_>>();
                let old=rows(field(&state["workflow"],"confirmations")).to_vec();
                let mut next_confirmations=Vec::new();
                for mut confirmation in old {
                    let already_invalidated=rows(field(&state["workflow"],"events")).iter()
                        .any(|e|str_field(e,"action")=="입금 승인 재확인 필요" &&
                            field(e,"before")==field(&confirmation,"id"));
                    let contains_affected=rows(field(&confirmation,"shipmentIds")).iter()
                        .any(|sid|sid.as_str().is_some_and(|v|affected.contains(v)));
                    if already_invalidated||!contains_affected{
                        next_confirmations.push(confirmation);continue;
                    }
                    let remaining=rows(field(&confirmation,"shipmentIds")).iter()
                        .filter(|id|!id.as_str().is_some_and(|sid|affected.contains(sid)))
                        .cloned().collect::<Vec<_>>();
                    if remaining.is_empty(){continue;}
                    let mut amounts=serde_json::Map::new();
                    for id in &remaining{
                        let sid=id.as_str().unwrap_or("");
                        let v=field(field(&confirmation,"amounts"),sid)
                            .as_i64().or_else(||rows(field(&confirmation,"allocations"))
                                .iter().find(|a|str_field(a,"shipmentId")==sid)
                                .and_then(|a|field(a,"amount").as_i64())).unwrap_or(0);
                        amounts.insert(sid.to_string(),json!(v));
                    }
                    let allocations=rows(field(&confirmation,"allocations")).iter()
                        .filter(|allocation|!affected.contains(str_field(allocation,"shipmentId")))
                        .cloned().collect::<Vec<_>>();
                    let total=amounts.values().filter_map(Value::as_i64).sum::<i64>();
                    set(&mut confirmation,"shipmentIds",json!(remaining))?;
                    set(&mut confirmation,"allocations",json!(allocations))?;
                    set(&mut confirmation,"amounts",Value::Object(amounts))?;
                    set(&mut confirmation,"amount",json!(total))?;
                    next_confirmations.push(confirmation);
                }
                set(&mut state["workflow"],"confirmations",json!(next_confirmations))?;
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
                let active_confirms=rows(field(&state["workflow"],"confirmations")).iter()
                    .filter(|c|rows(field(c,"shipmentIds")).iter()
                        .any(|id|id.as_str()==Some(ship_id)))
                    .filter(|c|!rows(field(&state["workflow"],"events")).iter().any(|e|
                        str_field(e,"action")=="입금 승인 재확인 필요" &&
                        field(e,"before")==field(c,"id") &&
                        rows(field(e,"shipmentIds")).iter().any(|id|id.as_str()==Some(ship_id))))
                    .map(|c|str_field(c,"id").to_string()).collect::<Vec<_>>();
                if !state["workflow"]["shipments"][si]["rechecks"].is_array() {
                    set(&mut state["workflow"]["shipments"][si],"rechecks",json!([]))?;
                }
                state["workflow"]["shipments"][si]["rechecks"].as_array_mut()
                    .ok_or("재확인 이력 목록 오류")?.push(json!({
                    "at":required_str(payload,"now")?,"reason":"직원이 운임 변경",
                    "fromStage":old_step,"toStage":1
                }));
                let seed=required_str(payload,"eventId")?;
                let audit_ids=rows(field(payload,"auditEventIds"));
                let mut audit_cursor=0usize;
                for confirmation_id in active_confirms {
                    let fallback=format!("{seed}:reconfirm:{ship_id}:{confirmation_id}");
                    let id=audit_ids.get(audit_cursor).and_then(Value::as_str)
                        .unwrap_or(fallback.as_str());
                    audit_cursor+=1;
                    append_extra_event(&mut state,payload,id,
                        "입금 승인 재확인 필요",&[ship_id.to_string()],&group_id,
                        json!(confirmation_id),Value::Null,"시스템","직원이 운임 변경")?;
                }
                let fallback=format!("{seed}:recheck:{ship_id}");
                let id=audit_ids.get(audit_cursor).and_then(Value::as_str)
                    .unwrap_or(fallback.as_str());
                append_extra_event(&mut state,payload,id,"재검증 필요",
                    &[ship_id.to_string()],&group_id,json!(old_step),json!(1),
                    "시스템","직원이 운임 변경")?;
            }
            append_event(&mut state,payload,"배송 건 운임 수정",&[ship_id.to_string()],
                json!({"origin":origin,"value":previous}),
                json!({"origin":origin,"value":value}),&group_id)?;
            let result_step=field(&state["workflow"]["shipments"][si],"step").clone();
            Ok(json!({"state":state,"step":result_step}))
        }
        "process_group" => {
            let group_id=required_str(payload,"groupId")?;
            let (gi,ships)=group_indices(&state,group_id)?;
            if ships.iter().all(|i|flag(&state["workflow"]["shipments"][*i],"transferred")) {
                return Ok(json!({"state":state,"entries":[]}));
            }
            if ships.iter().any(|i|flag(&state["workflow"]["shipments"][*i],"transferred")) {
                return Err("이미 일부가 이관되어 있습니다. 이관 상태를 먼저 확인하세요.".into());
            }
            if ships.iter().any(|i|field(&state["workflow"]["shipments"][*i],"step").as_i64()!=Some(4))
                || flag(&state["workflow"]["groups"][gi],"needsNotice") {
                return Err("네 단계와 변경 금액 재안내를 먼저 완료하세요.".into());
            }
            let issues=stage_issues(&state,group_id,4)?;
            if !issues.is_empty(){return Err(issues.join("\n"));}
            let actor=if str_field(payload,"actor").is_empty() {"직원(이름 미설정)"}
                else {str_field(payload,"actor")}.to_string();
            let now=required_str(payload,"now")?.to_string();
            let mut entries=Vec::new();
            let ids=ships.iter().map(|si|str_field(&state["workflow"]["shipments"][*si],"id")
                .to_string()).collect::<Vec<_>>();
            for si in ships {
                let ship_id=str_field(&state["workflow"]["shipments"][si],"id").to_string();
                let (_index,oi,ri)=shipment_indices(&state,&ship_id)?;
                let order=state["orders"][oi].clone();
                let row=order["recipients"][ri].clone();
                let client=party(&state,&order)
                    .ok_or("거래처 정보를 확인하세요.")?.clone();
                let sender=state["workflow"]["shipments"][si].get("sender")
                    .filter(|v|!v.is_null()).unwrap_or(&client).clone();
                let totals=shipment_totals(&state,&ship_id)?;
                // The original processGroup persists RETAIL queue snapshots
                // even when their outside-payment accounting fields are null.
                // Other order types still require confirmed numeric totals.
                if str_field(&order,"orderType")!="RETAIL" {
                    for key in ["total","subtotal","shipping","vat"] {
                        if safe(field(&totals,key)).is_none() {
                            return Err("청구액 미확정".into());
                        }
                    }
                }
                let freight_code=shipment_freight_code(&order,&row).to_string();
                for origin in row_origins(&row) {
                    let entry_id=format!("excel:{ship_id}:{origin}");
                    let existing_index=index_by_id(field(&state["workflow"],"queue"),&entry_id);
                    if existing_index.is_some_and(|i|str_field(
                        &state["workflow"]["queue"][i],"status")!="CANCELLED") {
                        return Err("이미 등록된 배송 건입니다.".into());
                    }
                    let mut selected=row.clone();
                    set(&mut selected,"items",json!(rows(field(&row,"items")).iter()
                        .filter(|item|str_field(item,"origin")==origin)
                        .cloned().collect::<Vec<_>>()))?;
                    let entry=json!({
                        "id":entry_id,"shipmentId":ship_id,"origin":origin,
                        "at":now,"actor":actor,"status":"QUEUED",
                        "snapshot":{"recipient":selected,"sender":sender,
                            "freightCode":freight_code,"total":field(&totals,"total"),
                            "vat":field(&totals,"vat"),"subtotal":field(&totals,"subtotal"),
                            "shipping":field(&totals,"shipping")}
                    });
                    if let Some(i)=existing_index {
                        state["workflow"]["queue"][i]=entry.clone();
                    } else {
                        state["workflow"]["queue"].as_array_mut()
                            .ok_or("엑셀 관리 대기열 형식 오류")?.push(entry.clone());
                    }
                    entries.push(entry);
                }
                set(&mut state["workflow"]["shipments"][si],"transferred",json!(true))?;
            }
            append_event(&mut state,payload,"처리완료 / 엑셀 관리 목록 이관",&ids,
                Value::Null,json!({"entries":entries}),group_id)?;
            Ok(json!({"state":state,"entries":entries}))
        }
        "record_actual_freight" => {
            let ship_id=required_str(payload,"shipmentId")?;
            let origin=required_str(payload,"origin")?;
            if !["FACTORY","STORE"].contains(&origin) {
                return Err("실제 운임은 0 이상의 원 단위 정수로 입력하세요.".into());
            }
            let value=req(payload,"value")?;
            if !value.is_null() && safe(value).is_none() {
                return Err("실제 운임은 0 이상의 원 단위 정수로 입력하세요.".into());
            }
            let (si,oi,ri)=shipment_indices(&state,ship_id)?;
            if !row_origins(&state["orders"][oi]["recipients"][ri]).contains(&origin) {
                return Err("실제 출고지와 배송 건을 확인하세요.".into());
            }
            let ship=&state["workflow"]["shipments"][si];
            let group_id=str_field(ship,"groupId").to_string();
            let before=if ship.get("actualFreight").and_then(|v|v.get(origin)).is_some() {
                field(field(ship,"actualFreight"),origin).clone()
            } else {
                field(&state["orders"][oi]["recipients"][ri],"actualFreight").clone()
            };
            if before==*value {return Ok(json!({"state":state,"unchanged":true}));}
            if !state["workflow"]["shipments"][si]["actualFreight"].is_object() {
                set(&mut state["workflow"]["shipments"][si],"actualFreight",json!({}))?;
            }
            set(&mut state["workflow"]["shipments"][si]["actualFreight"],origin,value.clone())?;
            append_event(&mut state,payload,"실제 출고 운임 입력",&[ship_id.to_string()],
                before,json!({"origin":origin,"amount":value}),&group_id)?;
            Ok(json!({"state":state,"unchanged":false}))
        }
        "confirm_group_payment" => {
            let group_id=required_str(payload,"groupId")?;
            let (gi,ships)=group_indices(&state,group_id)?;
            let first_id=str_field(&state["workflow"]["shipments"][ships[0]],"id");
            let (_si,oi,_ri)=shipment_indices(&state,first_id)?;
            let client=party(&state,&state["orders"][oi])
                .ok_or("거래처 정보를 확인하세요.")?.clone();
            if str_field(&client,"payment")=="POSTPAID" {
                let mut request=payload.clone();
                set(&mut request,"action",json!("advance_group"))?;
                return apply(&request);
            }
            if ships.iter().all(|i|field(&state["workflow"]["shipments"][*i],"step").as_i64()==Some(4)) {
                return Ok(json!({"state":state,"unchanged":true}));
            }
            if group_step(&state,group_id)?!=3 ||
                flag(&state["workflow"]["groups"][gi],"needsNotice") {
                return Err("계좌 안내를 먼저 완료하세요.".into());
            }
            let issues=stage_issues(&state,group_id,3)?;
            if !issues.is_empty(){return Err(issues.join("\n"));}
            let group=&state["workflow"]["groups"][gi];
            let notice=rows(field(group,"notices")).last()
                .ok_or("확정 청구액과 안내 계좌가 필요합니다.")?;
            let total=ships.iter().map(|i|{
                let sid=str_field(&state["workflow"]["shipments"][*i],"id");
                shipment_totals(&state,sid).ok()
                    .and_then(|t|safe(field(&t,"total")))
            }).collect::<Option<Vec<i64>>>()
              .and_then(checked_sum).ok_or("확정 청구액과 안내 계좌가 필요합니다.")?;
            let shipment_ids=ships.iter().map(|i|
                str_field(&state["workflow"]["shipments"][*i],"id").to_string()).collect::<Vec<_>>();
            for confirmation in rows(field(&state["workflow"],"confirmations")) {
                if str_field(confirmation,"groupId")==group_id &&
                    rows(field(confirmation,"shipmentIds")).iter().any(|sid|
                        shipment_ids.iter().any(|id|sid.as_str()==Some(id.as_str()))) {
                    return Err("이미 입금 확인한 묶음입니다.".into());
                }
            }
            let mut allocations=Vec::new();
            for si in &ships {
                let ship=&state["workflow"]["shipments"][*si];
                let (_x,oi,_r)=shipment_indices(&state,str_field(ship,"id"))?;
                let order=&state["orders"][oi];
                let payer=party(&state,order).ok_or("거래처 정보를 확인하세요.")?;
                let due=payment_due(&state,ship,order,payer)?
                    .ok_or("입금액 확인 필요")?;
                allocations.push(json!({"shipmentId":field(ship,"id"),"amount":due}));
            }
            let confirmation_id=required_str(payload,"confirmationId")?;
            if find_by_id(field(&state["workflow"],"confirmations"),confirmation_id).is_some() {
                return Err("입금 확인 기록 중복".into());
            }
            let confirmation=json!({
                "id":confirmation_id,"groupId":group_id,
                "dealerId":field(group,"dealerId"),"shipmentIds":shipment_ids,
                "amount":total,"confirmedAt":required_str(payload,"now")?,
                "actor":if str_field(payload,"actor").is_empty() {"직원(이름 미설정)"}
                    else {str_field(payload,"actor")},
                "announcedAccount":field(notice,"account"),
                "amounts":field(notice,"amounts"),"allocations":allocations
            });
            if !state["workflow"]["confirmations"].is_array() {
                set(&mut state["workflow"],"confirmations",json!([]))?;
            }
            state["workflow"]["confirmations"].as_array_mut()
                .ok_or("입금 확인 기록 형식 오류")?.push(confirmation);
            let mut request=payload.clone();
            set(&mut request,"action",json!("advance_group"))?;
            set(&mut request,"state",state)?;
            apply(&request)
        }
        "record_payment" => {
            let group_id=required_str(payload,"groupId")?;
            let (gi,_ships)=group_indices(&state,group_id)?;
            let group=&state["workflow"]["groups"][gi];
            let first=rows(field(&state["workflow"],"shipments")).iter()
                .find(|s|str_field(s,"groupId")==group_id)
                .ok_or("묶음의 배송 건이 없습니다.")?;
            let (_si,oi,_ri)=shipment_indices(&state,str_field(first,"id"))?;
            let order=&state["orders"][oi];
            let client=party(&state,order).ok_or("거래처 정보를 확인하세요.")?;
            let account=account_for(&state,group,order,client)
                .ok_or("실제 입금액과 입금 계좌를 확인하세요.")?.clone();
            if ["number","bank","holder"].iter().any(|key|str_field(&account,key).trim().is_empty()) {
                return Err("실제 입금액과 입금 계좌를 확인하세요.".into());
            }
            let paid=safe(req(payload,"paidAmount")?)
                .filter(|v|*v>0).ok_or("실제 입금액과 입금 계좌를 확인하세요.")?;
            let paid_at=required_str(payload,"paidAt")?;
            if paid_at.len()<10 || !(paid_at.contains('T') || paid_at.contains(' ')) {
                return Err("실제 입금 일시를 입력하세요.".into());
            }
            let allocations=rows(req(payload,"allocations")?);
            let ids=rows(req(payload,"allocationIds")?);
            if ids.len()!=allocations.len() {
                return Err("입금 배분 ID 수를 확인하세요.".into());
            }
            let mut seen=std::collections::HashSet::new();
            let mut total=Vec::new();
            let mut result_allocations=Vec::new();
            let mut shipment_ids=Vec::new();
            for (idx,a) in allocations.iter().enumerate() {
                let shipment_id=str_field(a,"shipmentId");
                if !seen.insert(shipment_id) {return Err("배분 대상이 중복됩니다.".into());}
                let value=safe(field(a,"amount")).ok_or("입금 배분을 확인하세요.")?;
                let (_s,order_idx,_r)=shipment_indices(&state,shipment_id)?;
                let target_order=&state["orders"][order_idx];
                let target_ship=find_by_id(field(&state["workflow"],"shipments"),shipment_id)
                    .ok_or("입금 배분을 확인하세요.")?;
                let target_group=find_by_id(field(&state["workflow"],"groups"),
                    str_field(target_ship,"groupId")).ok_or("입금 배분을 확인하세요.")?;
                let target_client=party(&state,target_order).ok_or("입금 배분을 확인하세요.")?;
                let target_account=account_for(&state,target_group,target_order,target_client);
                let key=|acct:&Value|json!([field(acct,"id"),
                    str_field(acct,"bank").trim(),str_field(acct,"number").trim(),
                    str_field(acct,"holder").trim()]);
                if str_field(target_order,"clientId")!=str_field(group,"dealerId") ||
                    !target_account.is_some_and(|a|key(a)==key(&account)) {
                    return Err("다른 거래처 / 계좌의 배송 건에 배분할 수 없습니다.".into());
                }
                total.push(value);
                shipment_ids.push(shipment_id.to_string());
                if value>0 {
                    let id=ids[idx].as_str().filter(|s|!s.trim().is_empty())
                        .ok_or("입금 배분 ID 누락")?;
                    result_allocations.push(json!({"id":id,"shipmentId":shipment_id,"amount":value}));
                }
            }
            if checked_sum(total).is_none_or(|sum|sum>paid) {
                return Err("배분액이 실제 입금액을 초과합니다.".into());
            }
            let payment_id=required_str(payload,"paymentId")?;
            if find_by_id(field(&state["workflow"],"payments"),payment_id).is_some() {
                return Err("입금 기록 ID가 중복됩니다.".into());
            }
            let payment=json!({"id":payment_id,"dealerId":field(group,"dealerId"),
                "account":account,"amount":paid,"paidAt":paid_at,
                "recordedAt":required_str(payload,"now")?,
                "actor":if str_field(payload,"actor").is_empty() {"직원(이름 미설정)"}
                    else {str_field(payload,"actor")},
                "memo":str_field(payload,"memo"),"allocations":result_allocations});
            state["workflow"]["payments"].as_array_mut()
                .ok_or("입금 기록 목록 형식 오류")?.push(payment.clone());
            append_event(&mut state,payload,"실제 입금 기록",&shipment_ids,
                Value::Null,payment,group_id)?;
            Ok(json!({"state":state,"paymentId":payment_id}))
        }
        "restore_shipment" => {
            let id=required_str(payload,"shipmentId")?;
            let (si,_oi,_ri)=shipment_indices(&state,id)?;
            if !flag(&state["workflow"]["shipments"][si],"transferred") {
                return Err("이관된 배송 건을 선택하세요.".into());
            }
            let group_id=str_field(&state["workflow"]["shipments"][si],"groupId").to_string();
            let affected=rows(field(&state["workflow"],"queue")).iter().enumerate()
                .filter(|(_,q)|str_field(q,"shipmentId")==id &&
                    str_field(q,"status")!="CANCELLED")
                .map(|(index,q)|(index,str_field(q,"status").to_string()))
                .collect::<Vec<_>>();
            if affected.iter().any(|(_,status)|status!="QUEUED") {
                return Err("이미 공장 전달 / 매장 발송한 건입니다. 변경 요청을 기록하세요.".into());
            }
            for (i,_) in affected {set(&mut state["workflow"]["queue"][i],"status",json!("CANCELLED"))?;}
            set(&mut state["workflow"]["shipments"][si],"transferred",json!(false))?;
            append_event(&mut state,payload,"엑셀 이관 복구",&[id.to_string()],
                Value::Null,Value::Null,&group_id)?;
            Ok(json!({"state":state,"restored":true}))
        }
        "mark_store_sent" => {
            let queue_id=required_str(payload,"queueId")?;
            let qi=index_by_id(field(&state["workflow"],"queue"),queue_id)
                .ok_or("매장 발송 대기 건을 선택하세요.")?;
            let q=&state["workflow"]["queue"][qi];
            let status=str_field(q,"status");
            if str_field(q,"origin")!="STORE" || !["QUEUED","EXPORTED"].contains(&status) {
                return Err("매장 발송 대기 건을 선택하세요.".into());
            }
            if status=="EXPORTED" {
                let export=find_by_id(field(&state,"exports"),str_field(q,"exportId"));
                if !export.is_some_and(|e|rows(field(e,"queueEntryIds")).iter().any(|x|
                    x.as_str()==Some(queue_id))) {
                    return Err("해당 매장 Excel 출력 이력을 확인할 수 없습니다.".into());
                }
            }
            let shipment_id=str_field(q,"shipmentId").to_string();
            set(&mut state["workflow"]["queue"][qi],"status",json!("STORE_SENT"))?;
            set(&mut state["workflow"]["queue"][qi],"fileOnly",json!(false))?;
            if !has_value(field(&state["workflow"]["queue"][qi],"exportedAt")) {
                set(&mut state["workflow"]["queue"][qi],"exportedAt",
                    json!(required_str(payload,"now")?))?;
            }
            let group_id=find_by_id(field(&state["workflow"],"shipments"),&shipment_id)
                .map(|s|str_field(s,"groupId")).unwrap_or("").to_string();
            append_event(&mut state,payload,"매장 발송 확인",&[shipment_id],
                Value::Null,Value::Null,&group_id)?;
            Ok(json!({"state":state,"status":"STORE_SENT"}))
        }
        "record_change_request" => {
            let ship_id=required_str(payload,"shipmentId")?;
            let reason=required_str(payload,"text")?.trim();
            if reason.is_empty(){return Err("배송 건과 변경 요청 내용을 확인하세요.".into());}
            if !rows(field(&state["workflow"],"shipments")).iter()
                .any(|ship|str_field(ship,"id")==ship_id) {
                return Err("배송 건과 변경 요청 내용을 확인하세요.".into());
            }
            let (si,_oi,_ri)=shipment_indices(&state,ship_id)?;
            let group_id=str_field(&state["workflow"]["shipments"][si],"groupId").to_string();
            let request_id=required_str(payload,"changeRequestId")?;
            if find_by_id(field(&state["workflow"],"changeRequests"),request_id).is_some(){
                return Err("변경 요청 ID가 중복됩니다.".into());
            }
            let actor=if str_field(payload,"actor").is_empty() {"직원(이름 미설정)"}
                else {str_field(payload,"actor")};
            let entry=json!({"id":request_id,"shipmentId":ship_id,"text":reason,
                "actor":actor,"at":required_str(payload,"now")?});
            state["workflow"]["changeRequests"].as_array_mut()
                .ok_or("변경 요청 이력 목록 오류")?.push(entry);
            append_event(&mut state,payload,"전달 후 변경 요청 기록",&[ship_id.to_string()],
                Value::Null,json!(reason),&group_id)?;
            Ok(json!({"state":state,"changeRequestId":request_id}))
        }
        "set_group_account" => {
            let group_id=required_str(payload,"groupId")?;
            let (gi,ships)=group_indices(&state,group_id)?;
            if ships.iter().any(|si|flag(&state["workflow"]["shipments"][*si],"transferred")) {
                return Err("이관한 묶음의 계좌는 변경할 수 없습니다.".into());
            }
            let account_id=payload.get("accountId").and_then(Value::as_str);
            if account_id.is_some_and(|id|find_by_id(field(field(&state,"settings"),"accounts"),id)
                .is_none()) {
                return Err("등록된 계좌를 선택하세요.".into());
            }
            let mode=if account_id.is_some() {"MANUAL"} else {"AUTO"};
            let group_account=json!({"mode":mode,"id":account_id});
            let first_id=str_field(&state["workflow"]["shipments"][ships[0]],"id").to_string();
            let (_,oi,_ri)=shipment_indices(&state,&first_id)?;
            set(&mut state["workflow"]["groups"][gi],"accountMode",json!(mode))?;
            set(&mut state["workflow"]["groups"][gi],"accountId",json!(account_id))?;
            if !state["orders"][oi]["groupAccounts"].is_object() {
                set(&mut state["orders"][oi],"groupAccounts",json!({}))?;
            }
            set(&mut state["orders"][oi]["groupAccounts"],group_id,group_account)?;
            let now=required_str(payload,"now")?.to_string();
            let seed=required_str(payload,"eventId")?;
            let audit_ids=rows(field(payload,"auditEventIds"));
            let mut audit_cursor=0usize;
            for si in &ships {
                let old_step=field(&state["workflow"]["shipments"][*si],"step").as_i64().unwrap_or(0);
                if old_step < 3 {continue;}
                let ship_id=str_field(&state["workflow"]["shipments"][*si],"id").to_string();
                let active_confirms=rows(field(&state["workflow"],"confirmations")).iter()
                    .filter(|c| {
                        rows(field(c,"shipmentIds")).iter().any(|sid|sid.as_str()==Some(&ship_id)) &&
                        !rows(field(&state["workflow"],"events")).iter().any(|e|
                            str_field(e,"action")=="입금 승인 재확인 필요" &&
                            field(e,"before")==field(c,"id") &&
                            rows(field(e,"shipmentIds")).iter().any(|sid|sid.as_str()==Some(&ship_id)))
                    })
                    .map(|c|str_field(c,"id").to_string())
                    .collect::<Vec<_>>();
                set(&mut state["workflow"]["shipments"][*si],"step",json!(2))?;
                set(&mut state["workflow"]["shipments"][*si],"legacyApproval",json!(false))?;
                set(&mut state["workflow"]["groups"][gi],"needsNotice",json!(true))?;
                if !state["workflow"]["shipments"][*si]["rechecks"].is_array() {
                    set(&mut state["workflow"]["shipments"][*si],"rechecks",json!([]))?;
                }
                state["workflow"]["shipments"][*si]["rechecks"].as_array_mut()
                    .ok_or("재검증 이력 오류")?.push(json!({
                        "at":now,"reason":"입금 계좌 변경","fromStage":old_step,"toStage":2
                    }));
                for confirmation_id in active_confirms {
                    let fallback=format!("{seed}:reconfirm:{ship_id}:{confirmation_id}");
                    let id=audit_ids.get(audit_cursor).and_then(Value::as_str)
                        .unwrap_or(fallback.as_str());
                    audit_cursor+=1;
                    append_extra_event(&mut state,payload,id,
                        "입금 승인 재확인 필요",&[ship_id.clone()],group_id,
                        json!(confirmation_id),Value::Null,"시스템","입금 계좌 변경")?;
                }
                let fallback=format!("{seed}:recheck:{ship_id}");
                let id=audit_ids.get(audit_cursor).and_then(Value::as_str)
                    .unwrap_or(fallback.as_str());
                audit_cursor+=1;
                append_extra_event(&mut state,payload,id,"재검증 필요",&[ship_id],
                    group_id,json!(old_step),json!(2),"시스템","입금 계좌 변경")?;
            }
            let all_ids=ships.iter().map(|i|str_field(&state["workflow"]["shipments"][*i],"id")
                .to_string()).collect::<Vec<_>>();
            append_event(&mut state,payload,"묶음 입금 계좌 변경",&all_ids,
                Value::Null,json!(account_id.unwrap_or("AUTO")),group_id)?;
            Ok(json!({"state":state,"accountMode":mode,"accountId":account_id}))
        }
        "detach_shipment" => {
            // Parity target: workflow.ts::detachShipment. IDs and clock are
            // injected by the host to keep this module deterministic.
            let id=required_str(payload,"shipmentId")?;
            let (si,oi,_ri)=shipment_indices(&state,id)?;
            if flag(&state["workflow"]["shipments"][si],"transferred") {
                return Err("현재 관리 중인 배송 건을 선택하세요.".into());
            }
            let old_group_id=str_field(&state["workflow"]["shipments"][si],"groupId").to_string();
            let (gi,ships)=group_indices(&state,&old_group_id)?;
            if ships.len()<2 {return Err("이미 독립 관리 중입니다.".into());}
            let new_group_id=required_str(payload,"newGroupId")?;
            if new_group_id.trim().is_empty() ||
                find_by_id(field(&state["workflow"],"groups"),new_group_id).is_some() {
                return Err("새로운 묶음 ID를 확인하세요.".into());
            }
            let old_group=state["workflow"]["groups"][gi].clone();
            let order=state["orders"][oi].clone();
            let client=party(&state,&order).ok_or("거래처 정보를 확인하세요.")?;
            let account=account_for(&state,&old_group,&order,client).cloned();
            let had_notices=!rows(field(&old_group,"notices")).is_empty();
            let any_advanced=ships.iter().any(|i|
                field(&state["workflow"]["shipments"][*i],"step").as_i64().unwrap_or(0)>=3);
            let mut separated=old_group.clone();
            set(&mut separated,"id",json!(new_group_id))?;
            set(&mut separated,"createdAt",json!(required_str(payload,"now")?))?;
            set(&mut separated,"notices",json!([]))?;
            set(&mut separated,"needsNotice",json!(had_notices ||
                field(&state["workflow"]["shipments"][si],"step").as_i64().unwrap_or(0)>=3))?;
            if let Some(ref account)=account {
                set(&mut separated,"accountMode",json!("MANUAL"))?;
                set(&mut separated,"accountId",field(account,"id").clone())?;
            }
            state["workflow"]["groups"].as_array_mut()
                .ok_or("주문 묶음 목록 누락")?.push(separated);
            set(&mut state["workflow"]["shipments"][si],"groupId",json!(new_group_id))?;
            if had_notices || any_advanced {
                set(&mut state["workflow"]["groups"][gi],"needsNotice",json!(true))?;
                if let Some(ref account)=account {
                    set(&mut state["workflow"]["groups"][gi],"accountMode",json!("MANUAL"))?;
                    set(&mut state["workflow"]["groups"][gi],"accountId",field(account,"id").clone())?;
                }
            }
            append_event(&mut state,payload,"묶음 해제",&[id.to_string()],
                json!(old_group_id),json!(new_group_id),new_group_id)?;
            Ok(json!({"state":state,"groupId":new_group_id}))
        }
        "regroup_shipment" => {
            // Parity target: workflow.ts::regroupShipment.
            let id=required_str(payload,"shipmentId")?;
            let target_id=required_str(payload,"targetGroupId")?;
            let (si,oi,_ri)=shipment_indices(&state,id)?;
            if flag(&state["workflow"]["shipments"][si],"transferred") {
                return Err("엑셀 이관 배송 건은 일반 다시 묶기에서 제외됩니다.".into());
            }
            let old_id=str_field(&state["workflow"]["shipments"][si],"groupId").to_string();
            let (old_gi,_old_ships)=group_indices(&state,&old_id)?;
            let (target_gi,target_ships)=group_indices(&state,target_id)?;
            if old_id==target_id {return Err("이미 같은 묶음입니다.".into());}
            let old_group=state["workflow"]["groups"][old_gi].clone();
            let target_group=state["workflow"]["groups"][target_gi].clone();
            if field(&old_group,"sourceId")!=field(&target_group,"sourceId") ||
                field(&old_group,"dealerId")!=field(&target_group,"dealerId") {
                return Err("같은 최초 발주서 / 거래처의 배송 건만 다시 묶을 수 있습니다.".into());
            }
            let step=field(&state["workflow"]["shipments"][si],"step");
            if target_ships.iter().any(|i|flag(&state["workflow"]["shipments"][*i],"transferred") ||
                field(&state["workflow"]["shipments"][*i],"step")!=step) {
                return Err("진행 단계가 같고 이관되지 않은 배송 건만 다시 묶을 수 있습니다.".into());
            }
            let order=&state["orders"][oi];
            let client=party(&state,order).ok_or("거래처 정보를 확인하세요.")?;
            let key=|account:Option<&Value>|->Value {
                if let Some(a)=account {
                    json!([field(a,"id"),str_field(a,"bank").trim(),
                        str_field(a,"number").trim(),str_field(a,"holder").trim()])
                } else {Value::Null}
            };
            let old_account=account_for(&state,&old_group,order,client);
            let target_account=account_for(&state,&target_group,order,client);
            if key(old_account)!=key(target_account) {
                return Err("입금 계좌가 다른 묶음은 합칠 수 없습니다.".into());
            }
            let affected_ids=std::iter::once(id.to_string()).chain(
                target_ships.iter().map(|i|
                    str_field(&state["workflow"]["shipments"][*i],"id").to_string())
            ).collect::<Vec<_>>();
            let payments_affected=rows(field(&state["workflow"],"payments")).iter()
                .any(|p|rows(field(p,"allocations")).iter().any(|a|
                    affected_ids.iter().any(|sid|sid==str_field(a,"shipmentId"))));
            let warned=step.as_i64().unwrap_or(0)>=3 ||
                !rows(field(&old_group,"notices")).is_empty() ||
                !rows(field(&target_group,"notices")).is_empty() ||
                payments_affected;
            if warned && !flag(payload,"ack") {
                return Err("기존 안내 금액과 입금 배분을 확인한 뒤 다시 묶기를 승인하세요.".into());
            }
            set(&mut state["workflow"]["shipments"][si],"groupId",json!(target_id))?;
            if warned {
                set(&mut state["workflow"]["groups"][old_gi],"needsNotice",json!(true))?;
                set(&mut state["workflow"]["groups"][target_gi],"needsNotice",json!(true))?;
            }
            let actor=if str_field(payload,"actor").trim().is_empty() {
                "직원(이름 미설정)"
            } else {str_field(payload,"actor")};
            let event_id=required_str(payload,"eventId")?.to_string();
            append_extra_event(&mut state,payload,&event_id,"다시 묶기",
                &[id.to_string()],target_id,json!(old_id),json!(target_id),
                actor,"배송 ID / 단계 / 입금 배분 유지")?;
            Ok(json!({"state":state,"groupId":target_id}))
        }
        "complete_delivery" => {
            let shipment_id=required_str(payload,"shipmentId")?;
            let (si,oi,ri)=shipment_indices(&state,shipment_id)?;
            if !flag(&state["workflow"]["shipments"][si],"transferred") {
                return Err("발송 처리한 배송 건을 선택하세요.".into());
            }
            if has_value(field(&state["workflow"]["shipments"][si],"delivery")) {
                return Ok(json!({"state":state,"unchanged":true}));
            }
            let order=state["orders"][oi].clone();
            let recipient=state["orders"][oi]["recipients"][ri].clone();
            let ship=state["workflow"]["shipments"][si].clone();
            let origins=row_origins(&recipient);
            for q in rows(field(&state["workflow"],"queue"))
                .iter().filter(|q|str_field(q,"shipmentId")==shipment_id) {
                if str_field(q,"status")=="EXPORTED" && flag(q,"fileOnly") {
                    return Err("실제 공장 전달 확인 후 배송 완료를 처리하세요.".into());
                }
                if str_field(q,"status")=="QUEUED" {
                    return Err("공장 전달 또는 매장 발송 확인 후 배송 완료를 기록하세요.".into());
                }
            }
            let actual=req(payload,"actual")?;
            for origin in &origins {
                if safe(field(actual,origin)).is_none() {
                    return Err("출고지별 실제 택배 운임을 확인하세요.".into());
                }
            }
            if !has_value(field(&state,"shipping")) {
                return Err("배송 완료에 적용할 운임표가 없습니다.".into());
            }
            let mut order_single=order.clone();
            set(&mut order_single,"recipients",json!([recipient]))?;
            let reco=super::shipping::recommend(&order_single,&state)?;
            let bundles=rows(field(&reco,"bundles")).to_vec();
            let combo_ids=rows(req(payload,"combinationIds")?);
            let delivery_ids=rows(req(payload,"deliveryIds")?);
            if bundles.len()!=combo_ids.len() || bundles.len()!=delivery_ids.len() {
                return Err("출고지별 운임 확인 기록 ID가 누락되었습니다.".into());
            }
            let now=required_str(payload,"now")?.to_string();
            let actor=if str_field(payload,"actor").is_empty() {"직원(이름 미설정)"}
                else {str_field(payload,"actor")}.to_string();
            let group_id=str_field(&ship,"groupId").to_string();
            let mut record_ids=Vec::new();
            let mut versions=serde_json::Map::new();
            let confirmed_version=if has_value(field(&ship,"confirmedFreightVersion")) {
                field(&ship,"confirmedFreightVersion").clone()
            } else {field(&reco,"version").clone()};
            for (index,bundle) in bundles.iter().enumerate() {
                let origin=str_field(bundle,"origin");
                let amount=safe(field(actual,origin))
                    .ok_or("출고지별 실제 택배 운임을 확인하세요.")?;
                let charged=if shipment_freight_code(&order,&order_single["recipients"][0])=="020" {
                    0
                } else {
                    safe(field(field(&ship,"charges"),origin))
                        .ok_or("청구 운임 확인 필요")?
                };
                let applied=if has_value(field(&ship,"latestRecipient")) {None}
                    else {rows(field(&ship,"appliedBundles")).iter()
                        .find(|b|str_field(b,"origin")==origin)};
                let key=applied.map(|v|field(v,"key")).unwrap_or_else(||field(bundle,"key")).clone();
                let basis_versions=applied.map(|v|field(v,"versions"))
                    .unwrap_or_else(||field(bundle,"versions")).clone();
                if let Some(map)=basis_versions.as_object() {
                    for (key,v) in map {versions.insert(key.clone(),v.clone());}
                }
                let combo_id=combo_ids[index].as_str().filter(|v|!v.is_empty())
                    .ok_or("운임 조합 ID 누락")?.to_string();
                let delivery_id=delivery_ids[index].as_str().filter(|v|!v.is_empty())
                    .ok_or("배송 증빙 ID 누락")?.to_string();
                if find_by_id(field(field(&state,"shipping"),"combinations"),&combo_id).is_some()
                    || find_by_id(field(field(&state,"workflow"),"deliveries"),&delivery_id).is_some() {
                    return Err("운임 및 배송 증빙 ID가 중복됩니다.".into());
                }
                if rows(field(field(&state,"workflow"),"deliveries")).iter().any(|d|
                    str_field(d,"shipmentId")==shipment_id && str_field(d,"origin")==origin) {
                    return Err("같은 배송 건 / 출고지의 배송 완료 기록이 중복됩니다.".into());
                }
                for previous in state["shipping"]["combinations"].as_array_mut()
                    .ok_or("운임 조합 목록 오류")? {
                    if field(previous,"key")==&key && flag(previous,"active") {
                        set(previous,"active",json!(false))?;
                    }
                }
                let epoch=field(&ship,"appliedEpoch").as_i64()
                    .unwrap_or_else(||field(field(&state,"shipping"),"epoch").as_i64().unwrap_or(1));
                let active=epoch==field(field(&state,"shipping"),"epoch").as_i64().unwrap_or(1)
                    && basis_versions==*field(bundle,"versions");
                let count=rows(field(&state["workflow"],"deliveries")).iter().filter(|d|{
                    let prior_combo=find_by_id(field(&state["shipping"],"combinations"),
                        str_field(d,"combinationId"));
                    prior_combo.is_some_and(|c|field(c,"key")==&key) &&
                        field(d,"version")==&confirmed_version
                }).count()+1;
                let combination=json!({"id":combo_id,"key":key,"epoch":epoch,
                    "versions":basis_versions,"charge":amount,"actual":amount,
                    "observedCharge":charged,"shipmentId":shipment_id,
                    "verifiedAt":now,"at":now,"active":active,
                    "sampleCount":count,"description":field(bundle,"description")});
                state["shipping"]["combinations"].as_array_mut()
                    .ok_or("운임 조합 목록 오류")?.push(combination);
                let items=rows(field(bundle,"items")).iter().map(|item|{
                    let pid=str_field(item,"productId");
                    let product=find_by_id(field(&state,"products"),pid);
                    json!({"productId":field(item,"productId"),
                        "variantId":field(item,"variantId"),"quantity":field(item,"quantity"),
                        "shippingGroupId":product.and_then(|p|p.get("shippingGroupId"))})
                }).collect::<Vec<_>>();
                let record=json!({"id":delivery_id,"shipmentId":shipment_id,
                    "recipientId":field(&ship,"recipientId"),
                    "origin":origin,"at":now,"actor":actor,"items":items,
                    "bundles":null,"charge":charged,"actual":amount,
                    "version":confirmed_version,"combinationId":combo_id});
                state["workflow"]["deliveries"].as_array_mut()
                    .ok_or("배송 증빙 목록 오류")?.push(record);
                record_ids.push(combo_id);
            }
            let delivery=json!({"at":now,"actor":actor,"actual":actual,
                "versions":Value::Object(versions),"recordIds":record_ids});
            set(&mut state["workflow"]["shipments"][si],"delivery",delivery.clone())?;
            append_event(&mut state,payload,"실제 배송 완료 / 운임 검증",
                &[shipment_id.to_string()],Value::Null,delivery,&group_id)?;
            Ok(json!({"state":state,"completed":true}))
        }
        _ => Err(format!("지원하지 않는 업무 action: {action}")),
    }
}
