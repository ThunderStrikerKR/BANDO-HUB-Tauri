//! Run real recognition::execute for the same JSON requests as TypeScript.
use serde_json::{json, Value};
use std::io::{self, Read};
use tsbh_recognition_regression::recognition;
fn main() {
    let mut input=String::new();
    io::stdin().read_to_string(&mut input).expect("read input");
    let requests:Vec<Value>=serde_json::from_str(&input).expect("requests JSON");
    let results:Vec<Value>=requests.into_iter().map(|request| {
        let operation=request.get("operation").and_then(Value::as_str).unwrap_or("");
        let payload=request.get("payload").cloned().unwrap_or(Value::Null);
        match recognition::execute(operation,payload) {
            Ok(value)=>json!({"ok":true,"value":value}),
            Err(error)=>json!({"ok":false,"error":error}),
        }
    }).collect();
    println!("{}",serde_json::to_string(&results).expect("serialize results"));
}
