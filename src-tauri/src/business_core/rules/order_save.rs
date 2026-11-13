//! Exact persisted order-save decision port of src/app/useAppModel.ts::saveOrder.
//! No SQLite writes, clock access, generated IDs or client lookups are hidden
//! here. The caller sends the selected client and timestamp; the native
//! transaction still verifies revision and commits the returned state.
use serde_json::{json, Value};
use std::collections::HashSet;
use super::{field, flag, has_value, req, required_str, rows, set, str_field};
use super::{issues, pricing};

fn review_issues(order: &Value) -> Vec<String> {
    let mut unique = HashSet::new();
    let mut results = Vec::new();
    for issue in issues::order_issues(order) {
        if str_field(&issue, "severity") != "ACTION" ||
            field(&issue, "blockingStage").as_i64().unwrap_or(4) > 1 {
            continue;
        }
        let item_id = str_field(&issue, "itemId");
        let label = if !item_id.is_empty() {
            rows(field(order, "recipients")).iter()
                .flat_map(|recipient| rows(field(recipient, "items")).iter())
                .find(|item| str_field(item,"id") == item_id)
                .map(|item| str_field(item, "name")).filter(|name| !name.is_empty())
                .unwrap_or("상품").to_string()
        } else {
            let index = rows(field(order, "recipients")).iter()
                .position(|recipient| str_field(recipient,"id") == str_field(&issue,"recipientId"));
            format!("수취인 {}", index.map(|n| n+1).unwrap_or(0))
        };
        let issue_text = format!("{}: {}", label, str_field(&issue, "title"));
        if unique.insert(issue_text.clone()) { results.push(issue_text); }
    }
    results
}

fn queue_issues(order: &Value, client: &Value, total: &Value) -> Vec<String> {
    let mut issues = review_issues(order);
    if str_field(order, "status") == "EXPORTED" {
        issues.push("이미 공장에 전달한 주문입니다. 수정 / 재확인 후 추가하세요.".into());
    }
    if total.is_null() { issues.push("청구 금액 / 운임 미확정".into()); }
    if !flag(order, "notified") { issues.push("안내 완료 처리 필요".into()); }
    if str_field(client, "payment") == "PREPAID" && !flag(order, "paid") {
        issues.push("실제 입금 확인 필요".into());
    }
    if str_field(client, "payment") == "POSTPAID" && !flag(order, "postpaidApproved") {
        issues.push("후불 출고 승인 필요".into());
    }
    let factory = rows(field(order,"recipients")).iter().any(|recipient|
        rows(field(recipient,"items")).iter().any(|item|
            str_field(item,"origin") == "FACTORY"
        )
    );
    if !factory { issues.push("공장 출고 상품 없음".into()); }
    let name = if str_field(client,"displayName").is_empty() {
        str_field(client,"name")
    } else { str_field(client,"displayName") };
    if name.is_empty() || str_field(client,"address").is_empty() ||
        (str_field(client,"phone").is_empty() && str_field(client,"mobile").is_empty()) {
        issues.push("거래처 송장 상호 / 주소 / 전화번호 등록 필요".into());
    }
    issues
}

pub(super) fn save(payload: &Value) -> Result<Value,String> {
    let state = req(payload,"state")?;
    let old = req(payload,"order")?;
    let client = req(payload,"client")?;
    let mode = required_str(payload,"mode")?;
    let now = required_str(payload,"now")?;
    if !["save","notify","pay","queue","wait"].contains(&mode) {
        return Err("지원하지 않는 주문 저장 방식입니다.".into());
    }
    if field(old,"receptionVersion").as_i64() == Some(1) &&
        !has_value(field(old,"confirmedAt")) &&
        !rows(field(state,"orders")).iter().any(|o|
            str_field(o,"id") == str_field(old,"id")) {
        return Err("최종 검수 후 주문 확인 완료로 정식 접수하세요.".into());
    }
    if str_field(client,"id").is_empty() { return Err("거래처를 선택하세요.".into()); }
    if str_field(old,"status") == "EXPORTED" {
        return Err("공장 전달 완료 주문은 변경할 수 없습니다.".into());
    }
    let mut order = old.clone();
    set(&mut order,"clientSnapshot",client.clone())?;
    set(&mut order,"updatedAt",json!(now))?;
    let totals = pricing::totals(&order,client)?;
    set(&mut order,"vatAmount",field(&totals,"vat").clone())?;
    let complete = review_issues(&order).is_empty() &&
        !field(&totals,"total").is_null();
    match mode {
        "notify" => {
            if !complete {
                return Err("상품 / 배송 정보 / 금액을 먼저 확인하세요.".into());
            }
            set(&mut order,"notified",json!(true))?;
            set(&mut order,"status",json!("NOTIFIED"))?;
        }
        "pay" => {
            if !flag(&order,"notified") || !complete {
                return Err("주문 검토와 안내 완료를 먼저 처리하세요.".into());
            }
            if str_field(client,"payment") == "PREPAID" {
                set(&mut order,"paid",json!(true))?;
            } else {
                set(&mut order,"postpaidApproved",json!(true))?;
            }
            set(&mut order,"status",json!("APPROVED"))?;
        }
        "wait" => {
            if !flag(&order,"notified") || str_field(client,"payment") != "PREPAID" {
                return Err("선입금 주문의 안내 완료 후 입금 대기를 처리하세요.".into());
            }
            set(&mut order,"status",json!("WAITING"))?;
        }
        "queue" => {
            let issues = queue_issues(&order,client,field(&totals,"total"));
            if !issues.is_empty() { return Err(issues.join("\n")); }
            set(&mut order,"status",json!("QUEUED"))?;
        }
        _ => {
            if !flag(&order,"notified") && !flag(&order,"paid") &&
                !flag(&order,"postpaidApproved") {
                set(&mut order,"status",json!(if complete {"STATEMENT"} else {"REVIEW"}))?;
            }
        }
    }
    set(&mut order,"pricesLocked",json!(complete))?;
    let mut updated = state.clone();
    let orders = updated.get_mut("orders").and_then(Value::as_array_mut)
        .ok_or("저장할 주문 목록을 확인하세요.")?;
    if let Some(index) = orders.iter().position(|o| str_field(o,"id") == str_field(&order,"id")) {
        orders[index] = order.clone();
    } else {
        orders.insert(0,order.clone());
    }
    let queue = updated.get_mut("queue").and_then(Value::as_array_mut)
        .ok_or("공장 대기 목록을 확인하세요.")?;
    let order_id=str_field(&order,"id");
    if mode=="queue" {
        if !queue.iter().any(|id|id.as_str()==Some(order_id)) {
            queue.push(json!(order_id));
        }
    } else if str_field(&order,"status") != "QUEUED" {
        queue.retain(|id|id.as_str()!=Some(order_id));
    }
    Ok(json!({"state":updated,"order":order,"complete":complete,"totals":totals}))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn client() -> Value {
        json!({"id":"dealer","tier":"wholesale","payment":"PREPAID",
            "name":"가상 거래처","address":"서울시 마포구 월드컵로 20","phone":"0212345678"})
    }
    fn order() -> Value {
        json!({"id":"o1","clientId":"dealer","receptionVersion":1,
            "confirmedAt":"2026-11-13T00:00:00.000Z","status":"REVIEW",
            "freightCode":"010","shippingFee":3000,"applyVat":true,
            "notified":false,"paid":false,"pricesLocked":false,
            "recipients":[{"id":"r1","name":"김가상","address":"서울시 마포구 월드컵로 20",
                "addressStatus":"COMPLETE","phone":"01012345678","mobile":"",
                "items":[{"id":"i1","name":"BD 709","productId":"p1",
                    "variantId":"v1","unitPrice":12000,"quantity":2,
                    "quantityConfirmed":true,"origin":"FACTORY","issues":[]}]}]})
    }
    fn input(mode:&str) -> Value {
        json!({"state":{"orders":[],"queue":[]}, "order":order(),"client":client(),
            "mode":mode,"now":"2026-11-13T01:00:00.000Z"})
    }
    #[test]
    fn prevents_unconfirmed_first_reception_from_being_saved() {
        let mut req=input("save"); req["order"]["confirmedAt"]=Value::Null;
        let before=req["state"].clone();
        assert!(save(&req).unwrap_err().contains("주문 확인 완료"));
        assert_eq!(req["state"],before);
    }
    #[test]
    fn frozen_export_is_immutable() {
        let mut req=input("pay");req["order"]["status"]=json!("EXPORTED");
        assert!(save(&req).is_err());
        assert_eq!(req["state"]["orders"].as_array().unwrap().len(),0);
    }
    #[test]
    fn save_without_notice_does_not_approve_or_queue() {
        let result=save(&input("save")).unwrap();
        assert_eq!(result["order"]["status"],"STATEMENT");
        assert_eq!(result["order"]["vatAmount"],2700);
        assert_eq!(result["order"]["pricesLocked"],true);
        assert_eq!(result["state"]["queue"],json!([]));
    }
    #[test]
    fn notify_pay_wait_queue_require_the_original_approvals() {
        assert!(save(&input("pay")).is_err());
        assert!(save(&input("wait")).is_err());
        assert!(save(&input("queue")).is_err());
        let notified=save(&input("notify")).unwrap();
        assert_eq!(notified["order"]["status"],"NOTIFIED");
        assert_eq!(notified["order"]["notified"],true);
        let mut pay=input("pay"); pay["order"]=notified["order"].clone();
        let paid=save(&pay).unwrap();
        assert_eq!(paid["order"]["status"],"APPROVED");
        assert_eq!(paid["order"]["paid"],true);
        let mut queue=input("queue");queue["order"]=paid["order"].clone();
        let ready=save(&queue).unwrap();
        assert_eq!(ready["order"]["status"],"QUEUED");
        assert_eq!(ready["state"]["queue"],json!(["o1"]));
    }
}
