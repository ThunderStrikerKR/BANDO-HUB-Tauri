//! Shared Rust business core. Business operations compute JSON results;
//! persistence, revision checks, and transactional application remain native
//! Tauri command responsibilities, never implied by a successful calculation.
pub mod recognition;
pub mod rules;
pub mod output;
pub mod catalog_clients;

use serde_json::Value;

/// Single, pure dispatcher used by the native Tauri bridge and integration tests.
/// Recognition: analysis/product selection; rules: pricing, freight and workflow
/// state computations; output: Excel preparation, messages and settlement.
pub fn execute(domain: &str, operation: &str, payload: Value) -> Result<Value, String> {
    match domain {
        "recognition" => recognition::execute(operation, payload),
        "rules" => rules::execute(operation, payload),
        "output" => output::execute(operation, payload),
        "catalog_clients" => catalog_clients::execute(operation, payload),
        _ => Err(format!("지원하지 않는 Rust 업무 영역입니다: {domain}")),
    }
}

#[cfg(test)]
mod integrated_contracts {
    use super::execute;
    use serde_json::json;

    #[test]
    fn recognition_dispatches_a_real_catalog_lookup() {
        let response=execute("recognition","match_products",json!({
            "text":"BD TEST-2",
            "state":{"products":[{
                "id":"p1","name":"BD TEST-2 / 마이크 스탠드",
                "category":"마이크","active":true,
                "variants":[{"id":"v1","color":"Black","wholesale":12000}]
            }],"aliases":[]}
        })).expect("recognition must execute");
        assert_eq!(response["productId"],"p1");
    }

    #[test]
    fn rules_dispatches_actual_price_resolution() {
        let response=execute("rules","resolve_unit_price",json!({
            "product":{"variants":[{"id":"v1","wholesale":12000}]},
            "variantId":"v1",
            "client":{"id":"buyer","tier":"wholesale","overrides":{}}
        })).expect("rules must execute");
        assert_eq!(response["unitPrice"],12000);
    }

    #[test]
    fn output_does_not_dispatch_other_domain_operations() {
        let error=execute("output","resolve_unit_price",json!({}))
            .expect_err("output must not own rules operations");
        assert!(error.contains("지원하지 않는 출력 업무"));
    }

    #[test]
    fn unknown_domain_is_rejected() {
        assert!(execute("other","analyze_order",json!({})).is_err());
    }
}
