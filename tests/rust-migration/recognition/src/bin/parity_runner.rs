//! Executes actual Rust recognition on the exact input JSON used by the TS oracle.
use serde_json::{json, Value};
use std::io::{self, Read};
use tsbh_recognition_regression::recognition;
fn main(){
    let mut source=String::new();
    io::stdin().read_to_string(&mut source).expect("read JSON input");
    let requests:Vec<Value>=serde_json::from_str(&source).expect("parse JSON array");
    let output:Vec<Value>=requests.into_iter().map(|request|{
        let op=request.get("operation").and_then(Value::as_str).unwrap_or("analyze_order");
        let payload=request.get("payload").cloned().unwrap_or(Value::Null);
        match std::panic::catch_unwind(||recognition::execute(op,payload)){
            Ok(Ok(result))=>json!({"ok":true,"value":result}),
            Ok(Err(err))=>json!({"ok":false,"error":err}),
            Err(_)=>json!({"ok":false,"panic":true}),
        }
    }).collect();
    println!("{}",serde_json::to_string(&output).expect("serialize"));
}
