// This test crate compiles and exercises the real production recognition module.
// No duplicate or mock recognition implementation is used here.
#[path = "../../../../src-tauri/src/business_core/recognition/mod.rs"]
pub mod recognition;

#[cfg(test)]
mod regressions {
    use super::recognition;
    use serde_json::{json, Value};

    fn seed() -> Value {
        serde_json::from_str(include_str!(
            "../../../../src-tauri/resources/state-seed.json"
        )).expect("committed seed state")
    }

    fn samples() -> Vec<Value> {
        // Reuse the original untouched 20-order audit inputs and expected values.
        // The samples are a strict JSON array embedded in the JS test file.
        let fixture = include_str!("../../../audit-20-order-samples.test.mjs");
        let start = fixture.find("const samples=[").expect("samples declaration")
            + "const samples=".len();
        let end = fixture[start..].find("\n];").expect("end of sample array") + start + 2;
        let all: Vec<Value> = serde_json::from_str(&fixture[start..end])
            .expect("20 original sample records");
        assert_eq!(all.len(), 20);
        all
    }

    fn verify(id: usize) {
        let samples = samples();
        let case = &samples[id - 1];
        let raw = case["raw"].as_str().expect("sample raw");
        let state = seed();
        let client = json!({"id":"ci-dealer","name":"가상거래처","tier":"wholesale",
            "overrides":{},"active":true,"payment":"PREPAID"});
        let result = recognition::execute("analyze_order",json!({
            "raw":raw,"client":client,"state":state
        })).expect("recognition execution");
        let recipients = result["recipients"].as_array().expect("recipients");
        assert_eq!(recipients.len(),case["expectedRecipients"].as_u64().unwrap() as usize,
            "order {id}: delivery count, full response {result}");
        let mut got: Vec<String> = recipients.iter().flat_map(|r|
            r["items"].as_array().into_iter().flatten()
                .map(|item| item["quantity"].to_string())).collect();
        let mut expected: Vec<String> = case["expectedQuantities"]
            .as_array().unwrap().iter().map(Value::to_string).collect();
        got.sort();
        expected.sort();
        assert_eq!(got,expected,"order {id}: quantities or product ownership, {result}");

        if id == 6 {
            assert_eq!(recipients[0]["items"][0]["quantityConfirmed"],false,
                "unwritten quantity must stay unconfirmed");
        }
        if id == 18 {
            let item=&recipients[0]["items"][0];
            let product_name=item["name"].as_str().unwrap_or("");
            assert!(item["productId"].is_null() ||
                product_name.contains("비타공") || product_name.contains("무타공"),
                "709 민판 must not select a perforated SKU");
            assert_eq!(recipients[0]["name"],"이가상");
        }
        let expected_names = match id {
            5 => Some(vec!["정가상"]),
            16 => Some(vec!["배가상"]),
            17 => Some(vec!["김가상","박가상"]),
            _ => None,
        };
        if let Some(names)=expected_names {
            let actual:Vec<_>=recipients.iter().map(|r|r["name"].as_str().unwrap_or("")).collect();
            assert_eq!(actual,names,"order {id}: institution/name boundary");
            assert!(recipients.iter().all(|r|r["address"].as_str()
                .map_or(false,|v|!v.is_empty()) && (
                !r["phone"].as_str().unwrap_or("").is_empty() ||
                !r["mobile"].as_str().unwrap_or("").is_empty())),
                "order {id}: recipient lost its address or contact");
        }
        if id==19 || id==20 {
            assert_eq!(recipients.len(),1,"tabular order must not split a delivery");
        }
    }

    macro_rules! case {
        ($fn_name:ident,$number:literal) => {
            #[test] fn $fn_name() { verify($number); }
        }
    }
    case!(order_01,1);
    case!(order_02,2);
    case!(order_03,3);
    case!(order_04,4);
    case!(order_05,5);
    case!(order_06,6);
    case!(order_07,7);
    case!(order_08,8);
    case!(order_09,9);
    case!(order_10,10);
    case!(order_11,11);
    case!(order_12,12);
    case!(order_13,13);
    case!(order_14,14);
    case!(order_15,15);
    case!(order_16,16);
    case!(order_17,17);
    case!(order_18,18);
    case!(order_19,19);
    case!(order_20,20);

    #[test]
    fn an_explicitly_unregistered_color_does_not_select_black() {
        let state=json!({"products":[{
            "id":"only-black","name":"709 / 타공 상판","category":"보면대",
            "origin":"FACTORY","active":true,
            "variants":[{"id":"black","color":"Black"}]
        }],"aliases":[]});
        let result=recognition::execute("match_products",json!({
            "text":"709 그레이","state":state
        })).unwrap();
        assert_eq!(result["productId"],Value::Null);
    }

    #[test]
    fn other_model_families_do_not_inherit_music_stand_minus_one_rules() {
        let state=json!({"products":[
            {"id":"gt","name":"GT-1 / 기타 스탠드","category":"기타",
             "origin":"FACTORY","active":true,
             "variants":[{"id":"vgt","color":"Black"}]},
            {"id":"cart10","name":"Cart-10 / 보면대 카트","category":"악세사리",
             "origin":"FACTORY","active":true,
             "variants":[{"id":"vc10","color":"Black"}]},
            {"id":"cart20","name":"Cart-20 / 보면대 카트","category":"악세사리",
             "origin":"FACTORY","active":true,
             "variants":[{"id":"vc20","color":"Black"}]}
        ],"aliases":[]});
        let gt=recognition::execute("match_products",json!({"text":"GT-1","state":state})).unwrap();
        assert_eq!(gt["productId"],"gt");
        let cart=recognition::execute("match_products",json!({"text":"Cart-10","state":state})).unwrap();
        assert_eq!(cart["productId"],"cart10");
    }

    #[test]
    fn conflicting_alias_does_not_override_registered_sku() {
        let state=json!({"products":[
            {"id":"p709","name":"709 / 타공 상판","category":"보면대",
             "origin":"FACTORY","active":true,
             "variants":[{"id":"v709","color":"Black"}]},
            {"id":"other","name":"독립 상품 / 거치대","category":"액세서리",
             "origin":"STORE","active":true,
             "variants":[{"id":"vother","color":"Black"}]}
        ],"aliases":[{"id":"a1","clientId":null,"text":"709","productId":"other"}]});
        let outcome=recognition::execute("match_products",json!({"text":"709","state":state})).unwrap();
        assert_eq!(outcome["productId"],Value::Null);
        assert_eq!(outcome["match"]["kind"],"CONFLICT");
    }

    #[test]
    fn two_recipient_product_ownership_uses_original_evidence_order() {
        // Source: audit-20-order-samples.test.mjs, sample 13.
        // A SKU preceding the first address belongs to its following
        // recipient; the next SKU belongs to the following recipient.
        let case=&samples()[12];
        let result=recognition::execute("analyze_order",json!({
            "raw":case["raw"],"state":seed()
        })).expect("sample 13");
        let rows=result["recipients"].as_array().expect("recipients");
        assert_eq!(rows.len(),2);
        assert_eq!(rows[0]["name"],"장가상");
        assert_eq!(rows[1]["name"],"정가상");
        assert_eq!(rows[0]["items"].as_array().unwrap().len(),1);
        assert_eq!(rows[1]["items"].as_array().unwrap().len(),1);
        assert_eq!(rows[0]["items"][0]["quantity"],2);
        assert!(rows[0]["items"][0]["raw"].as_str().unwrap().contains("SSB"));
        assert_eq!(rows[1]["items"][0]["quantity"],1);
        assert!(rows[1]["items"][0]["raw"].as_str().unwrap().contains("705"));
    }

    #[test]
    fn tabular_orders_preserve_exact_utf16_evidence_spans() {
        // Source: parser.ts + order-evidence.ts, 19/20.
        // Every returned source/candidate must point into the untouched raw
        // UTF-16 string, not a reconstructed table cell.
        for id in [19_usize,20] {
            let case=&samples()[id-1];
            let raw=case["raw"].as_str().unwrap();
            let original:Vec<u16>=raw.encode_utf16().collect();
            let output=recognition::execute("analyze_order",json!({
                "raw":raw,"state":seed()
            })).expect("tabular recognition");
            let mut checked=0;
            for candidate in output["candidates"].as_array().unwrap() {
                let start=candidate["start"].as_u64().unwrap() as usize;
                let end=candidate["end"].as_u64().unwrap() as usize;
                assert!(start<=end && end<=original.len(),"order {id}: invalid candidate bounds");
                let original_text=String::from_utf16(&original[start..end]).unwrap();
                assert_eq!(original_text,candidate["text"],"order {id}: candidate source was shifted");
                checked+=1;
            }
            for row in output["recipients"].as_array().unwrap() {
                for item in row["items"].as_array().unwrap() {
                    for source in item["sources"].as_array().unwrap() {
                        let start=source["start"].as_u64().unwrap() as usize;
                        let end=source["end"].as_u64().unwrap() as usize;
                        assert!(start<=end && end<=original.len(),"order {id}: bad item span");
                        assert_eq!(String::from_utf16(&original[start..end]).unwrap(),
                            source["text"],"order {id}: source must equal original bytes in UTF-16");
                    }
                }
            }
            assert!(checked>0,"order {id} must retain evidence");
        }
    }

    #[test]
    fn old_false_manual_flag_does_not_block_reanalysis() {
        let state=json!({"products":[],"aliases":[]});
        let order=json!({
            "raw":"고객정보\n이가상\n경기도 의정부시 시민로 100",
            "manualClassification":false,
            "recipients":[],
            "analysisEvidence":[]
        });
        let result=recognition::execute("reanalyze_order",json!({
            "order":order,"state":state
        })).expect("reanalyze false manual flag");
        assert!(!result["recipients"].as_array().unwrap().is_empty());
    }

    #[test]
    fn a_negative_quantity_never_becomes_approved() {
        let state=json!({"products":[],"aliases":[]});
        let result=recognition::execute("analyze_order",json!({
            "raw":"미확정 보면대 -1개","state":state
        })).unwrap();
        let first=&result["recipients"][0]["items"][0];
        assert_eq!(first["quantityConfirmed"],false);
    }
}
