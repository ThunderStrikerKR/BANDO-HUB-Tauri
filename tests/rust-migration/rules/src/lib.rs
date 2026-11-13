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

    #[test]
    fn dispatch_change_request_is_append_only_and_audited() {
        let before=workflow_state("POSTPAID");
        let result=run("apply_workflow_action",json!({
            "state":before,"action":"record_change_request",
            "shipmentId":"shipment:o1:r1","changeRequestId":"request-1",
            "text":"공장 전달 후 수취인 연락처 확인 요청",
            "eventId":"event-1","now":"2026-11-13T12:00:00+09:00"
        }));
        assert_eq!(result["state"]["workflow"]["changeRequests"][0]["text"],
            "공장 전달 후 수취인 연락처 확인 요청");
        assert_eq!(result["state"]["workflow"]["events"][0]["action"],"전달 후 변경 요청 기록");
        assert_eq!(run("validate_workflow",json!({"state":result["state"],"before":before}))["valid"],true);
    }
    #[test]
    fn excessive_bundle_quantity_fails_without_integer_panic() {
        let mut o=order(i64::MAX,json!(30000));
        let second=item(i64::MAX,json!(30000));
        o["recipients"][0]["items"].as_array_mut().unwrap().push(second);
        assert!(execute("calculate_shipping",json!({"order":o,"state":shipping_state()})).is_err());
    }

    #[test]
    fn mixed_factory_and_store_origins_keep_independent_tariffs() {
        let mut order=order(1,json!(30000));
        let mut store_item=item(1,json!(30000));
        store_item["id"]=json!("item-store");
        store_item["productId"]=json!("store-product");
        store_item["variantId"]=json!("store-variant");
        store_item["origin"]=json!("STORE");
        order["recipients"][0]["items"].as_array_mut().unwrap().push(store_item);
        let mut state=shipping_state();
        state["products"].as_array_mut().unwrap().push(json!({
            "id":"store-product","name":"가상 매장 상품","origin":"STORE",
            "shippingGroupId":"store-group","variants":[{
                "id":"store-variant","wholesale":30000,"semi":35000,"retail":40000
            }]
        }));
        state["shipping"]["groups"].as_array_mut().unwrap().push(json!({
            "id":"store-group","name":"매장 소형","current":{
                "version":"v-store","fees":{"1":2500},"maxBundle":null,
                "maxConfirmed":false,"perItem":null
            }
        }));
        let rates=run("calculate_shipping",json!({"order":order,"state":state}));
        assert_eq!(rates["total"],5500);
        assert_eq!(rates["bundles"].as_array().unwrap().len(),2);
        assert_eq!(rates["bundles"][0]["origin"],"STORE");
        assert_eq!(rates["bundles"][0]["recommendation"],2500);
        assert_eq!(rates["bundles"][1]["origin"],"FACTORY");
        assert_eq!(rates["bundles"][1]["recommendation"],3000);

        let mut frozen=workflow_state("POSTPAID");
        frozen["orders"][0]["recipients"][0]["items"].as_array_mut().unwrap().push(
            order["recipients"][0]["items"][1].clone()
        );
        frozen["workflow"]["shipments"][0]["charges"]["STORE"]=json!(2500);
        assert_eq!(run("calculate_shipment_totals",
            json!({"state":frozen,"shipmentId":"shipment:o1:r1"})),
            json!({"subtotal":60000,"shipping":5500,"vat":6550,"total":72050}));
        frozen["orders"][0]["freightCode"]=json!("020");
        assert_eq!(run("calculate_shipment_totals",
            json!({"state":frozen,"shipmentId":"shipment:o1:r1"}))["total"],66000);
    }
    #[test]
    fn product_specific_freight_rule_applies_without_group() {
        let mut state=shipping_state();
        state["products"][0]["shippingGroupId"]=Value::Null;
        state["shipping"]["productRules"]["p1"]=json!({
            "version":"product-override-1","fees":{"1":8000},
            "maxBundle":null,"maxConfirmed":false,"perItem":null
        });
        let quote=run("calculate_shipping",json!({
            "state":state,"order":order(1,json!(30000))
        }));
        assert_eq!(quote["total"],8000);
        assert_eq!(quote["bundles"][0]["versions"]["product:p1"],"product-override-1");
    }

    #[test]
    fn account_change_downgrades_released_notice_and_rechecks_payment() {
        let mut before=workflow_state("PREPAID");
        before["settings"]["accounts"].as_array_mut().unwrap().push(json!({
            "id":"account-2","bank":"가상은행","number":"999-888","holder":"가상상호"
        }));
        before["workflow"]["confirmations"]=json!([{
            "id":"confirm-1","groupId":"group:o1","dealerId":"dealer-1",
            "shipmentIds":["shipment:o1:r1"],"amount":36300,
            "confirmedAt":"2026-11-13T09:00:00+09:00","actor":"직원",
            "announcedAccount":{"id":"account-1","bank":"가상은행",
                "number":"123-456","holder":"가상상호"},
            "allocations":[{"shipmentId":"shipment:o1:r1","amount":36300}]
        }]);
        let result=run("apply_workflow_action",json!({
            "state":before,"action":"set_group_account","groupId":"group:o1",
            "accountId":"account-2","eventId":"event-1",
            "now":"2026-11-13T12:00:00+09:00"
        }));
        assert_eq!(result["accountMode"],"MANUAL");
        assert_eq!(result["accountId"],"account-2");
        assert_eq!(result["state"]["orders"][0]["groupAccounts"]["group:o1"]["id"],"account-2");
        assert_eq!(result["state"]["workflow"]["shipments"][0]["step"],2);
        assert_eq!(result["state"]["workflow"]["groups"][0]["needsNotice"],true);
        assert_eq!(result["state"]["workflow"]["events"].as_array().unwrap().len(),3);
        assert_eq!(result["state"]["workflow"]["events"][0]["action"],"입금 승인 재확인 필요");
        assert_eq!(result["state"]["workflow"]["events"][1]["action"],"재검증 필요");
        assert_eq!(result["state"]["workflow"]["events"][2]["action"],"묶음 입금 계좌 변경");
        assert_eq!(result["state"]["workflow"]["confirmations"][0],
            before["workflow"]["confirmations"][0]);
        assert_eq!(result["state"]["orders"][0]["raw"],before["orders"][0]["raw"]);
    }

    #[test]
    fn factory_reply_dispatch_completion_requires_tracking_and_actual_freight() {
        let mut state=workflow_state("POSTPAID");
        let view=|state:&Value|run("evaluate_dispatch_state",json!({"state":state,"orderId":"o1"}));
        assert_eq!(view(&state)["status"],"처리 중");
        state["workflow"]["shipments"][0]["tracking"]=json!({"FACTORY":"123456789"});
        assert_eq!(view(&state)["status"],"처리 중");
        state["workflow"]["shipments"][0]["actualFreight"]=json!({"FACTORY":4200});
        assert_eq!(view(&state)["status"],"처리 완료");
        state["orders"][0]["recipients"][0]["items"][0]["origin"]=json!("STORE");
        assert_eq!(view(&state)["status"],"처리 중");
        state["workflow"]["shipments"][0]["tracking"]["STORE"]=json!("987654321");
        state["workflow"]["shipments"][0]["actualFreight"]["STORE"]=json!(2500);
        assert_eq!(view(&state)["status"],"처리 완료");
    }

    #[test]
    fn completed_delivery_records_actual_tariff_observation_and_retains_snapshot() {
        let mut before=workflow_state("POSTPAID");
        before["shipping"]=shipping_state()["shipping"].clone();
        before["workflow"]["shipments"][0]["transferred"]=json!(true);
        before["workflow"]["queue"]=json!([{
            "id":"excel:shipment:o1:r1:FACTORY","shipmentId":"shipment:o1:r1",
            "origin":"FACTORY","status":"EXPORTED","fileOnly":false,
            "snapshot":{"total":36300,"shipping":3000,"vat":3300,
                "subtotal":30000,"freightCode":"010"}
        }]);
        let result=run("apply_workflow_action",json!({
            "state":before,"action":"complete_delivery",
            "shipmentId":"shipment:o1:r1","actual":{"FACTORY":4200},
            "combinationIds":["combination-1"],"deliveryIds":["delivery-1"],
            "eventId":"event-1","now":"2026-11-13T13:00:00+09:00"
        }));
        assert_eq!(result["completed"],true);
        assert_eq!(result["state"]["workflow"]["shipments"][0]["delivery"]["recordIds"][0],
            "combination-1");
        assert_eq!(result["state"]["shipping"]["combinations"][0]["charge"],4200);
        assert_eq!(result["state"]["shipping"]["combinations"][0]["observedCharge"],3000);
        assert_eq!(result["state"]["workflow"]["deliveries"][0]["actual"],4200);
        assert_eq!(result["state"]["workflow"]["deliveries"][0]["charge"],3000);
        assert_eq!(result["state"]["workflow"]["queue"][0]["snapshot"]["total"],36300);
        assert_eq!(result["state"]["workflow"]["events"][0]["action"],"실제 배송 완료 / 운임 검증");
        assert_eq!(run("validate_workflow",json!({"state":result["state"],"before":before}))["valid"],true);
    }
    #[test]
    fn queued_or_file_only_excel_cannot_claim_delivery_completion() {
        let mut state=workflow_state("POSTPAID");
        state["shipping"]=shipping_state()["shipping"].clone();
        state["workflow"]["shipments"][0]["transferred"]=json!(true);
        state["workflow"]["queue"]=json!([{
            "id":"queued","shipmentId":"shipment:o1:r1","origin":"FACTORY",
            "status":"QUEUED","fileOnly":false
        }]);
        let make=|state:&Value|json!({
            "state":state,"action":"complete_delivery","shipmentId":"shipment:o1:r1",
            "actual":{"FACTORY":4200},"combinationIds":["combo-1"],
            "deliveryIds":["delivery-1"],"eventId":"event-1",
            "now":"2026-11-13T13:00:00+09:00"
        });
        assert!(execute("apply_workflow_action",make(&state)).is_err());
        state["workflow"]["queue"][0]["status"]=json!("EXPORTED");
        state["workflow"]["queue"][0]["fileOnly"]=json!(true);
        assert!(execute("apply_workflow_action",make(&state)).is_err());
    }

    #[test]
    fn freight_change_preserves_existing_payment_approval_and_rechecks() {
        let mut state=workflow_state("PREPAID");
        state["workflow"]["confirmations"]=json!([{
            "id":"confirmation-1","groupId":"group:o1","dealerId":"dealer-1",
            "shipmentIds":["shipment:o1:r1"],"amount":36300,
            "confirmedAt":"2026-11-13T09:00:00+09:00","actor":"직원",
            "allocations":[{"shipmentId":"shipment:o1:r1","amount":36300}]
        }]);
        let updated=run("apply_workflow_action",json!({
            "state":state,"action":"set_shipment_freight",
            "shipmentId":"shipment:o1:r1","origin":"FACTORY","value":7000,
            "eventId":"event-1","now":"2026-11-13T13:30:00+09:00"
        }));
        assert_eq!(updated["state"]["workflow"]["shipments"][0]["step"],1);
        assert_eq!(updated["state"]["workflow"]["events"].as_array().unwrap().len(),3);
        assert_eq!(updated["state"]["workflow"]["events"][0]["action"],"입금 승인 재확인 필요");
        assert_eq!(updated["state"]["workflow"]["events"][1]["action"],"재검증 필요");
        assert_eq!(updated["state"]["workflow"]["events"][2]["action"],"배송 건 운임 수정");
        assert_eq!(updated["state"]["workflow"]["confirmations"][0],
            state["workflow"]["confirmations"][0]);
        assert_eq!(run("validate_workflow",json!({"state":updated["state"],"before":state}))["valid"],true);
    }


    fn two_shipments_in_one_group() -> Value {
        let mut state=workflow_state("POSTPAID");
        let mut second_recipient=state["orders"][0]["recipients"][0].clone();
        second_recipient["id"]=json!("r2");
        second_recipient["name"]=json!("가상 수취인 2");
        second_recipient["items"][0]["id"]=json!("item2");
        state["orders"][0]["recipients"].as_array_mut().unwrap().push(second_recipient);
        let mut second_shipment=state["workflow"]["shipments"][0].clone();
        second_shipment["id"]=json!("shipment:o1:r2");
        second_shipment["recipientId"]=json!("r2");
        state["workflow"]["shipments"].as_array_mut().unwrap().push(second_shipment);
        state
    }

    #[test]
    fn detaching_shipment_preserves_step_account_and_notices() {
        let mut state=two_shipments_in_one_group();
        state["workflow"]["groups"][0]["notices"]=json!([{
            "id":"notice-1","at":"2026-11-13T09:00:00+09:00",
            "actor":"직원","shipmentIds":["shipment:o1:r1","shipment:o1:r2"],
            "amounts":{"shipment:o1:r1":36300,"shipment:o1:r2":36300},
            "total":72600,"account":{"id":"account-1","bank":"가상은행",
                "number":"123-456","holder":"가상상호"},"message":"가상 안내"
        }]);
        let before=state.clone();
        let moved=run("apply_workflow_action",json!({
            "state":state,"action":"detach_shipment","shipmentId":"shipment:o1:r1",
            "newGroupId":"split-1","eventId":"event-split",
            "now":"2026-11-13T14:00:00+09:00"
        }));
        let w=&moved["state"]["workflow"];
        assert_eq!(w["groups"].as_array().unwrap().len(),2);
        assert_eq!(w["shipments"][0]["groupId"],"split-1");
        assert_eq!(w["shipments"][0]["step"],before["workflow"]["shipments"][0]["step"]);
        assert_eq!(w["shipments"][1]["groupId"],"group:o1");
        assert_eq!(w["groups"][1]["rootGroupId"],before["workflow"]["groups"][0]["rootGroupId"]);
        assert_eq!(w["groups"][1]["accountMode"],"MANUAL");
        assert_eq!(w["groups"][1]["accountId"],"account-1");
        assert_eq!(w["groups"][1]["notices"],json!([]));
        assert_eq!(w["groups"][0]["notices"],before["workflow"]["groups"][0]["notices"]);
        assert_eq!(w["groups"][0]["needsNotice"],true);
        assert_eq!(w["groups"][1]["needsNotice"],true);
        assert_eq!(w["events"][0]["action"],"묶음 해제");
        assert_eq!(w["events"][0]["before"],"group:o1");
        assert_eq!(w["events"][0]["after"],"split-1");
    }

    #[test]
    fn regroup_requires_ack_for_existing_notice_and_preserves_payment_evidence() {
        let mut state=two_shipments_in_one_group();
        let moved=run("apply_workflow_action",json!({
            "state":state,"action":"detach_shipment","shipmentId":"shipment:o1:r1",
            "newGroupId":"split-1","eventId":"event-1",
            "now":"2026-11-13T14:00:00+09:00"
        }));
        state=moved["state"].clone();
        let request=|ack:bool|json!({
            "state":state,"action":"regroup_shipment","shipmentId":"shipment:o1:r1",
            "targetGroupId":"group:o1","ack":ack,"eventId":"event-2",
            "now":"2026-11-13T14:05:00+09:00"
        });
        assert!(execute("apply_workflow_action",request(false)).unwrap_err()
            .contains("승인하세요"));
        let joined=run("apply_workflow_action",request(true));
        let w=&joined["state"]["workflow"];
        assert_eq!(w["shipments"][0]["groupId"],"group:o1");
        assert_eq!(w["shipments"][0]["step"],3);
        assert_eq!(w["groups"][0]["needsNotice"],true);
        assert_eq!(w["groups"][1]["needsNotice"],true);
        assert_eq!(w["events"][1]["action"],"다시 묶기");
        assert_eq!(w["events"][1]["before"],"split-1");
        assert_eq!(w["events"][1]["after"],"group:o1");
        assert_eq!(w["events"][1]["reason"],"배송 ID / 단계 / 입금 배분 유지");
        assert_eq!(w["payments"],json!([]));
    }

    #[test]
    fn regroup_rejects_transferred_or_mismatched_stage_without_partial_mutation() {
        let moved=run("apply_workflow_action",json!({
            "state":two_shipments_in_one_group(),"action":"detach_shipment",
            "shipmentId":"shipment:o1:r1","newGroupId":"split-1",
            "eventId":"event-1","now":"2026-11-13T14:00:00+09:00"
        }));
        let state=moved["state"].clone();
        let make=|s:Value|json!({
            "state":s,"action":"regroup_shipment","shipmentId":"shipment:o1:r1",
            "targetGroupId":"group:o1","ack":true,"eventId":"event-2",
            "now":"2026-11-13T14:05:00+09:00"
        });
        let mut wrong_step=state.clone();
        wrong_step["workflow"]["shipments"][1]["step"]=json!(2);
        assert!(execute("apply_workflow_action",make(wrong_step)).unwrap_err().contains("진행 단계"));
        let mut transferred=state.clone();
        transferred["workflow"]["shipments"][1]["transferred"]=json!(true);
        assert!(execute("apply_workflow_action",make(transferred)).unwrap_err().contains("진행 단계"));
        let mut different_dealer=state;
        different_dealer["workflow"]["groups"][1]["dealerId"]=json!("other-dealer");
        assert!(execute("apply_workflow_action",make(different_dealer)).unwrap_err()
            .contains("같은 최초 발주서"));
    }


    #[test]
    fn tariff_basis_rollover_preserves_history_and_invalidates_old_versions() {
        let old=shipping_state()["shipping"].clone();
        let result=run("apply_shipping_action",json!({
            "action":"change_basis","shipping":old,
            "groupVersions":{"music":"v2"},"productVersions":{},
            "now":"2026-11-13T15:00:00+09:00"
        }));
        let next=&result["shipping"];
        assert_eq!(next["epoch"],8);
        assert_eq!(next["groups"][0]["history"][0],old["groups"][0]["current"]);
        assert_eq!(next["groups"][0]["current"]["version"],"v2");
        assert!(next["groups"][0]["current"]["fees"]["1"].is_null());
        assert!(next["groups"][0]["current"]["fees"]["2"].is_null());
        assert_eq!(next["groups"][0]["current"]["notes"],"새 기준의 운임 확인 필요");
        let old_rate=run("apply_shipping_action",json!({
            "action":"combination_current","combination":{
                "id":"old","key":"FACTORY|p1@v1:1","epoch":7,
                "active":true,
                "versions":{"assignment:p1":"music","group:music":"v1"}
            },
            "state":{"shipping":next,"products":[product()]}
        }));
        assert_eq!(old_rate["current"],false);
        let new_rate=run("apply_shipping_action",json!({
            "action":"combination_current","combination":{
                "id":"fresh","key":"FACTORY|p1@v1:1","epoch":8,
                "active":true,
                "versions":{"assignment:p1":"music","group:music":"v2"}
            },
            "state":{"shipping":next,"products":[product()]}
        }));
        assert_eq!(new_rate["current"],true);
    }

    #[test]
    fn save_combination_archives_previous_without_changing_charged_shipments() {
        let mut shipping=shipping_state()["shipping"].clone();
        shipping["combinations"]=json!([{
            "id":"old","key":"FACTORY|p1@v1:1","active":true,
            "charge":3000,"epoch":7,"versions":{"group:music":"v1"},
            "at":"2026-11-13T08:00:00+09:00"
        }]);
        let saved=run("apply_shipping_action",json!({
            "action":"save_combination","shipping":shipping,
            "bundle":{"key":"FACTORY|p1@v1:1",
                "description":"가상 묶음",
                "versions":{"assignment:p1":"music","group:music":"v1"}},
            "charge":4250,"actual":4000,
            "combinationId":"new","now":"2026-11-13T15:00:00+09:00"
        }));
        assert_eq!(saved["shipping"]["combinations"][0]["active"],false);
        assert_eq!(saved["shipping"]["combinations"][0]["charge"],3000);
        assert_eq!(saved["shipping"]["combinations"][1]["active"],true);
        assert_eq!(saved["shipping"]["combinations"][1]["charge"],4250);
        assert_eq!(saved["shipping"]["combinations"][1]["actual"],4000);
        assert_eq!(saved["shipping"]["combinations"][1]["epoch"],7);
        assert!(execute("apply_shipping_action",json!({
            "action":"save_combination","shipping":shipping,
            "bundle":{"key":"FACTORY|p1@v1:1"},"charge":-1,
            "combinationId":"x","now":"2026-11-13T15:00:00+09:00"
        })).is_err());
    }

    #[test]
    fn delete_shipping_group_requires_detach_and_deactivates_prior_combinations() {
        let mut state=shipping_state();
        state["shipping"]["combinations"]=json!([{
            "id":"combo-1","key":"FACTORY|p1@v1:1","active":true,"epoch":7,
            "versions":{"group:music":"v1"},"charge":3000
        }]);
        let args=|detach:bool|json!({
            "action":"delete_group","state":state,"groupId":"music",
            "detach":detach,"now":"2026-11-13T15:00:00+09:00"
        });
        assert!(execute("apply_shipping_action",args(false)).unwrap_err()
            .contains("사용 중인 상품: 가상 상품"));
        let result=run("apply_shipping_action",args(true));
        assert_eq!(result["state"]["shipping"]["groups"][0]["deletedAt"],
            "2026-11-13T15:00:00+09:00");
        assert!(result["state"]["products"][0].get("shippingGroupId").is_none());
        assert_eq!(result["state"]["shipping"]["combinations"][0]["active"],false);
    }

    #[test]
    fn legacy_per_item_rule_converts_to_independent_single_bundle_rate() {
        let mut rule=shipping_state()["shipping"]["groups"][0]["current"].clone();
        rule["perItem"]=json!(5000);
        let result=run("apply_shipping_action",json!({
            "action":"editable_rule","rule":rule
        }));
        assert_eq!(result["rule"]["fees"]["1"],5000);
        assert_eq!(result["rule"]["maxBundle"],1);
        assert_eq!(result["rule"]["maxConfirmed"],true);
        assert!(result["rule"]["perItem"].is_null());
    }

    #[test]
    fn shipping_combination_versions_use_active_assignment() {
        let r=run("apply_shipping_action",json!({
            "action":"combination_versions","key":"FACTORY|p1@v1:2",
            "state":shipping_state()
        }));
        assert_eq!(r["versions"],
            json!({"assignment:p1":"music","group:music":"v1"}));
    }


    #[test]
    fn exported_factory_staff_confirmation_is_metadata_only() {
        let mut before=workflow_state("POSTPAID");
        before["workflow"]["queue"]=json!([{
            "id":"excel-1","shipmentId":"shipment:o1:r1",
            "origin":"FACTORY","status":"EXPORTED","fileOnly":true,
            "snapshot":{"total":36300}
        }]);
        let mut after=before.clone();
        after["workflow"]["queue"][0]["fileOnly"]=json!(false);
        after["workflow"]["queue"][0]["factoryDeliveredAt"]=json!("2026-11-13T15:00:00+09:00");
        after["workflow"]["events"].as_array_mut().unwrap().push(json!({
            "id":"event-1","action":"공장 전달 직원 확인",
            "at":"2026-11-13T15:00:00+09:00","actor":"직원",
            "shipmentIds":["shipment:o1:r1"]
        }));
        assert_eq!(run("validate_workflow",json!({
            "state":after,"before":before
        }))["valid"],true);
        let mut forged=after.clone();
        forged["workflow"]["events"]=json!([]);
        assert!(execute("validate_workflow",json!({
            "state":forged,"before":before
        })).is_err());
    }

    #[test]
    fn printed_file_disposal_requires_matching_historical_export_snapshot() {
        let mut before=workflow_state("POSTPAID");
        before["workflow"]["queue"]=json!([{
            "id":"excel-1","shipmentId":"shipment:o1:r1",
            "origin":"FACTORY","status":"EXPORTED","fileOnly":true,
            "snapshot":{"total":36300}
        }]);
        let mut after=before.clone();
        after["workflow"]["queue"][0]["status"]=json!("CANCELLED");
        after["workflow"]["events"].as_array_mut().unwrap().push(json!({
            "id":"event-discard","action":"전달 전 출력본 폐기 / 재작성",
            "at":"2026-11-13T15:00:00+09:00","actor":"직원",
            "shipmentIds":["shipment:o1:r1"]
        }));
        after["exports"]=json!([{
            "id":"export-1","snapshots":[before["workflow"]["queue"][0]]
        }]);
        assert_eq!(run("validate_workflow",json!({
            "state":after,"before":before
        }))["valid"],true);
        after["exports"][0]["snapshots"][0]["snapshot"]["total"]=json!(1);
        assert!(execute("validate_workflow",json!({
            "state":after,"before":before
        })).is_err());
    }

    #[test]
    fn only_untransferred_pre_approval_confirmation_can_be_partially_cancelled() {
        let mut before=two_shipments_in_one_group();
        before["workflow"]["confirmations"]=json!([{
            "id":"confirm-1","groupId":"group:o1","dealerId":"dealer-1",
            "shipmentIds":["shipment:o1:r1","shipment:o1:r2"],
            "amount":72600,"actor":"직원",
            "confirmedAt":"2026-11-13T12:00:00+09:00",
            "announcedAccount":{"id":"account-1","bank":"가상은행",
                "number":"123-456","holder":"가상상호"},
            "amounts":{"shipment:o1:r1":36300,"shipment:o1:r2":36300},
            "allocations":[{"shipmentId":"shipment:o1:r1","amount":36300},
                {"shipmentId":"shipment:o1:r2","amount":36300}]
        }]);
        let mut after=before.clone();
        after["workflow"]["confirmations"][0]["shipmentIds"]=json!(["shipment:o1:r2"]);
        after["workflow"]["confirmations"][0]["allocations"]=json!([
            {"shipmentId":"shipment:o1:r2","amount":36300}
        ]);
        after["workflow"]["confirmations"][0]["amounts"]=json!({"shipment:o1:r2":36300});
        after["workflow"]["confirmations"][0]["amount"]=json!(36300);
        assert_eq!(run("validate_workflow",json!({
            "state":after,"before":before
        }))["valid"],true);
        let mut forbidden=after.clone();
        forbidden["workflow"]["shipments"][0]["step"]=json!(4);
        assert!(execute("validate_workflow",json!({
            "state":forbidden,"before":before
        })).unwrap_err().contains("확인 기록"));
    }

    #[test]
    fn actual_freight_audit_must_prove_the_original_value() {
        let before=workflow_state("POSTPAID");
        let recorded=run("apply_workflow_action",json!({
            "state":before,"shipmentId":"shipment:o1:r1","origin":"FACTORY",
            "action":"record_actual_freight","value":4200,
            "eventId":"event-1","now":"2026-11-13T15:00:00+09:00"
        }));
        let mut forged=recorded["state"].clone();
        forged["workflow"]["events"][0]["before"]=json!(999);
        assert!(execute("validate_workflow",json!({
            "state":forged,"before":before
        })).unwrap_err().contains("수정 근거"));
    }

}
