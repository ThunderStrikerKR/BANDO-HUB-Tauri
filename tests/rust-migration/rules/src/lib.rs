//! Synthetic fixtures only. Run: cargo test --manifest-path tests/rust-migration/rules/Cargo.toml
#[path = "../../../../src-tauri/src/business_core/rules/mod.rs"]
mod rules;

#[cfg(test)]
mod regression {
    use super::rules::execute;
    use serde_json::{json,Value};

    fn client(tier: &str) -> Value {
        json!({"id":"dealer-1","tier":tier,"payment":"POSTPAID",
            "shippingFeeExcluded":false,"overrides":{},"name":"가상 거래처",
            "address":"서울시 가상로 1","phone":"02-1234-5678","preferredAccountId":"account-1"})
    }
    fn product() -> Value {
        json!({"id":"p1","name":"가상 상품","origin":"FACTORY","active":true,
            "shippingGroupId":"music","variants":[{
                "id":"v1","color":"Black","wholesale":30000,"semi":35000,"retail":40000,
                "legacyIds":["old-v1"],"url":"https://www.bandostand.com/product/example"
            }]})
    }
    fn item(q: i64,price:Value) -> Value {
        json!({"id":"item1","productId":"p1","variantId":"v1","name":"가상 상품",
            "quantity":q,"unitPrice":price,"origin":"FACTORY","color":"Black",
            "issues":[],"url":"","raw":"가상 상품"})
    }
    fn recipient(q: i64,price:Value) -> Value {
        json!({"id":"r1","name":"가상 수취인","address":"서울시 가상로 1",
            "phone":"010-1234-5678","mobile":"","items":[item(q,price)],
            "note":"","vatDefault":true})
    }
    fn order(q:i64,price:Value) -> Value {
        json!({"id":"o1","clientId":"dealer-1","recipients":[recipient(q,price)],
            "raw":"가상 발주서","freightCode":"010","shippingFee":3000,
            "applyVat":true,"vatAmount":null,"status":"REVIEW",
            "orderType":"AGENCY","createdAt":"2026-11-13T08:00:00+09:00",
            "updatedAt":"2026-11-13T08:00:00+09:00"})
    }
    fn shipping_state() -> Value {
        json!({"products":[product()],"shipping":{"epoch":7,
            "groups":[{"id":"music","name":"일반 보면대",
                "current":{"version":"v1","maxBundle":4,"maxConfirmed":true,
                    "fees":{"1":3000,"2":4000,"3":5000,"4":6000},
                    "perItem":null}}],
            "combinations":[],"productRules":{}}})
    }
    fn workflow_state(payment:&str) -> Value {
        let mut c=client("wholesale");
        c["payment"]=json!(payment);
        let mut o=order(1,json!(30000));
        o["confirmedAt"]=json!("2026-11-13T09:00:00+09:00");
        o["pricesLocked"]=json!(true);
        o["clientSnapshot"]=c.clone();
        o["senderSnapshot"]=c.clone();
        o["status"]=json!("STATEMENT");
        json!({
            "orders":[o],"clients":[c],"products":[product()],
            "settings":{"accounts":[{"id":"account-1","bank":"가상은행",
                "number":"123-456","holder":"가상상호"}],"defaultAccountId":"account-1"},
            "workflow":{
                "sources":[{"id":"source:o1","orderId":"o1","dealerId":"dealer-1"}],
                "groups":[{"id":"group:o1","sourceId":"source:o1","dealerId":"dealer-1",
                    "notices":[],"needsNotice":false}],
                "shipments":[{"id":"shipment:o1:r1","sourceId":"source:o1",
                    "orderId":"o1","recipientId":"r1","groupId":"group:o1",
                    "step":3,"completedAt":{"1":"2026-11-13T09:00:00+09:00",
                        "2":"2026-11-13T09:00:00+09:00","3":"2026-11-13T09:00:00+09:00"},
                    "charges":{"FACTORY":3000},"chargeMode":"MANUAL","freightVersion":"v1",
                    "infoSignature":"stable","transferred":false}],
                "queue":[],"payments":[],"confirmations":[],"events":[],"deliveries":[],
                "changeRequests":[]
            }
        })
    }
    fn run(op:&str,payload:Value)->Value { execute(op,payload).unwrap() }

    #[test]
    fn retail_semi_wholesale_special_and_legacy_override() {
        let p=product();
        for (tier,expected) in [("retail",40000),("semi",35000),("wholesale",30000)] {
            let result=run("resolve_unit_price",json!({"product":p,"variantId":"v1","client":client(tier)}));
            assert_eq!(result["unitPrice"],json!(expected));
        }
        let mut c=client("special");
        c["overrides"]=json!({"v1":27500});
        assert_eq!(run("resolve_unit_price",json!({"product":p,"variantId":"v1","client":c}))["unitPrice"],27500);
        c["overrides"]=json!({"old-v1":28000});
        assert_eq!(run("resolve_unit_price",json!({"product":p,"variantId":"v1","client":c}))["unitPrice"],28000);
        c["overrides"]=json!({"v1":0});
        assert!(run("resolve_unit_price",json!({"product":p,"variantId":"v1","client":c}))["unitPrice"].is_null());
    }
    #[test]
    fn tax_and_prepaid_collect_and_waiver_match_ts_totals() {
        let mut o=order(2,json!(30000));
        assert_eq!(run("calculate_price",json!({"order":o,"client":client("wholesale")})),
            json!({"subtotal":60000,"shipping":3000,"vat":6300,"total":69300}));
        o["freightCode"]=json!("020");
        assert_eq!(run("calculate_price",json!({"order":o,"client":client("wholesale")})),
            json!({"subtotal":60000,"shipping":0,"vat":6000,"total":66000}));
        o["freightCode"]=json!("010");
        o["applyVat"]=json!(false);
        assert_eq!(run("calculate_price",json!({"order":o,"client":client("wholesale")})),
            json!({"subtotal":60000,"shipping":3000,"vat":0,"total":63000}));
        let mut waived=client("wholesale");
        waived["shippingFeeExcluded"]=json!(true);
        assert_eq!(run("calculate_price",json!({"order":o,"client":waived}))["total"],60000);
    }
    #[test]
    fn incomplete_price_and_unsafe_integer_are_rejected_as_unknown_totals() {
        let o=order(2,Value::Null);
        let r=run("calculate_price",json!({"order":o,"client":client("wholesale")}));
        assert!(r["subtotal"].is_null());
        assert!(r["vat"].is_null());
        assert!(r["total"].is_null());
        let o=order(9_007_199_254_740_991,json!(2));
        assert!(run("calculate_price",json!({"order":o,"client":client("wholesale")}))["total"].is_null());
    }
    #[test]
    fn frozen_order_keeps_price_vat_and_client_terms() {
        let mut o=order(1,json!(30000));
        let mut snapshot=client("wholesale");
        snapshot["shippingFeeExcluded"]=json!(true);
        o["pricesLocked"]=json!(true);
        o["confirmedAt"]=json!("2026-11-13T09:00:00+09:00");
        o["vatAmount"]=json!(3000);
        o["clientSnapshot"]=snapshot;
        let total=run("calculate_price",json!({"order":o,"client":client("retail")}));
        assert_eq!(total,json!({"subtotal":30000,"shipping":0,"vat":3000,"total":33000}));
        let mut new_product=product();
        new_product["variants"][0]["wholesale"]=json!(1);
        let fresh=run("reprice_order",json!({"order":o,"client":client("wholesale"),
            "products":[new_product],"explicitEdit":true}));
        assert_eq!(fresh["refreshed"],false);
        assert_eq!(fresh["order"]["recipients"][0]["items"][0]["unitPrice"],30000);
    }
    #[test]
    fn uncommitted_refresh_and_persisted_passive_refresh_policy() {
        let o=order(1,json!(30000));
        let mut p=product();
        p["variants"][0]["wholesale"]=json!(33333);
        let result=run("reprice_order",json!({"order":o,"client":client("wholesale"),"products":[p]}));
        assert_eq!(result["refreshed"],true);
        assert_eq!(result["order"]["recipients"][0]["items"][0]["unitPrice"],33333);
        let result=run("reprice_order",json!({"order":o,"client":client("wholesale"),
            "products":[p],"persistedOrderIds":["o1"]}));
        assert_eq!(result["refreshed"],false);
        let result=run("reprice_order",json!({"order":o,"client":client("wholesale"),
            "products":[p],"persistedOrderIds":["o1"],"explicitEdit":true}));
        assert_eq!(result["refreshed"],true);
    }
    #[test]
    fn shipping_group_tariff_and_version_token() {
        let r=run("calculate_shipping",json!({"order":order(2,json!(30000)),"state":shipping_state()}));
        assert_eq!(r["total"],4000);
        assert_eq!(r["bundles"][0]["source"],"GROUP");
        assert_eq!(r["bundles"][0]["recommendation"],4000);
        assert_eq!(r["version"],r#"{"epoch":7,"groups":[{"assignment:p1":"music","group:music":"v1"}]}"#);
    }
    #[test]
    fn verified_combination_overrides_base_tariff_only_for_matching_epoch() {
        let mut s=shipping_state();
        s["shipping"]["combinations"]=json!([{
            "id":"combo1","key":"FACTORY|p1@v1:2","epoch":7,"active":true,"charge":4500,
            "versions":{"assignment:p1":"music","group:music":"v1"},"at":"2026-11-13T09:00:00+09:00"
        }]);
        let r=run("calculate_shipping",json!({"order":order(2,json!(30000)),"state":s}));
        assert_eq!(r["total"],4500);
        assert_eq!(r["bundles"][0]["source"],"COMBINATION");
        s["shipping"]["epoch"]=json!(8);
        let current=run("calculate_shipping",json!({"order":order(2,json!(30000)),"state":s}));
        assert_eq!(current["total"],4000);
        assert_eq!(current["bundles"][0]["source"],"GROUP");
    }
    #[test]
    fn missing_tariff_never_invents_shipment_charge() {
        let mut s=shipping_state();
        s["shipping"]["groups"]=json!([]);
        let r=run("calculate_shipping",json!({"order":order(1,json!(30000)),"state":s}));
        assert!(r["total"].is_null());
        assert_eq!(r["bundles"][0]["source"],"MANUAL");
    }
    #[test]
    fn shipment_total_respects_frozen_client_and_recipient_vat() {
        let s=workflow_state("POSTPAID");
        let r=run("calculate_shipment_totals",json!({"state":s,"shipmentId":"shipment:o1:r1"}));
        assert_eq!(r,json!({"subtotal":30000,"shipping":3000,"vat":3300,"total":36300}));
    }
    #[test]
    fn prepaid_does_not_advance_to_approved_without_payment() {
        let s=workflow_state("PREPAID");
        let view=run("evaluate_workflow",json!({"state":s,"groupId":"group:o1"}));
        assert_eq!(view["step"],3);
        assert!(view["issues"].as_array().unwrap().iter().any(|i|
            i.as_str().unwrap().contains("입금 부족")));
        assert!(execute("apply_workflow_action",json!({
            "state":s,"groupId":"group:o1","action":"advance_group",
            "eventId":"event-1","now":"2026-11-13T10:00:00+09:00"})).is_err());
    }
    #[test]
    fn postpaid_stage_advance_and_undo_keep_original_order() {
        let s=workflow_state("POSTPAID");
        let view=run("evaluate_workflow",json!({"state":s,"groupId":"group:o1"}));
        assert_eq!(view["issues"],json!([]));
        let advanced=run("apply_workflow_action",json!({
            "state":s,"groupId":"group:o1","action":"advance_group",
            "eventId":"event-1","now":"2026-11-13T10:00:00+09:00","actor":"직원"
        }));
        assert_eq!(advanced["step"],4);
        assert_eq!(advanced["state"]["workflow"]["events"][0]["action"],"후불 출고 승인");
        assert_eq!(advanced["state"]["orders"][0]["raw"],s["orders"][0]["raw"]);
        let undone=run("apply_workflow_action",json!({
            "state":advanced["state"],"groupId":"group:o1","action":"undo_group",
            "eventId":"event-2","now":"2026-11-13T11:00:00+09:00"}));
        assert_eq!(undone["step"],3);
        assert_eq!(undone["state"]["workflow"]["events"].as_array().unwrap().len(),1);
    }
    #[test]
    fn freight_edit_downgrades_approval_and_requires_new_notice() {
        let s=workflow_state("POSTPAID");
        let edited=run("apply_workflow_action",json!({
            "state":s,"shipmentId":"shipment:o1:r1","origin":"FACTORY",
            "value":6500,"action":"set_shipment_freight",
            "eventId":"event-1","now":"2026-11-13T10:00:00+09:00"
        }));
        assert_eq!(edited["state"]["workflow"]["shipments"][0]["step"],1);
        assert_eq!(edited["state"]["workflow"]["shipments"][0]["charges"]["FACTORY"],6500);
        assert_eq!(edited["state"]["workflow"]["groups"][0]["needsNotice"],true);
    }
    #[test]
    fn past_workflow_records_and_confirmed_raw_cannot_be_mutated() {
        let before=workflow_state("POSTPAID");
        let mut after=before.clone();
        after["workflow"]["events"]=json!([{"id":"e1","action":"입금 확인 완료"}]);
        let new_base=after.clone();
        after["workflow"]["events"][0]["action"]=json!("변조");
        assert!(execute("validate_workflow",json!({"state":after,"before":new_base})).is_err());
        let mut after=before.clone();
        after["orders"][0]["raw"]=json!("다른 발주서");
        assert!(execute("validate_reception_boundary",json!({"state":after,"before":before})).is_err());
    }
    #[test]
    fn duplicate_shipping_and_workflow_ids_are_rejected() {
        let mut s=workflow_state("POSTPAID");
        let dupe=s["workflow"]["shipments"][0].clone();
        s["workflow"]["shipments"].as_array_mut().unwrap().push(dupe);
        assert!(execute("validate_workflow",json!({"state":s})).is_err());
    }
    #[test]
    fn two_recipients_are_billed_as_two_shipping_bundles() {
        let mut o=order(1,json!(30000));
        let mut second=recipient(2,json!(30000));
        second["id"]=json!("r2");
        second["items"][0]["id"]=json!("item2");
        o["recipients"].as_array_mut().unwrap().push(second);
        let r=run("calculate_shipping",json!({"order":o,"state":shipping_state()}));
        assert_eq!(r["bundles"].as_array().unwrap().len(),2);
        assert_eq!(r["total"],7000);
    }
    #[test]
    fn process_group_creates_snapshot_queue_and_preserves_order() {
        let s=workflow_state("POSTPAID");
        let advanced=run("apply_workflow_action",json!({
            "state":s,"groupId":"group:o1","action":"advance_group",
            "eventId":"event-1","now":"2026-11-13T10:00:00+09:00"
        }));
        let processed=run("apply_workflow_action",json!({
            "state":advanced["state"],"groupId":"group:o1","action":"process_group",
            "eventId":"event-2","now":"2026-11-13T10:10:00+09:00"
        }));
        assert_eq!(processed["entries"].as_array().unwrap().len(),1);
        let queue=&processed["state"]["workflow"]["queue"][0];
        assert_eq!(queue["id"],"excel:shipment:o1:r1:FACTORY");
        assert_eq!(queue["status"],"QUEUED");
        assert_eq!(queue["snapshot"]["total"],36300);
        assert_eq!(queue["snapshot"]["freightCode"],"010");
        assert_eq!(processed["state"]["workflow"]["shipments"][0]["transferred"],true);
        assert_eq!(processed["state"]["orders"][0]["raw"],s["orders"][0]["raw"]);
    }
    #[test]
    fn actual_freight_is_an_audited_independent_field() {
        let s=workflow_state("POSTPAID");
        let recorded=run("apply_workflow_action",json!({
            "state":s,"shipmentId":"shipment:o1:r1","origin":"FACTORY",
            "action":"record_actual_freight","value":4200,
            "eventId":"event-1","now":"2026-11-13T10:00:00+09:00"
        }));
        assert_eq!(recorded["state"]["workflow"]["shipments"][0]["actualFreight"]["FACTORY"],4200);
        assert_eq!(recorded["state"]["workflow"]["shipments"][0]["charges"]["FACTORY"],3000);
        assert_eq!(recorded["state"]["workflow"]["events"][0]["action"],"실제 출고 운임 입력");
        let tested=run("validate_workflow",json!({"state":recorded["state"],"before":s}));
        assert_eq!(tested["valid"],true);
    }
    #[test]
    fn frozen_excel_queue_cannot_be_rewritten_after_export() {
        let mut before=workflow_state("POSTPAID");
        before["workflow"]["queue"]=json!([{
            "id":"excel:shipment:o1:r1:FACTORY","shipmentId":"shipment:o1:r1",
            "origin":"FACTORY","status":"EXPORTED","snapshot":{"total":36300}
        }]);
        let mut after=before.clone();
        after["workflow"]["queue"][0]["snapshot"]["total"]=json!(1);
        assert!(execute("validate_workflow",json!({"state":after,"before":before})).is_err());
    }

    #[test]
    fn prepaid_confirmation_creates_allocation_then_approves() {
        let mut s=workflow_state("PREPAID");
        s["workflow"]["groups"][0]["notices"]=json!([{
            "id":"notice-1","account":{"id":"account-1","bank":"가상은행",
                "number":"123-456","holder":"가상상호"},
            "amounts":{"shipment:o1:r1":36300},"total":36300
        }]);
        let out=run("apply_workflow_action",json!({
            "state":s,"action":"confirm_group_payment","groupId":"group:o1",
            "confirmationId":"confirm-1","eventId":"event-1",
            "now":"2026-11-13T11:00:00+09:00"
        }));
        assert_eq!(out["step"],4);
        assert_eq!(out["state"]["workflow"]["confirmations"][0]["amount"],36300);
        assert_eq!(out["state"]["workflow"]["confirmations"][0]["allocations"][0]["amount"],36300);
        assert_eq!(out["state"]["workflow"]["events"][0]["action"],"입금 확인 완료");
        assert_eq!(out["state"]["orders"][0]["raw"],s["orders"][0]["raw"]);
    }
    #[test]
    fn recorded_payment_is_audited_and_cannot_overallocate() {
        let s=workflow_state("PREPAID");
        let input=json!({
            "state":s,"action":"record_payment","groupId":"group:o1",
            "paymentId":"pay-1","allocationIds":["allocation-1"],
            "allocations":[{"shipmentId":"shipment:o1:r1","amount":36300}],
            "paidAmount":36300,"paidAt":"2026-11-13T10:00:00+09:00",
            "eventId":"event-1","now":"2026-11-13T10:01:00+09:00"
        });
        let result=run("apply_workflow_action",input.clone());
        assert_eq!(result["state"]["workflow"]["payments"][0]["amount"],36300);
        assert_eq!(result["state"]["workflow"]["payments"][0]["allocations"][0]["id"],"allocation-1");
        assert_eq!(result["state"]["workflow"]["events"][0]["action"],"실제 입금 기록");
        assert_eq!(run("validate_workflow",json!({"state":result["state"],"before":s}))["valid"],true);
        let mut invalid=input;
        invalid["allocations"][0]["amount"]=json!(36301);
        assert!(execute("apply_workflow_action",invalid).is_err());
    }
    #[test]
    fn pre_excel_queue_can_be_restored_without_erasing_audit() {
        let state=workflow_state("POSTPAID");
        let approved=run("apply_workflow_action",json!({
            "state":state,"action":"advance_group","groupId":"group:o1",
            "eventId":"event-1","now":"2026-11-13T11:00:00+09:00"
        }));
        let queued=run("apply_workflow_action",json!({
            "state":approved["state"],"action":"process_group","groupId":"group:o1",
            "eventId":"event-2","now":"2026-11-13T11:10:00+09:00"
        }));
        let restored=run("apply_workflow_action",json!({
            "state":queued["state"],"action":"restore_shipment","shipmentId":"shipment:o1:r1",
            "eventId":"event-3","now":"2026-11-13T11:15:00+09:00"
        }));
        assert_eq!(restored["state"]["workflow"]["shipments"][0]["transferred"],false);
        assert_eq!(restored["state"]["workflow"]["queue"][0]["status"],"CANCELLED");
        assert_eq!(restored["state"]["workflow"]["events"].as_array().unwrap().len(),3);
    }
    #[test]
    fn store_dispatch_can_advance_queued_status_without_excel_export() {
        let mut s=workflow_state("POSTPAID");
        s["workflow"]["queue"]=json!([{
            "id":"store-queue","shipmentId":"shipment:o1:r1",
            "origin":"STORE","status":"QUEUED",
            "at":"2026-11-13T09:00:00+09:00"
        }]);
        let result=run("apply_workflow_action",json!({
            "state":s,"action":"mark_store_sent","queueId":"store-queue",
            "eventId":"event-1","now":"2026-11-13T11:00:00+09:00"
        }));
        assert_eq!(result["status"],"STORE_SENT");
        assert_eq!(result["state"]["workflow"]["queue"][0]["status"],"STORE_SENT");
        assert_eq!(result["state"]["workflow"]["queue"][0]["fileOnly"],false);
        assert_eq!(result["state"]["workflow"]["events"][0]["action"],"매장 발송 확인");
    }

}
