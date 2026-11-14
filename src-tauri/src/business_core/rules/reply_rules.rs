//! Source src/replies.ts billingSnapshot/applyReply business mutation.
//! Proposal recognition and address parsing remain session 1 inputs.
use serde_json::{json,Value};
use std::collections::HashSet;
use super::{field,find_by_id,flag,has_value,req,required_str,rows,set,str_field};

fn billing(order:&Value,state:&Value,reason:&str,now:&str)->Result<Value,String>{
    let client=super::workflow::party(state,order)
        .or_else(||(str_field(order,"orderType")=="RETAIL")
            .then(||field(order,"clientSnapshot")).filter(|v|!v.is_null()))
        .ok_or("거래처 기록이 없습니다.")?;
    let total=super::pricing::totals(order,client)?;
    let mut snapshot=json!({"at":now,"reason":reason,
        "recipients":field(order,"recipients"),"client":client,
        "total":field(&total,"total")});
    for key in ["shippingFee","vatAmount","applyVat","status",
        "paid","notified","postpaidApproved"]{
        if let Some(value)=order.get(key){
            set(&mut snapshot,key,value.clone())?;
        }
    }
    Ok(snapshot)
}
/// Commit-time native historical billing freeze. The editable React draft
/// carries only the first edit's time/reason; all financial figures are derived
/// from the unmodified saved order and its frozen client by compiled Rust.
/// This operation has no SQLite write: state_save remains the sole transaction.
pub(super) fn finalize_billing_history(payload:&Value)->Result<Value,String>{
    let before=req(payload,"before")?;
    let mut proposed=req(payload,"state")?.clone();
    let previous_orders=rows(field(before,"orders"));
    let previous_shipments=rows(field(field(before,"workflow"),"shipments"));
    let orders=proposed.get_mut("orders").and_then(Value::as_array_mut)
        .ok_or("주문 목록 누락")?;
    for order in orders.iter_mut(){
        let marker=order.get("pendingBillingSnapshot").cloned();
        // A transient marker must never reach SQLite, even on new drafts.
        if let Some(object)=order.as_object_mut(){
            object.remove("pendingBillingSnapshot");
        }
        let Some(marker)=marker.filter(|v|!v.is_null()) else {continue};
        let Some(previous)=previous_orders.iter()
            .find(|old|str_field(old,"id")==str_field(order,"id")) else {continue};
        // Never allow a stale React draft to overwrite an already frozen
        // historical invoice, even if the first-edit marker survives a save.
        let frozen=rows(field(previous,"billingHistory"));
        let incoming=rows(field(order,"billingHistory"));
        if incoming.len()<frozen.len() || !incoming.iter().zip(frozen).all(|(a,b)|a==b){
            return Err("과거 청구 이력이 변경되었습니다. 최신 주문을 다시 불러오세요.".into());
        }
        if !flag(previous,"pricesLocked") ||
            marker.get("activeGroupId").and_then(Value::as_str)
                .is_some_and(|value|!value.is_empty()) ||
            previous_shipments.iter().any(|ship|
                str_field(ship,"orderId")==str_field(order,"id") &&
                !flag(ship,"legacyArchived")) {
            continue;
        }
        let reason=required_str(&marker,"reason")?;
        let at=required_str(&marker,"at")?;
        // Never calculate an old invoice from the edited order, current
        // product prices, or the latest master-client pricing tier.
        let snapshot=billing(previous,before,reason,at)?;
        let history=order.as_object_mut()
            .ok_or("정정 주문 정보가 없습니다.")?
            .entry("billingHistory").or_insert_with(||json!([]));
        if history.is_null(){*history=json!([]);}
        history.as_array_mut().ok_or("청구 이력 형식을 확인하세요.")?
            .push(snapshot);
    }
    Ok(json!({"state":proposed}))
}

pub(super) fn apply(payload:&Value)->Result<Value,String>{
    let action=required_str(payload,"action")?;
    let order=req(payload,"order")?;
    let state=req(payload,"state")?;
    match action {
        "billing_snapshot"=>Ok(json!({"snapshot":billing(order,state,
            required_str(payload,"reason")?,required_str(payload,"now")?)?})),
        "apply_reply"=>{
            let preview=req(payload,"preview")?;
            let warnings=rows(field(preview,"warnings")).iter()
                .filter_map(Value::as_str).collect::<Vec<_>>();
            if !warnings.is_empty(){return Err(warnings.join("\n"));}
            let changes=rows(field(preview,"changes"));
            let receiver_changes=rows(field(preview,"recipientChanges"));
            if changes.is_empty()&&receiver_changes.is_empty(){
                return Err("적용할 변경사항이 없습니다.".into());
            }
            if str_field(order,"status")=="EXPORTED" {
                return Err("공장 전달 완료 주문은 회신으로 변경할 수 없습니다.".into());
            }
            if flag(preview,"requiresReapproval")&&!flag(payload,"acknowledged"){
                return Err("기존 안내 / 입금 / 출고 승인의 재확인을 승인해 주세요.".into());
            }
            let at=required_str(payload,"now")?;
            let mut next=order.clone();
            let snapshot=billing(order,state,"회신 반영 전",at)?;
            let mut history=rows(field(&next,"billingHistory")).to_vec();
            history.push(snapshot);
            set(&mut next,"billingHistory",json!(history))?;
            for change in changes{
                let rid=str_field(change,"recipientId");
                let iid=str_field(change,"itemId");
                let ri=rows(field(&next,"recipients")).iter()
                    .position(|r|str_field(r,"id")==rid);
                let ii=ri.and_then(|ri|rows(field(&next["recipients"][ri],"items"))
                    .iter().position(|i|str_field(i,"id")==iid));
                let valid=ri.zip(ii).is_some_and(|(ri,ii)|
                    next["recipients"][ri]["items"][ii]==*field(change,"before"));
                if !valid{return Err("주문이 변경되었습니다. 회신 내용을 다시 비교하세요.".into());}
                let (ri,ii)=ri.zip(ii).unwrap();
                let target=&mut next["recipients"][ri]["items"][ii];
                for (key,value) in field(change,"after").as_object()
                    .ok_or("상품 수정 내용 형식 오류")?{
                    set(target,key,value.clone())?;
                }
            }
            for change in receiver_changes{
                let rid=str_field(change,"recipientId");
                let ri=rows(field(&next,"recipients")).iter()
                    .position(|r|str_field(r,"id")==rid)
                    .ok_or("수취정보가 변경되었습니다. 다시 비교하세요.")?;
                let recipient=&next["recipients"][ri];
                let before=field(change,"before");
                let after=field(change,"after");
                for (key,value) in before.as_object()
                    .ok_or("수취정보가 변경되었습니다. 다시 비교하세요.")?{
                    if recipient.get(key)!=Some(value){
                        return Err("수취정보가 변경되었습니다. 다시 비교하세요.".into());
                    }
                }
                // Source change.after object is created from keys in this
                // fixed order; treat this order as meaningful for the
                // confirmedFields history array.
                let keys=["name","address","phone","mobile","note"];
                let mut confirmed=rows(field(recipient,"confirmedFields")).iter()
                    .filter_map(Value::as_str).map(String::from).collect::<Vec<_>>();
                let mut seen=confirmed.iter().cloned().collect::<HashSet<_>>();
                for key in keys {
                    if let Some(value)=after.get(key){
                        if before.get(key)!=Some(value)&&seen.insert(key.into()){
                            confirmed.push(key.into());
                        }
                    }
                }
                let recipient=&mut next["recipients"][ri];
                for (key,value) in after.as_object().ok_or("수취정보 형식 오류")?{
                    set(recipient,key,value.clone())?;
                }
                set(recipient,"confirmedFields",json!(confirmed))?;
                if before.get("address")!=after.get("address") {
                    // The address parser belongs to session 1; the caller
                    // supplies the exact addressInfo/addressParts output.
                    let info=field(field(payload,"addresses"),rid);
                    if !info.is_object(){
                        return Err("주소 분석 결과 누락: 세션 1 주소 분석 연결이 필요합니다.".into());
                    }
                    set(recipient,"addressKind",field(info,"kind").clone())?;
                    set(recipient,"addressParts",field(info,"parts").clone())?;
                    set(recipient,"addressStatus",
                        json!(if flag(info,"complete"){"COMPLETE"}else{"INCOMPLETE"}))?;
                }
            }
            let mut reply=json!({
                "id":required_str(payload,"replyId")?,
                "at":at,"raw":field(preview,"raw"),
                "changes":field(preview,"changes")
            });
            if let Some(changes)=preview.get("recipientChanges"){
                set(&mut reply,"recipientChanges",changes.clone())?;
            }
            let mut replies=rows(field(&next,"replies")).to_vec();
            replies.push(reply);
            set(&mut next,"replies",json!(replies))?;
            for (key,value) in [
                ("pricesLocked",json!(false)),("notified",json!(false)),
                ("paid",json!(false)),("postpaidApproved",json!(false)),
                ("status",json!("REVIEW")),("shippingMode",json!("AUTO")),
                ("updatedAt",json!(at))
            ]{set(&mut next,key,value)?;}
            next.as_object_mut().ok_or("주문 정보 형식 오류")?.remove("messageEdits");
            let reco=super::shipping::recommend(&next,state)?;
            set(&mut next,"shippingFee",field(&reco,"total").clone())?;
            set(&mut next,"shippingVersion",field(&reco,"version").clone())?;
            Ok(json!({"order":next}))
        },
        _=>Err(format!("지원하지 않는 회신 action: {action}"))
    }
}
