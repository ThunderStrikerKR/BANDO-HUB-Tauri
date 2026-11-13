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


fn recipient_client() -> Value {
    json!({"id":"ci-dealer","name":"가상거래처","tier":"wholesale",
        "overrides":{},"active":true,"payment":"PREPAID",
        "contact":"","identifiers":"","shippingFeeExcluded":false})
}
fn print_recipient_report(tag:&str,report:&Value) {
    println!("{tag}_SUMMARY {}",json!({
        "cases":report["cases"],"comparedLeaves":report["comparedLeaves"],
        "casesWithDifferences":report["casesWithDifferences"],
        "mismatchCount":report["mismatchCount"]
    }));
    for field in report["byField"].as_array().into_iter().flatten() {
        println!("{tag}_FIELD {}",field);
    }
    for case in report["byCase"].as_array().into_iter().flatten() {
        println!("{tag}_CASE {}",case);
    }
    for entry in report["differences"].as_array().into_iter().flatten().take(1500) {
        println!("{tag}_DIFF {}",entry);
    }
    assert!(!report["truncated"].as_bool().unwrap_or(true),
        "{tag}: too many differences; the raw report was truncated");
}
fn recipient_cases() -> Vec<Value> {
    let fixture=original_samples();
    assert_eq!(fixture.len(),20);
    let mut cases:Vec<Value>=fixture.iter().map(|x| json!({
        "id":format!("original-{:02}",x["id"].as_u64().unwrap()),
        "raw":x["raw"]
    })).collect();
    let (state,corrections)=corrected_state();
    assert_eq!(state["products"].as_array().unwrap().len(),360);
    for (i,c) in corrections.iter().enumerate() {
        let name=c["expectedName"].as_str().expect("product name");
        cases.push(json!({"id":format!("color-{:02}",i+1),
            "raw":format!("{name} 2개\n김가상\n서울특별시 용산구 한강대로 100")}));
    }
    // Nine independent, business-oriented real order documents. Use
    // original TS and Rust, never a simulated recipient parser.
    for (id,raw) in [
        ("recipient-two","BD Floor-BTS / 블랙 / 높이 27cm 2개\n김가상\n서울특별시 용산구 한강대로 100\n010-1234-5678\nBD Desk-BTS / 블랙 / 높이 27cm 1개\n박가상\n경기도 의정부시 시민로 20\n010-2345-6789"),
        ("recipient-name-contact","수취인: 김가상\n연락처: 010-1234-5678\n배송지: 서울특별시 마포구 월드컵로 20\n709 민판 2개"),
        ("recipient-note","김가상\n서울특별시 서대문구 연희로 100\n010-1234-5678\n배송 요청사항: 현관 앞 부탁드립니다\nBD 709 1개"),
        ("recipient-inline","BD 709 민판 한개 이가상 010-1234-5678\n서울특별시 마포구 월드컵로 20"),
        ("recipient-address-detail","박가상\n010-2345-6789\n서울특별시 성북구 길음로 11\n  101동 1102호\n709 1개"),
        ("recipient-shipping","김가상\n경기도 의정부시 시민로 100\n010-1234-5678\nBD 950 3개\n메시지: 부재 시 문 앞"),
        ("recipient-unnamed","서울특별시 용산구 한강대로 100\nBD 709 2개"),
        ("recipient-duplicate-name","김가상\n서울특별시 용산구 한강대로 100\nBD 709 1개\n김가상\n경기도 의정부시 시민로 20\nBD 950 1개"),
        ("recipient-common","BD 709 2개 공통\n김가상\n서울특별시 용산구 한강대로 100\n박가상\n경기도 의정부시 시민로 20"),
    ] {
        cases.push(json!({"id":id,"raw":raw}));
    }
    assert_eq!(cases.len(),44);
    cases
}

#[test]
fn compare_real_recipient_fields_addresses_contacts_and_all_evidence() {
    let (mut state,_)=corrected_state();
    let client=recipient_client();
    state["clients"]=json!([client.clone()]);
    let mut cases=recipient_cases();
    for case in &mut cases {
        let raw=case["raw"].as_str().expect("case raw");
        let rust=recognition::execute("analyze_order",json!({
            "raw":raw,"state":state,"client":client
        })).expect("real Rust recipient parser");
        case["rust"]=rust;
    }
    let report=run_node(
        "tests/rust-migration/recognition/compare-ts-rust-recipients.mjs",
        &json!({"phase":"compare","state":state,"client":client,"cases":cases}));
    assert_eq!(report["cases"],44,"not all real documents were compared");
    assert!(report["comparedLeaves"].as_u64().unwrap_or(0)>200,
        "recipient comparison did not inspect real fields");
    print_recipient_report("TS_RUST_RECIPIENT", &report);
}

#[test]
fn compare_real_reanalysis_and_employee_confirmations() {
    let (mut state,_)=corrected_state();
    let client=recipient_client();
    state["clients"]=json!([client.clone()]);
    let base="BD Floor-BTS / 블랙 / 높이 27cm 2개\n김가상\n서울특별시 용산구 한강대로 100\n010-1234-5678";
    let two="BD Floor-BTS / 블랙 / 높이 27cm 2개\n김가상\n서울특별시 용산구 한강대로 100\nBD Desk-BTS / 블랙 / 높이 27cm 1개\n박가상\n경기도 의정부시 시민로 20";
    let scenarios=vec![
        json!({"id":"reanalyze-base","raw":base,"mode":"base"}),
        json!({"id":"reanalyze-staff-fields","raw":base,
            "mode":"confirmed-freight-staff-item"}),
        json!({"id":"reanalyze-edit-quantity",
            "oldRaw":base,
            "raw":base.replace("27cm 2개","27cm 3개"),
            "mode":"confirmed-freight-staff-item-qty-edit"}),
        json!({"id":"reanalyze-manual","raw":base,"mode":"manual"}),
        json!({"id":"reanalyze-two-recipients","raw":two,"mode":"confirmed-freight"}),
        json!({"id":"reanalyze-name-changed","oldRaw":base,
            "raw":base.replace("김가상","박가상"),
            "mode":"confirmed-freight-staff-item"}),
        json!({"id":"reanalyze-new-destination","oldRaw":base,
            "raw":format!("{base}\nBD Desk-BTS / 블랙 / 높이 27cm 1개\n박가상\n경기도 의정부시 시민로 20"),
            "mode":"confirmed-freight"}),
        json!({"id":"reanalyze-confirmed-address","raw":
            "BD 709 2개\n김가상\n서울특별시 마포구 월드컵로 20\n배송 메모: 현관 앞",
            "mode":"confirmed-freight"}),
        json!({"id":"reanalyze-duplicate-name","raw":
            "김가상\n서울특별시 용산구 한강대로 100\nBD 709 1개\n김가상\n경기도 의정부시 시민로 20\nBD 950 1개",
            "mode":"confirmed-freight"}),
    ];
    let prepared=run_node(
        "tests/rust-migration/recognition/compare-ts-rust-recipients.mjs",
        &json!({"phase":"prepare","state":state,"client":client,"cases":scenarios}));
    let mut cases=prepared["cases"].as_array().expect("real TypeScript order preparation")
        .clone();
    assert_eq!(cases.len(),9);
    for case in &mut cases {
        let order=case["order"].clone();
        let rust=recognition::execute("reanalyze_order",json!({
            "order":order,"state":state
        })).expect("real Rust reanalysis");
        case["rustReanalyzed"]=rust;
    }
    let report=run_node(
        "tests/rust-migration/recognition/compare-ts-rust-recipients.mjs",
        &json!({"phase":"reanalyze","state":state,"client":client,"cases":cases}));
    assert_eq!(report["cases"],9,"not all employee decision scenarios were compared");
    assert!(report["comparedLeaves"].as_u64().unwrap_or(0)>150,
        "reanalysis did not inspect actual fields");
    print_recipient_report("TS_RUST_REANALYSIS",&report);
}
