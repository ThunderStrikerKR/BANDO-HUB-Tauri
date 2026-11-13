use bando_catalog_clients_migration_tests::catalog_clients;
use serde_json::{json, Value};
use std::io::{self, Read};

fn main() {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input).expect("read parity request");
    let cases: Vec<Value> = serde_json::from_str(&input).expect("parse cases");
    let results: Vec<Value> = cases.into_iter().map(|case| {
        let operation = case.get("operation").and_then(Value::as_str).unwrap_or("");
        let payload = case.get("payload").cloned().unwrap_or(Value::Null);
        match catalog_clients::execute(operation, payload) {
            Ok(value) => json!({"ok":true,"value":value}),
            Err(error) => json!({"ok":false,"error":error}),
        }
    }).collect();
    println!("{}", serde_json::to_string(&results).expect("serialize"));
}
