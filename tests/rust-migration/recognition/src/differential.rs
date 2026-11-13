//! Executes original TS parseEvidence and actual Rust analyze_order against
//! exactly the same in-memory 15-color-corrected state and input orders.
use crate::recognition;
use serde_json::{json,Value};
use std::{io::Write,path::Path,process::{Command,Stdio}};

fn seed() -> Value {
    serde_json::from_str(include_str!(
        "../../../../src-tauri/resources/state-seed.json"
    )).expect("committed products")
}
fn corrected_state() -> (Value,Vec<Value>) {
    let mut state=seed();
    let m:Value=serde_json::from_str(include_str!(
        "../catalog-color-corrections-15.json"
    )).expect("reviewed color corrections");
    let corrections=m["corrections"].as_array().unwrap().clone();
    assert_eq!(corrections.len(),15);
    for c in &corrections {
        let id=c["productId"].as_str().unwrap();
        let p=state["products"].as_array_mut().unwrap().iter_mut()
            .find(|p|p["id"]==id).expect("correct SKU");
        assert_eq!(p["active"],true);
        assert_eq!(p["name"],c["expectedName"]);
        assert_eq!(p["defaultColor"],c["expectedDefaultColor"]);
        assert_eq!(p["variants"].as_array().unwrap().len(),1);
        assert_eq!(p["variants"][0]["id"],c["variantId"]);
        assert_eq!(p["variants"][0]["color"],c["expectedVariantColor"]);
        assert_eq!(p["variants"][0]["url"],c["registeredSourceUrl"]);
        p["defaultColor"]=c["color"].clone();
        p["variants"][0]["color"]=c["color"].clone();
    }
    (state,corrections)
}
fn original_samples()->Vec<Value>{
    let fixture=include_str!("../../../audit-20-order-samples.test.mjs");
    let start=fixture.find("const samples=[").unwrap()+"const samples=".len();
    let end=fixture[start..].find("\n];").unwrap()+start+2;
    serde_json::from_str(&fixture[start..end]).expect("original twenty samples")
}
fn run_node(script:&str,payload:&Value)->Value {
    let root=Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let tsx=root.join("node_modules/tsx/package.json");
    let zod=root.join("node_modules/zod/package.json");
    if !tsx.exists() || !zod.exists() {
        // The recognition-only CI intentionally skips JS installation.
        // Install exactly the project's locked dependencies in the *CI
        // workspace*, without changing package.json or package-lock.json.
        let install=Command::new("npm")
            .args(["ci","--no-audit","--no-fund","--ignore-scripts"])
            .current_dir(&root).output()
            .expect("npm is required for real TS differential testing");
        assert!(install.status.success(),
            "npm ci failed (TS not executed): {} {}",
            String::from_utf8_lossy(&install.stdout),
            String::from_utf8_lossy(&install.stderr));
    }
    let mut child=Command::new("node")
        .arg(script).current_dir(&root)
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped())
        .spawn().expect("Node.js is required for original TS execution");
    child.stdin.take().expect("stdin")
        .write_all(payload.to_string().as_bytes()).expect("send real Rust results");
    let output=child.wait_with_output().expect("TS process");
    assert!(output.status.success(),
        "original TypeScript failed: {} {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr));
    serde_json::from_slice(&output.stdout)
        .unwrap_or_else(|e|panic!("TS comparator returned invalid JSON: {e}, {}",
            String::from_utf8_lossy(&output.stdout)))
}

#[test]
fn execute_original_typescript_and_rust_with_all_product_fields() {
    let (state,changes)=corrected_state();
    let client=json!({
        "id":"ci-dealer","name":"가상거래처","tier":"wholesale",
        "overrides":{},"active":true,"payment":"PREPAID",
        "contact":"","identifiers":"","shippingFeeExcluded":false
    });
    let mut cases=Vec::<Value>::new();
    for (i,c) in changes.iter().enumerate(){
        let name=c["expectedName"].as_str().unwrap();
        let raw=format!("{name} 2개\n김가상\n서울특별시 용산구 한강대로 100");
        let rust=recognition::execute("analyze_order",json!({
            "raw":raw,"client":client,"state":state
        })).expect("Rust actual document parser");
        let matched=recognition::execute("match_products",json!({
            "text":name,"client":client,"state":state
        })).expect("Rust standalone match");
        cases.push(json!({
            "id":format!("corrected-{:02}",i+1),
            "raw":raw,"rust":rust,"match":matched
        }));
    }
    // Original 20-order samples exercise a broader set of color/model
    // matching and evidence paths. Their text and expectations are unchanged.
    let original=original_samples();
    assert_eq!(original.len(),20);
    for record in &original{
        let id=record["id"].as_u64().unwrap();
        let raw=record["raw"].as_str().unwrap();
        let rust=recognition::execute("analyze_order",json!({
            "raw":raw,"client":client,"state":state
        })).expect("Rust original order fixture");
        cases.push(json!({
            "id":format!("original-{id:02}"),
            "raw":raw,"rust":rust
        }));
    }
    assert_eq!(cases.len(),35);
    let report=run_node(
        "tests/rust-migration/recognition/compare-ts-rust.mjs",
        &json!({"state":state,"client":client,"cases":cases})
    );
    assert_eq!(report["cases"],35,
        "TypeScript differential did not inspect every case");
    assert!(report["comparedLeaves"].as_u64().unwrap_or(0)>100,
        "compare all product fields; no empty or mock response");
    println!("TS_RUST_PRODUCT_DIFFERENTIAL_SUMMARY {}",json!({
        "cases":report["cases"],
        "comparedLeaves":report["comparedLeaves"],
        "casesWithDifferences":report["casesWithDifferences"],
        "mismatchCount":report["mismatchCount"]
    }));
    for trace in report["diagnostics"].as_array().into_iter().flatten(){
        println!("TS_RUST_PRODUCT_TRACE {}",trace);
    }
    for entry in report["byField"].as_array().into_iter().flatten(){
        println!("TS_RUST_PRODUCT_DIFF_FIELD {}",entry);
    }
    for entry in report["byCase"].as_array().into_iter().flatten(){
        println!("TS_RUST_PRODUCT_DIFF_CASE {}",entry);
    }
    for entry in report["differences"].as_array().into_iter().flatten().take(1500){
        println!("TS_RUST_PRODUCT_DIFF_DETAIL {}",entry);
    }
    // Three source-proven upstream TypeScript defects remain:
    // - Red/레드 alias is absent from domain.ts::normalizeColor;
    // - a date is misclassified as an UNKNOWN item in samples 19/20;
    // - the table parser leaves an explicit quantity unconfirmed.
    // Allow fewer known defects if upstream code improves. Reject any new
    // category, field, or case of mismatch.
    let exceptions:Vec<(&str,&[&str])>=vec![
        ("corrected-01",&[
            "items[0].catalog","items[0].color",
            "items[0].issues.length","items[0].issues[0]",
            "items[0].match.kind","items[0].name",
            "items[0].productId","items[0].recognitionReason",
            "items[0].url","items[0].variantId"
        ]),
        ("original-19",&[
            "items.length","items[0].quantity","items[0].quantityConfirmed",
            "items[0].sources.length","items[0].sources[1]",
            "items.unmatchedTs[0]"
        ]),
        ("original-20",&[
            "items.length","items[0].quantity","items[0].quantityConfirmed",
            "items[0].sources.length","items[0].sources[1]",
            "items.unmatchedTs[0]"
        ])
    ];
    let differences=report["differences"].as_array().expect("all actual field differences");
    assert!(!report["truncated"].as_bool().unwrap_or(true),
        "differential report truncated: unsafe to enforce an exception gate");
    assert_eq!(differences.len() as u64,
        report["mismatchCount"].as_u64().expect("complete diff count"),
        "do not approve exceptions when not all differences were printed");
    let unexpected:Vec<&Value>=differences.iter().filter(|d|{
        let case=d["caseId"].as_str().unwrap_or("");
        let path=d["path"].as_str().unwrap_or("");
        !exceptions.iter().any(|(id,paths)|*id==case && paths.contains(&path))
    }).collect();
    assert!(unexpected.is_empty(),
        "new TS/Rust recognition differences outside reviewed legacy defects: {}",
        json!(unexpected));
    assert!(differences.len()<=22,
        "reviewed source defects must not grow or duplicate: {}",differences.len());
    assert!(report["casesWithDifferences"].as_u64().unwrap_or(100)<=3,
        "unexpected parity mismatch across additional input cases");
    println!("TS_RUST_PRODUCT_PARITY_STATUS ONLY_THREE_REVIEWED_SOURCE_EXCEPTIONS");
    println!("TS_RUST_PRODUCT_EXPECTED_EXCEPTION_COUNT {}",differences.len());
}
