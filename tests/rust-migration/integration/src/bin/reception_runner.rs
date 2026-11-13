//! Batch invoke the actual production Rust domains; no surrogate parser.
use serde_json::{json, Value};
use std::io::{self, Read};
use tsbh_rust_integrated_domains::business_core;

fn main() {
    let mut input=String::new();
    io::stdin().read_to_string(&mut input).expect("read requests");
    let requests: Vec<Value>=serde_json::from_str(&input).expect("JSON request array");
    let answers: Vec<Value>=requests.into_iter().map(|req| {
        let domain=req.get("domain").and_then(Value::as_str).unwrap_or("recognition");
        let operation=req.get("operation").and_then(Value::as_str).unwrap_or("analyze_order");
        let payload=req.get("payload").cloned().unwrap_or(Value::Null);
        match business_core::execute(domain,operation,payload) {
            Ok(value)=>json!({"ok":true,"value":value}),
            Err(error)=>json!({"ok":false,"error":error}),
        }
    }).collect();
    println!("{}",serde_json::to_string(&answers).expect("serialize"));
}
