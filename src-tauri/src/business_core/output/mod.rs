//! TSBH output-domain business core.
//! JSON is deliberately kept compatible with the preexisting State snapshots.
mod export;
mod export_history;
mod messages;
mod automatic_request;
mod automatic_full;
mod settlement;

use serde_json::Value;

/// Adapter boundary for Tauri and the isolated Rust test crate.
/// Export preparation is read-only: file serialization and the subsequent
/// native Save As / SQLite transaction are separate operations.
pub fn execute(operation: &str, payload: Value) -> Result<Value, String> {
    match operation {
        "prepare_factory_export" => export::prepare(
            payload.get("state").unwrap_or(&Value::Null),
            payload.get("ids").unwrap_or(&Value::Null),
            "FACTORY",
        ),
        "prepare_store_export" => export::prepare(
            payload.get("state").unwrap_or(&Value::Null),
            payload.get("ids").unwrap_or(&Value::Null),
            "STORE",
        ),
        "finalize_export" => export_history::finalize(&payload),
        "render_messages" => messages::execute(&payload),
        "render_automatic_request" => automatic_request::execute(&payload),
        "render_automatic_message" => automatic_full::execute(&payload),
        "payment_copy_status" => automatic_full::execute(&payload),
        "prepare_settlement" => settlement::prepare(
            payload.get("state").unwrap_or(&Value::Null),
            payload.get("date").and_then(Value::as_str).unwrap_or(""),
            payload.get("historyRows").unwrap_or(&Value::Null),
        ),
        _ => Err(format!("지원하지 않는 출력 업무입니다: {}", operation)),
    }
}
