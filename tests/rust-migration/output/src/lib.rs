#[path = "../../../../src-tauri/src/business_core/output/mod.rs"]
pub mod output;

#[cfg(test)]
mod tests {
    use super::output;
    use serde_json::{json, Value};

    fn item(origin: &str) -> Value {
        json!({
            "id":"item-1","origin":origin,"name":"BD 709 타공 상판 가방 미포함",
            "productId":"product-1","variantId":"price-1",
            "quantity":2,"color":"블랙"
        })
    }
    fn state(origin: &str) -> Value {
        json!({
            "revision":7,
            "orders":[{"id":"order-1"}],
            "products":[{"id":"product-1","name":"BD 709 타공 상판 가방 미포함",
                "variants":[{"id":"price-1","color":"블랙"}]}],
            "exports":[],
            "workflow":{
                "shipments":[{"id":"shipment-1","orderId":"order-1","step":4,
                    "transferred":true,"legacyArchived":false}],
                "queue":[{"id":"queue-1","shipmentId":"shipment-1",
                    "origin":origin,"status":"QUEUED",
                    "snapshot":{"freightCode":"010","recipient":{
                        "name":"김민수","address":"서울 종로구 123",
                        "phone":"02-123-4567","mobile":"","note":"문 앞",
                        "items":[item(origin)]
                    },"sender":{
                        "name":"대리점","displayName":"대리점 송장상호",
                        "address":"서울 중구 88","postcode":"04500",
                        "phone":"02-456-7890","mobile":""
                    }}}
                ],
                "payments":[],"confirmations":[],"events":[]
            }
        })
    }
    #[test]
    fn factory_preserves_immutable_identifiers_and_logen_columns() {
        let preview = output::execute("prepare_factory_export",
            json!({"state":state("FACTORY"),"ids":["queue-1"]})).unwrap();
        assert_eq!(preview["revision"],7);
        let values = preview["rows"][0]["values"].as_array().unwrap();
        assert_eq!(values.len(),16);
        assert_eq!(values[0],"김민수");
        assert_eq!(values[1],"");
        assert_eq!(values[5],""); // Package quantity is filled by the factory.
        assert_eq!(values[6],""); // Actual postage is filled by the factory.
        assert_eq!(values[7],"010");
        assert_eq!(values[8],"◆ BD 709 타공 상판 가방 미포함 2개");
        assert_eq!(values[11],"대리점 송장상호");
        assert_eq!(values[12],"04500");
    }
    #[test]
    fn store_product_separator_and_color_preserved() {
        let mut state = state("STORE");
        state["workflow"]["queue"][0]["snapshot"]["recipient"]["items"]
            .as_array_mut().unwrap().push(json!({
                "origin":"STORE","name":"SS-1","quantity":1,"color":"단일"
            }));
        let preview = output::execute("prepare_store_export",
            json!({"state":state,"ids":["queue-1"]})).unwrap();
        assert_eq!(preview["rows"][0]["values"][8],
            "BD 709 타공 상판 가방 미포함 블랙 2개 / SS-1 1개");
    }
    #[test]
    fn duplicate_selection_and_wrong_freight_are_blocked() {
        let s = state("FACTORY");
        assert!(output::execute("prepare_factory_export",
            json!({"state":s,"ids":["queue-1","queue-1"]})).unwrap_err().contains("중복"));
        let mut s = state("FACTORY");
        s["workflow"]["queue"][0]["snapshot"]["freightCode"] = json!("002");
        assert!(output::execute("prepare_factory_export",
            json!({"state":s,"ids":["queue-1"]})).unwrap_err().contains("운임구분"));
    }
    #[test]
    fn frozen_option_conflict_fails_instead_of_silently_correcting() {
        let mut s = state("FACTORY");
        s["workflow"]["queue"][0]["snapshot"]["recipient"]["items"][0]["name"] =
            json!("BD 709 비타공 상판 가방 포함");
        let error = output::execute("prepare_factory_export",
            json!({"state":s,"ids":["queue-1"]})).unwrap_err();
        assert!(error.contains("가방") || error.contains("상판"));
    }
    #[test]
    fn historical_product_mapping_requires_both_original_ids() {
        let mut s = state("FACTORY");
        s["products"][0]["id"]=json!("product-new");
        s["products"][0]["sourceProductId"]=json!("product-1");
        s["productMappings"] = json!({"product-1|price-1":"product-new"});
        assert!(output::execute("prepare_factory_export",
            json!({"state":s,"ids":["queue-1"]})).is_ok());
        let mut s = state("FACTORY");
        s["products"][0]["id"]=json!("product-new");
        s["products"][0]["sourceProductId"]=json!("product-1");
        s["productMappings"]=json!({"product-1|different":"product-new"});
        assert!(output::execute("prepare_factory_export",
            json!({"state":s,"ids":["queue-1"]})).is_err());
    }
    #[test]
    fn templates_keep_custom_values_and_forbid_removed_required_variables() {
        let result = output::execute("render_messages",json!({
            "mode":"template","templateId":"modelConfirm",
            "settings":{"automaticMessageTemplates":{"modelConfirm":"{상품명}으로 보내드릴까요?"}},
            "values":{"상품명":"BD 709"}
        })).unwrap();
        assert_eq!(result["text"],"BD 709으로 보내드릴까요?");
        let bad = output::execute("render_messages",json!({
            "mode":"validate_templates",
            "settings":{"automaticMessageTemplates":{"modelConfirm":"확인 부탁드립니다."}}
        }));
        assert!(bad.is_err());
    }
    #[test]
    fn payment_places_optional_guidance_after_amount_and_before_official_link() {
        let result = output::execute("render_messages",json!({
            "mode":"payment","settings":{},
            "clientSelected":true,"total":113300,"includeLinks":true,
            "account":{"bank":"국민은행","number":"000-123","holder":"반도"},
            "recipients":[{
                "name":"김민수","freightCode":"010","shipping":3000,
                "applyVat":true,"vat":10300,
                "items":[{
                    "name":"709","color":"Black","amount":100000,"quantity":2,
                    "productId":"p-1","variantId":"v-1",
                    "appliedRepresentativeModel":{"productId":"p-1","productName":"BD 709"},
                    "provisionalNotice":"상판 타입 확인 부탁드립니다.",
                    "url":"https://www.bandostand.com/product/709"
                }]
            }]
        })).unwrap();
        let m = result["payment"].as_str().unwrap();
        assert!(m.contains("BD 709 (블랙) * 2개 : 100,000원"));
        let amount = m.find("합계 : 113,300원").unwrap();
        let notice = m.find("상판 타입 확인 부탁드립니다.").unwrap();
        let link = m.find("https://www.bandostand.com/product/709").unwrap();
        assert!(amount < notice && notice < link);
    }
    #[test]
    fn settlement_does_not_merge_billed_amounts_with_cash_receipts() {
        let mut s = state("STORE");
        s["workflow"]["payments"]=json!([{
            "id":"payment-1","paidAt":"2026-11-13T00:00:00+09:00",
            "dealerId":"client-1","account":{"bank":"국민","holder":"반도","number":"123"},
            "amount":40000,"memo":"","allocations":[{"shipmentId":"shipment-1","amount":40000}]
        }]);
        s["clients"]=json!([{"id":"client-1","name":"대리점"}]);
        let history=json!([{
            "order":{"id":"order-1","createdAt":"2026-11-13T12:00:00+09:00",
                "confirmedAt":"2026-11-13T12:30:00+09:00","orderType":"DEALER",
                "paid":false,"recipients":[{"id":"recipient-1","items":[{"origin":"STORE"}]}]},
            "client":{"name":"대리점","payment":"PREPAID"},
            "billing":{"subtotal":100000,"shipping":3000,"vat":0,"total":103000},
            "shipmentIds":["shipment-1"],"status":"엑셀 추출 대기"
        }]);
        let r=output::execute("prepare_settlement",
            json!({"state":s,"date":"2026-11-13","historyRows":history})).unwrap();
        assert_eq!(r["billedKnown"],103000);
        assert_eq!(r["paidCash"],40000);
        assert_eq!(r["outstandingKnown"],63000);
        assert_eq!(r["paymentRows"][0]["dealer"],"대리점");
    }
}
