//! Preservation constraints from validateWorkflow / validateReceptionBoundary.
//! Invalid state is rejected without producing any partial mutation.
use std::collections::HashSet;
use serde_json::Value;
use super::{checked_sum, field, find_by_id, flag, has_value, rows, safe, str_field};

fn unique_id(values: &Value) -> bool {
    let mut seen = HashSet::new();
    rows(values).iter().all(|v| seen.insert(str_field(v, "id").to_string()))
}
fn array_has(values: &Value, id: &str) -> bool { find_by_id(values,id).is_some() }
fn unchanged_records(old: &Value, new: &Value) -> bool {
    rows(old).iter().all(|v| {
        find_by_id(new,str_field(v,"id")) == Some(v)
    })
}
fn shipment_for<'a>(state: &'a Value, ship: &Value) -> Result<(&'a Value,&'a Value),String> {
    let order = find_by_id(field(state,"orders"),str_field(ship,"orderId"))
        .ok_or_else(|| "배송 건의 발주서 / 수취인 / 거래처 연결을 확인하세요.".to_string())?;
    let row = find_by_id(field(order,"recipients"),str_field(ship,"recipientId"))
        .ok_or_else(|| "배송 건의 발주서 / 수취인 / 거래처 연결을 확인하세요.".to_string())?;
    Ok((order,row))
}
pub(super) fn validate(state: &Value, before: Option<&Value>) -> Result<(),String> {
    let w = field(state,"workflow");
    if w.is_null() { return Ok(()) }
    for name in ["sources","groups","shipments","payments","queue","events","deliveries","changeRequests"] {
        if !unique_id(field(w,name)) { return Err("업무 기록 ID가 중복됩니다.".into()); }
    }
    for s in rows(field(w,"shipments")) {
        if flag(s,"legacyArchived") && shipment_for(state,s).is_err() {continue;}
        let (order,_recipient) = shipment_for(state,s)?;
        let group = find_by_id(field(w,"groups"),str_field(s,"groupId"));
        let step = field(s,"step").as_i64();
        if str_field(order,"orderType") == "RETAIL" {
            let has_payment = rows(field(w,"payments")).iter().any(|p|
                rows(field(p,"allocations")).iter().any(|a| str_field(a,"shipmentId")==str_field(s,"id")));
            let has_confirmation = rows(field(w,"confirmations")).iter().any(|c|
                rows(field(c,"shipmentIds")).iter().any(|v|v.as_str()==Some(str_field(s,"id"))));
            if !flag(s,"transferred") || step != Some(4)
                || group.is_some_and(|g|!rows(field(g,"notices")).is_empty())
                || has_payment || has_confirmation {
                return Err("소매 주문에는 입금 / 계좌 안내 단계를 만들 수 없습니다.".into());
            }
        }
        let source = find_by_id(field(w,"sources"),str_field(s,"sourceId"));
        let valid_link = match (group,source) {
            (Some(g),Some(src)) => str_field(src,"orderId") == str_field(order,"id")
                && str_field(g,"sourceId") == str_field(src,"id")
                && str_field(g,"dealerId") == str_field(order,"clientId"),
            _ => false
        };
        if !valid_link {return Err("발주서 / 묶음 / 배송 건 연결 오류".into());}
        if step.is_none_or(|n| !(0..=4).contains(&n)) {
            return Err("잘못된 진행 단계".into());
        }
        for v in field(s,"actualFreight").as_object().into_iter().flat_map(|m|m.values()) {
            if !v.is_null() && safe(v).is_none() {return Err("실제 출고 운임 금액 오류".into());}
        }
        for v in field(s,"charges").as_object().into_iter().flat_map(|m|m.values()) {
            if !v.is_null() && safe(v).is_none() {return Err("운임 금액 오류".into());}
        }
    }
    for p in rows(field(w,"payments")) {
        // TypeScript evaluates amount(payment.amount) first, then sum()
        // before checking individual allocation validity. sum() accepts
        // negative/decimal number inputs to the arithmetic step, but throws
        // an independent "금액 합계를 확인하세요." when its result is not a
        // nonnegative safe integer.
        let Some(payment_amount)=safe(field(p,"amount")) else {
            return Err("입금액 / 배분액 오류".into());
        };
        let mut total=0_f64;
        for allocation in rows(field(p,"allocations")) {
            let value=field(allocation,"amount");
            let amount=match value {
                Value::Number(n)=>n.as_f64().unwrap_or(f64::NAN),
                Value::Null=>0.0,
                Value::Bool(v)=>if *v{1.0}else{0.0},
                _=>f64::NAN
            };
            total+=amount;
        }
        if !total.is_finite() || total<0.0 || total.fract()!=0.0 ||
            total > super::MAX_SAFE as f64 {
            return Err("금액 합계를 확인하세요.".into());
        }
        if total>payment_amount as f64 {
            return Err("입금액 / 배분액 오류".into());
        }
        for allocation in rows(field(p,"allocations")) {
            let shipment = find_by_id(field(w,"shipments"),str_field(allocation,"shipmentId"));
            if safe(field(allocation,"amount")).is_none() ||
                !shipment.is_some_and(|s|shipment_for(state,s)
                    .is_ok_and(|(order,_)|str_field(order,"clientId")==str_field(p,"dealerId"))) {
                return Err("입금 배분 연결 오류".into());
            }
        }
    }
    for q in rows(field(w,"queue")) {
        if !array_has(field(w,"shipments"),str_field(q,"shipmentId")) {
            return Err("엑셀 관리 배송 연결 오류".into());
        }
    }
    let mut delivered = HashSet::new();
    for d in rows(field(w,"deliveries")) {
        let key = format!("{}|{}",str_field(d,"shipmentId"),str_field(d,"origin"));
        if !delivered.insert(key) {
            return Err("같은 배송 건 / 출고지의 배송 완료 기록이 중복됩니다.".into());
        }
    }
    for c in rows(field(w,"confirmations")) {
        if safe(field(c,"amount")).is_none() ||
           !array_has(field(w,"groups"),str_field(c,"groupId")) ||
           rows(field(c,"allocations")).iter().any(|a| safe(field(a,"amount")).is_none() ||
               !array_has(field(w,"shipments"),str_field(a,"shipmentId"))) {
            return Err("입금 확인 연결 / 금액 오류".into());
        }
    }
    if !unique_id(field(w,"confirmations")) {
        return Err("입금 확인 기록 중복".into());
    }
    if let Some(old_state) = before {
        let old_w = field(old_state,"workflow");
        if !old_w.is_null() {
            for old in rows(field(old_w,"confirmations")) {
                let current = find_by_id(field(w,"confirmations"),str_field(old,"id"));
                let old_ids=rows(field(old,"shipmentIds")).iter()
                    .filter_map(Value::as_str).collect::<Vec<_>>();
                if let Some(current)=current {
                    if current==old {continue;}
                    let current_ids=rows(field(current,"shipmentIds")).iter()
                        .filter_map(Value::as_str).collect::<Vec<_>>();
                    let removed=old_ids.iter().filter(|id|!current_ids.contains(id))
                        .copied().collect::<Vec<_>>();
                    let mut expected=old.clone();
                    let surviving=old_ids.iter().filter(|id|current_ids.contains(id))
                        .copied().collect::<Vec<_>>();
                    let allocations=rows(field(old,"allocations")).iter()
                        .filter(|a|surviving.contains(&str_field(a,"shipmentId")))
                        .cloned().collect::<Vec<_>>();
                    let mut amounts=serde_json::Map::new();
                    for id in &surviving {
                        let previous=field(field(old,"amounts"),id);
                        amounts.insert((*id).to_string(),if previous.is_null() {
                            serde_json::json!(0)
                        } else {previous.clone()});
                    }
                    let total=amounts.values().filter_map(safe).collect::<Vec<_>>();
                    let amount=checked_sum(total).ok_or("금액 합계를 확인하세요.")?;
                    super::set(&mut expected,"shipmentIds",serde_json::json!(surviving))?;
                    super::set(&mut expected,"allocations",serde_json::json!(allocations))?;
                    super::set(&mut expected,"amounts",Value::Object(amounts))?;
                    super::set(&mut expected,"amount",serde_json::json!(amount))?;
                    let allowed=!removed.is_empty() && current==&expected &&
                        removed.iter().all(|id|find_by_id(field(w,"shipments"),id)
                            .is_some_and(|s|!flag(s,"transferred") &&
                                field(s,"step").as_i64().unwrap_or(0)<4));
                    if !allowed {
                        return Err("확인 기록은 입금 확인 취소에서만 삭제할 수 있습니다.".into());
                    }
                } else {
                    let allowed=old_ids.iter().all(|id|
                        find_by_id(field(w,"shipments"),id)
                            .is_some_and(|s|!flag(s,"transferred") &&
                                field(s,"step").as_i64().unwrap_or(0)<4));
                    if !allowed {
                        return Err("이관 전 입금 확인 취소에서만 기록을 삭제할 수 있습니다.".into());
                    }
                }
            }            for old in rows(field(old_w,"shipments")) {
                let Some(current) = find_by_id(field(w,"shipments"),str_field(old,"id")) else {
                    return Err("배송 건 고유 ID와 최초 연결은 보존해야 합니다.".into());
                };
                for key in ["sourceId","orderId","recipientId"] {
                    if field(old,key) != field(current,key) {
                        return Err("배송 건 고유 ID와 최초 연결은 보존해야 합니다.".into());
                    }
                }
                for origin in ["STORE","FACTORY"] {
                    let old_actual=field(old,"actualFreight");
                    let current_actual=field(current,"actualFreight");
                    let old_freight = field(old_actual,origin);
                    let current_freight = field(current_actual,origin);
                    // TypeScript uses JSON.stringify(undefined) vs
                    // JSON.stringify(null): an omitted origin differs from
                    // one explicitly present with null. Treat presence as
                    // part of the immutable audit value.
                    if old_actual.get(origin).is_some()==current_actual.get(origin).is_some() &&
                        old_freight == current_freight {continue;}
                    let old_recipient=shipment_for(old_state,old)?.1;
                    let original_freight=if field(old,"actualFreight").get(origin).is_some() {
                        old_freight
                    } else {
                        field(old_recipient,"actualFreight")
                    };
                    let has_evidence = field(current,"actualFreight").get(origin).is_some() &&
                        rows(field(w,"events")).iter().any(|event| {
                            !array_has(field(old_w,"events"),str_field(event,"id")) &&
                            str_field(event,"action") == "실제 출고 운임 입력" &&
                            rows(field(event,"shipmentIds")).iter()
                                .any(|id|id.as_str()==Some(str_field(old,"id"))) &&
                            field(event,"before")==original_freight &&
                            str_field(field(event,"after"),"origin")==origin &&
                            field(field(event,"after"),"amount")==current_freight
                        });
                    if !has_evidence {
                        return Err("실제 출고 운임의 수정 근거를 확인하세요.".into());
                    }
                }
                if has_value(field(old,"delivery")) &&
                    field(old,"delivery") != field(current,"delivery") {
                    return Err("배송 완료 이력은 보존해야 합니다.".into());
                }
            }
            for old in rows(field(old_w,"groups")) {
                let current = find_by_id(field(w,"groups"),str_field(old,"id"));
                for notice in rows(field(old,"notices")) {
                    if current.and_then(|g|find_by_id(field(g,"notices"),str_field(notice,"id")))
                        != Some(notice) {
                        return Err("기존 계좌 안내 이력은 보존해야 합니다.".into());
                    }
                }
            }
            for name in ["payments","events","deliveries","sources","changeRequests"] {
                if !unchanged_records(field(old_w,name),field(w,name)) {
                    return Err("기존 입금 / 원문 / 배송 / 조작 이력은 변경하거나 삭제할 수 없습니다.".into());
                }
            }
            for old in rows(field(old_w,"queue")) {
                let current = find_by_id(field(w,"queue"),str_field(old,"id"))
                    .ok_or_else(||"엑셀 이관 연결과 확정 정보는 보존해야 합니다.".to_string())?;
                if field(old,"shipmentId") != field(current,"shipmentId") ||
                    field(old,"origin") != field(current,"origin") ||
                    (str_field(old,"status")!="CANCELLED" &&
                        field(old,"snapshot") != field(current,"snapshot")) {
                    return Err("엑셀 이관 연결과 확정 정보는 보존해야 합니다.".into());
                }
                if ["EXPORTED","STORE_SENT"].contains(&str_field(old,"status")) &&
                    current != old {
                    // Both exceptions are explicit in the original TypeScript:
                    // staff handoff confirmation and pre-delivery print disposal.
                    let old_file_only=flag(old,"fileOnly");
                    let old_delivered=has_value(field(old,"factoryDeliveredAt"));
                    let current_delivered=has_value(field(current,"factoryDeliveredAt"));
                    let mut metadata_view=current.clone();
                    if let Some(object)=metadata_view.as_object_mut() {
                        for key in ["fileOnly","factoryDeliveredAt"] {
                            if let Some(value)=old.get(key) {
                                object.insert(key.to_string(),value.clone());
                            } else {
                                object.remove(key);
                            }
                        }
                    }
                    let metadata_only=old_file_only && !flag(current,"fileOnly") &&
                        current_delivered && metadata_view==*old &&
                        rows(field(w,"events")).iter().any(|e|
                            str_field(e,"action")=="공장 전달 직원 확인" &&
                            rows(field(e,"shipmentIds")).iter()
                                .any(|sid|sid.as_str()==Some(str_field(old,"shipmentId"))));
                    let reopened=old_file_only && !old_delivered &&
                        str_field(current,"status")=="CANCELLED" &&
                        rows(field(w,"events")).iter().any(|e|
                            str_field(e,"action")=="전달 전 출력본 폐기 / 재작성" &&
                            rows(field(e,"shipmentIds")).iter()
                                .any(|sid|sid.as_str()==Some(str_field(old,"shipmentId")))) &&
                        rows(field(state,"exports")).iter().any(|e|
                            rows(field(e,"snapshots")).iter().any(|q|
                                field(q,"id")==field(old,"id") &&
                                field(q,"snapshot")==field(old,"snapshot")));
                    if !metadata_only && !reopened {
                        return Err("이미 전달한 엑셀 / 발송 기록은 보존해야 합니다.".into());
                    }
                }
            }

        }
    }
    Ok(())
}
pub(super) fn validate_reception(before: &Value, state: &Value) -> Result<(),String> {
    for order in rows(field(state,"orders")) {
        let previous = find_by_id(field(before,"orders"),str_field(order,"id"));
        let order_type = str_field(order,"orderType");
        if !order_type.is_empty() && !["AGENCY","DEALER","RETAIL"].contains(&order_type) {
            return Err("주문 유형을 확인하세요.".into());
        }
        if previous.is_none() && order_type=="RETAIL" &&
            field(order,"receptionVersion").as_i64()!=Some(1) {
            return Err("소매 주문 전용 접수 절차를 사용하세요.".into());
        }
        if previous.is_none() && field(order,"receptionVersion").as_i64()==Some(1) &&
            (!has_value(field(order,"confirmedAt")) ||
              !has_value(field(order,"confirmationSnapshot"))) {
            return Err("주문 확인 완료 전에는 정식 주문으로 저장할 수 없습니다.".into());
        }
        if let Some(old) = previous {
            if has_value(field(old,"confirmedAt")) &&
                (field(old,"confirmedAt") != field(order,"confirmedAt") ||
                 field(old,"raw") != field(order,"raw") ||
                 field(old,"confirmationSnapshot") != field(order,"confirmationSnapshot")) {
                return Err("최초 확정 원문 / 시각 / 주문 스냅샷은 변경할 수 없습니다.".into());
            }
            if field(old,"orderType")!=field(order,"orderType") ||
                field(old,"senderSnapshot")!=field(order,"senderSnapshot") {
                return Err("확정 주문의 유형과 송하인 스냅샷은 변경할 수 없습니다.".into());
            }
        }
        if previous.is_none() && field(order,"receptionVersion").as_i64()==Some(1) {
            let snapshot = field(order,"confirmationSnapshot");
            if field(snapshot,"raw") != field(order,"raw") ||
               field(field(snapshot,"data"),"id") != field(order,"id") ||
               field(field(snapshot,"data"),"raw") != field(order,"raw") ||
               field(field(snapshot,"data"),"recipients") != field(order,"recipients") ||
               field(snapshot,"at") != field(order,"confirmedAt") ||
               field(field(order,"receipt"),"original") != field(order,"raw") ||
               field(field(order,"receipt"),"at") != field(order,"confirmedAt") ||
               field(snapshot,"recipients") != field(order,"recipients") ||
               field(field(snapshot,"client"),"id") != field(order,"clientId") {
                return Err("정식 주문의 최초 확정 정보를 확인하세요.".into());
            }
            for row in rows(field(order,"recipients")) {
                for item in rows(field(row,"items")) {
                    let product = find_by_id(field(state,"products"),str_field(item,"productId"));
                    if !product.is_some_and(|p|!has_value(field(p,"deletedAt")) &&
                        field(p,"active").as_bool()!=Some(false) &&
                        array_has(field(p,"variants"),str_field(item,"variantId"))) {
                        return Err("등록된 독립 상품과 가격 기록을 확인하세요.".into());
                    }
                }
            }
            let ships: Vec<&Value> = rows(field(field(state,"workflow"),"shipments")).iter()
                .filter(|s|str_field(s,"orderId")==str_field(order,"id")
                    && !flag(s,"legacyArchived")).collect();
            if ships.is_empty() || ships.iter().any(|s|field(s,"step").as_i64().unwrap_or(0)<1) ||
                !rows(field(field(state,"workflow"),"events")).iter().any(|e|
                    str_field(e,"action")=="주문 확인 완료" &&
                    rows(field(e,"shipmentIds")).iter().any(|v|
                        ships.iter().any(|s|v.as_str()==Some(str_field(s,"id"))))) {
                return Err("주문 확인 완료 기록이 없습니다.".into());
            }
        }
    }
    Ok(())
}
