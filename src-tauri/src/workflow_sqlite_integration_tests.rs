//! End-to-end native workflow lifecycle against the app's REAL SQLite
//! initializer and v2 relational core, not a mocked data store or in-memory
//! JSON-only test. Uses a unique temporary directory; never production data.
use super::*;
use std::time::{SystemTime, UNIX_EPOCH};

struct IsolatedDatabase {
    root: PathBuf,
}
impl IsolatedDatabase {
    fn open() -> (Self, Connection) {
        let stamp = SystemTime::now().duration_since(UNIX_EPOCH)
            .unwrap().as_nanos();
        let root = std::env::temp_dir().join(format!(
            "bando-native-workflow-e2e-{}-{stamp}", std::process::id()
        ));
        fs::create_dir_all(&root).unwrap();
        let conn = initialize_database(&root.join("state.sqlite"))
            .expect("real production SQLite initializer must succeed");
        (Self { root }, conn)
    }
}
impl Drop for IsolatedDatabase {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn rust(operation: &str, payload: Value) -> Result<Value, String> {
    business_core::execute("rules", operation, payload)
}

fn stage_three(base: &Value, payment: &str) -> Value {
    assert!(base["orders"].as_array().unwrap().is_empty());
    let mut state = base.clone();
    let product = &base["products"][0];
    let product_id = product["id"].as_str().unwrap().to_owned();
    let variant_id = product["variants"][0]["id"].as_str().unwrap().to_owned();
    let mut client = json!({
        "id":"synthetic-workflow-client", "name":"합성 테스트 거래처",
        "tier":"wholesale", "payment":payment, "shippingFeeExcluded":false,
        "address":"서울특별시 강남구 테헤란로 123", "phone":"02-1234-5678",
        "mobile":"", "preferredAccountId":"synthetic-account", "overrides":{}
    });
    state["settings"]["accounts"] = json!([{
        "id":"synthetic-account", "bank":"가상은행",
        "number":"123-456", "holder":"합성 계좌"
    }]);
    state["settings"]["defaultAccountId"] = json!("synthetic-account");
    state["settings"]["operatorName"] = json!("검증 담당자");
    state["clients"].as_array_mut().unwrap().push(client.clone());

    let at = "2026-11-13T12:00:00+09:00";
    let raw = "합성 상품 1개 수취인 김테스트";
    let recipients = json!([{
        "id":"recipient:synthetic", "name":"김테스트",
        "address":"서울특별시 강남구 테헤란로 123, 4층",
        "phone":"010-1234-5678", "mobile":"",
        "vatDefault":true, "note":"",
        "items":[{
            "id":"item:synthetic","productId":product_id,
            "variantId":variant_id,"name":"합성 상품", "color":"색상 미표기",
            "quantity":1,"unitPrice":30000,"origin":"FACTORY"
        }]
    }]);
    let mut order = json!({
        "id":"order:synthetic","receptionVersion":1,
        "clientId":"synthetic-workflow-client","orderType":"AGENCY",
        "raw":raw,"createdAt":at,"updatedAt":at,"confirmedAt":at,
        "status":"STATEMENT","recipients":recipients,
        "applyVat":true,"freightCode":"010","shippingFee":3000,
        "pricesLocked":true,"vatAmount":null,
        "clientSnapshot":client,"senderSnapshot":client,
        "receipt":{
            "original":raw,"at":at,"actor":"검증 담당자",
            "clientId":"synthetic-workflow-client","legacy":false
        },"rawCorrections":[]
    });
    order["confirmationSnapshot"] = json!({
        "at":at,"raw":raw,"client":client,
        "recipients":recipients,"data":order
    });
    state["orders"].as_array_mut().unwrap().push(order);
    state["workflow"] = json!({
        "sources":[{
            "id":"source:synthetic","orderId":"order:synthetic",
            "dealerId":"synthetic-workflow-client","number":1
        }],
        "groups":[{
            "id":"group:synthetic","sourceId":"source:synthetic",
            "dealerId":"synthetic-workflow-client",
            "notices":[],"needsNotice":false
        }],
        "shipments":[{
            "id":"shipment:synthetic","sourceId":"source:synthetic",
            "orderId":"order:synthetic","recipientId":"recipient:synthetic",
            "groupId":"group:synthetic","step":3,
            "completedAt":{"1":at,"2":at,"3":at},
            "charges":{"FACTORY":3000},"chargeMode":"MANUAL",
            "freightVersion":"v1","infoSignature":"stable",
            "transferred":false
        }],
        "payments":[],"confirmations":[],"queue":[],"deliveries":[],
        "changeRequests":[],
        "events":[{
            "id":"event:confirmation","at":at,"actor":"검증 담당자",
            "action":"주문 확인 완료","shipmentIds":["shipment:synthetic"],
            "groupId":"group:synthetic"
        }]
    });
    client["name"] = json!("검증용"); // Only local fixture; no live DB mutation.
    state
}

#[test]
fn native_draft_preview_and_reconcile_are_read_only_against_relational_sqlite() {
    let (isolated, mut conn) = IsolatedDatabase::open();
    let before = get_snapshot(&conn).unwrap();
    assert!(relational_store::active(&conn).unwrap());
    let source = stage_three(&before, "POSTPAID");
    let saved = write_snapshot(&mut conn, source, 0, true)
        .expect("confirmed order must persist through the real SQLite transaction");
    let persisted_event_count = saved["workflow"]["events"].as_array().unwrap().len();

    let board = rust("preview_workflow", json!({"state":saved})).unwrap();
    assert_eq!(board["groups"][0]["groupId"], "group:synthetic");
    assert_eq!(board["groups"][0]["step"], 3);
    assert_eq!(board["groups"][0]["totals"]["total"], 36300);
    let detail = rust("preview_order", json!({
        "state": saved, "draft": saved["orders"][0],
        "orderId":"order:synthetic"
    })).unwrap();
    assert_eq!(detail["total"], 36300);
    assert_eq!(detail["shipmentCount"], 1);

    let mut edit = saved["orders"][0].clone();
    edit["recipients"][0]["note"] = json!("미저장 직원 수정");
    let event_ids = (0..256).map(|index|format!("transient-audit-{index}"))
        .collect::<Vec<_>>();
    let preview = rust("reconcile_workflow", json!({
        "state":saved,"draft":edit,
        "now":"2026-11-13T12:15:00+09:00","eventIds":event_ids
    })).expect("native reconciliation must return an unsaved preview");
    assert_eq!(preview["state"]["orders"][0]["recipients"][0]["note"],
        "미저장 직원 수정");
    assert_eq!(get_snapshot(&conn).unwrap(), saved);
    assert_eq!(saved["workflow"]["events"].as_array().unwrap().len(),
        persisted_event_count);
    assert_eq!(saved["revision"], 1);
    drop(conn);

    let reopened = initialize_database(&isolated.root.join("state.sqlite")).unwrap();
    assert_eq!(get_snapshot(&reopened).unwrap(), saved);
    let count:i64 = reopened.query_row(
        "SELECT COUNT(*) FROM core_orders WHERE id='order:synthetic'",
        [], |row| row.get(0)
    ).unwrap();
    assert_eq!(count, 1);
    drop(reopened);
}

#[test]
fn native_postpaid_stage_approval_audit_and_revision_survive_sqlite_reopen() {
    let (isolated, mut conn) = IsolatedDatabase::open();
    let source = stage_three(&get_snapshot(&conn).unwrap(), "POSTPAID");
    let saved = write_snapshot(&mut conn, source, 0, true).unwrap();
    let decision = rust("apply_workflow_action", json!({
        "state":saved,"action":"advance_group","groupId":"group:synthetic",
        "eventId":"event:postpaid-approval",
        "now":"2026-11-13T12:30:00+09:00","actor":"검증 담당자"
    })).expect("postpaid order should be able to approve stage 4");
    assert_eq!(decision["step"], 4);
    let approved = decision["state"].clone();
    assert_eq!(approved["workflow"]["shipments"][0]["step"], 4);
    rust("validate_workflow", json!({
        "state":approved,"before":saved
    })).expect("native audit and workflow must validate before SQLite commit");
    let committed = write_snapshot(&mut conn, approved, 1, true)
        .expect("approved transition must persist atomically");
    assert_eq!(committed["revision"], 2);
    assert!(committed["workflow"]["events"].as_array().unwrap().iter()
        .any(|event| event["id"]=="event:postpaid-approval"
            && event["action"]=="후불 출고 승인"));
    let stale = write_snapshot(&mut conn, saved.clone(), 1, true)
        .expect_err("stale workspace must not overwrite approved workflow");
    assert!(stale.contains("다른 작업"));
    assert_eq!(get_snapshot(&conn).unwrap(), committed);
    let count:i64 = conn.query_row(
        "SELECT COUNT(*) FROM core_recipients WHERE order_id='order:synthetic'",
        [], |row|row.get(0)
    ).unwrap();
    assert_eq!(count, 1);
    drop(conn);
    let reopened = initialize_database(&isolated.root.join("state.sqlite")).unwrap();
    assert_eq!(get_snapshot(&reopened).unwrap(), committed);
    assert_eq!(committed["workflow"]["shipments"][0]["step"], 4);
    drop(reopened);
}

#[test]
fn native_prepaid_stage_rejection_leaves_sqlite_order_and_audit_untouched() {
    let (isolated, mut conn) = IsolatedDatabase::open();
    let source = stage_three(&get_snapshot(&conn).unwrap(), "PREPAID");
    let saved = write_snapshot(&mut conn, source, 0, true).unwrap();
    let count = saved["workflow"]["events"].as_array().unwrap().len();
    let issue = rust("apply_workflow_action", json!({
        "state":saved,"action":"advance_group","groupId":"group:synthetic",
        "eventId":"event:unpaid-approval",
        "now":"2026-11-13T12:30:00+09:00","actor":"검증 담당자"
    })).expect_err("a prepaid shipment cannot advance without a payment");
    assert!(issue.contains("입금") || issue.contains("부족"),
        "must explain the missing payment: {issue}");
    assert_eq!(get_snapshot(&conn).unwrap(), saved);
    assert_eq!(saved["workflow"]["events"].as_array().unwrap().len(),count);
    assert_eq!(saved["revision"],1);
    drop(conn);
    let reopened = initialize_database(&isolated.root.join("state.sqlite")).unwrap();
    assert_eq!(get_snapshot(&reopened).unwrap(),saved);
    drop(reopened);
}
