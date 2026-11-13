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
    fn a_negative_quantity_never_becomes_approved() {
        let state=json!({"products":[],"aliases":[]});
        let result=recognition::execute("analyze_order",json!({
            "raw":"미확정 보면대 -1개","state":state
        })).unwrap();
        let first=&result["recipients"][0]["items"][0];
        assert_eq!(first["quantityConfirmed"],false);
    }
}
