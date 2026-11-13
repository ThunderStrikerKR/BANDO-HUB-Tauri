//! JSON Lines adapter used by the TypeScript-vs-Rust parity comparison.
//! Cargo invocation: cargo run --quiet --manifest-path
//! tests/rust-migration/rules/Cargo.toml --bin json_rules
#[path = "../../../../../src-tauri/src/business_core/rules/mod.rs"]
mod rules;

use std::io::{self, BufRead};

fn main() {
    for line in io::stdin().lock().lines() {
        let line=match line {Ok(line)=>line,Err(error)=>{
            println!("{}",serde_json::json!({"ok":false,"error":error.to_string()}));
            break;
        }};
        let parsed:serde_json::Value=match serde_json::from_str(&line) {
            Ok(value)=>value,
            Err(error)=>{
                println!("{}",serde_json::json!({"ok":false,"error":error.to_string()}));
                continue;
            }
        };
        let operation=parsed.get("operation").and_then(|v|v.as_str()).unwrap_or("");
        let payload=parsed.get("payload").cloned().unwrap_or(serde_json::Value::Null);
        let output=match rules::execute(operation,payload) {
            Ok(value)=>serde_json::json!({"ok":true,"value":value}),
            Err(error)=>serde_json::json!({"ok":false,"error":error})
        };
        println!("{output}");
    }
}
