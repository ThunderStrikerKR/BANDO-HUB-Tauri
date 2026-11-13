//! Source-equivalent newRetailOrder/confirmRetail. No UI, database, parser.
use serde_json::{json,Value};
use super::{field,find_by_id,has_value,req,required_str,rows,set,str_field};

pub(super) fn apply(payload:&Value)->Result<Value,String>{
    match required_str(payload,"action")? {
        "new_retail_order"=>{
            let order_id=required_str(payload,"orderId")?;
            let row_id=required_str(payload,"recipientId")?;
            let at=required_str(payload,"now")?;
            let mut order=super::reception_operations::new_reception(
                &json!({"now":at,"id":order_id,"clientId":"","orderType":"RETAIL"}))?;
            set(&mut order,"recipients",json!([{
                "id":row_id,"name":"","address":"","mobile":"","phone":"",
                "note":"","items":[],"dispatchOrigin":"FACTORY"
            }]))?;
            Ok(json!({"order":order}))
        },
        "confirm_retail"=>{
            let input=req(payload,"state")?;
            let draft=req(payload,"draft")?;
            if str_field(draft,"orderType")!="RETAIL"||
                has_value(field(draft,"confirmedAt"))||
                find_by_id(field(input,"orders"),str_field(draft,"id")).is_some(){
                return Err("신규 소매 주문만 접수할 수 있습니다.".into());
            }
            let issues=super::validation::retail_issues(draft,input);
            if !issues.is_empty(){return Err(issues.join("\n"));}
            let at=required_str(payload,"now")?;
            let staff=str_field(field(input,"settings"),"operatorName");
            let actor=if staff.is_empty(){"직원"}else{staff};
            let mut order=draft.clone();
            set(&mut order,"clientId",json!(""))?;
            set(&mut order,"raw",json!(""))?;
            let party=super::validation::company_party(input);
            let sender=super::reconciliation::company_client(input);
            set(&mut order,"clientSnapshot",party.clone())?;
            set(&mut order,"senderSnapshot",sender.clone())?;
            for recipient in order["recipients"].as_array_mut().ok_or("수취인 목록 누락")?{
                set(recipient,"vatDefault",json!(false))?;
                let origin=field(recipient,"dispatchOrigin").clone();
                for item in recipient["items"].as_array_mut().ok_or("상품 목록 누락")?{
                    set(item,"unitPrice",Value::Null)?;
                    set(item,"origin",origin.clone())?;
                }
            }
            for (key,value) in [
                ("confirmedAt",json!(at)),("createdAt",json!(at)),
                ("updatedAt",json!(at)),("paid",json!(true)),
                ("status",json!("QUEUED")),("pricesLocked",json!(true)),
                ("applyVat",json!(false)),("vatAmount",Value::Null),
                ("shippingFee",Value::Null)
            ]{set(&mut order,key,value)?;}
            set(&mut order,"receipt",json!({
                "original":"","at":at,"actor":actor,"clientId":"",
                "legacy":false
            }))?;
            let data=order.clone();
            set(&mut order,"confirmationSnapshot",json!({
                "at":at,"raw":"","client":party,
                "recipients":field(&data,"recipients"),"data":data
            }))?;
            let initial=super::reconciliation::reconcile(&json!({
                "state":input,"draft":order,"now":at,
                "eventIds":field(payload,"reconcileEventIds")
            }))?;
            let mut state=field(&initial,"state").clone();
            let oid=str_field(&order,"id");
            let ship_ids=rows(field(field(&state,"workflow"),"shipments")).iter()
                .filter(|s|str_field(s,"orderId")==oid)
                .map(|s|str_field(s,"id").to_string()).collect::<Vec<_>>();
            for ship in state["workflow"]["shipments"].as_array_mut()
                .ok_or("배송건 목록 누락")?{
                if str_field(ship,"orderId")!=oid{continue;}
                set(ship,"step",json!(4))?;
                set(ship,"completedAt",json!({"1":at}))?;
                set(ship,"sender",sender.clone())?;
            }
            let group_id=format!("group:{oid}");
            state["workflow"]["events"].as_array_mut().ok_or("업무 이벤트 목록 누락")?
                .push(json!({
                    "id":required_str(payload,"receiptEventId")?,
                    "at":at,"actor":actor,"action":"주문 확인 완료",
                    "groupId":group_id,"shipmentIds":ship_ids,
                    "after":{"orderType":"RETAIL","externallyPaid":true}
                }));
            let processed=super::workflow::apply(&json!({
                "state":state,"action":"process_group",
                "groupId":group_id,"now":at,"actor":actor,
                "eventId":required_str(payload,"processEventId")?,
                "reconcileEventIds":field(payload,"processReconcileEventIds")
            }))?;
            Ok(json!({"state":field(&processed,"state")}))
        },
        other=>Err(format!("지원하지 않는 소매 접수 action: {other}"))
    }
}
