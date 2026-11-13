//! Run the actual staged rules engine on the same JSON fixtures as TS.
use std::io::{self, Read};
use serde_json::{json, Value};
use tsbh_rust_rules_regression::rules;
fn main() {
    let mut raw=String::new();
    io::stdin().read_to_string(&mut raw).expect("read cases");
    let cases:Vec<Value>=serde_json::from_str(&raw).expect("JSON array");
    let answers:Vec<Value>=cases.into_iter().map(|request| {
        let op=request.get("operation").and_then(Value::as_str).unwrap_or("");
        let payload=request.get("payload").cloned().unwrap_or(Value::Null);
        match rules::execute(op,payload) {
            Ok(v)=>json!({"ok":true,"value":v}),
            Err(e)=>json!({"ok":false,"error":e}),
        }
    }).collect();
    println!("{}",serde_json::to_string(&answers).expect("serialize output"));
}
