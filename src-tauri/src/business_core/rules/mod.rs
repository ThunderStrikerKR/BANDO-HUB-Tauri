//! Pure JSON business-rule boundary. No SQLite, Tauri, clock or process globals.
//! Every mutation returns a new JSON value; persistence belongs to the integrator.
use serde_json::{json, Value};

mod pricing;
mod shipping;
mod workflow;
mod validation;

const MAX_SAFE: i64 = 9_007_199_254_740_991;

pub fn execute(operation: &str, payload: Value) -> Result<Value, String> {
    match operation {
        "calculate_price" => pricing::totals(req(&payload, "order")?, req(&payload, "client")?),
        "resolve_unit_price" => pricing::resolve_unit_price(
            req(&payload, "product")?,
            required_str(&payload, "variantId")?,
            req(&payload, "client")?,
        ).map(|price| json!({"unitPrice": price})),
        "reprice_order" => pricing::reprice_order(&payload),
        "should_refresh_pricing" => Ok(json!({"refresh": pricing::should_refresh(&payload)?})),
        "calculate_shipping" => shipping::recommend(
            req(&payload, "order")?, req(&payload, "state")?,
        ),
        "calculate_shipment_totals" => workflow::shipment_totals(
            req(&payload, "state")?, required_str(&payload, "shipmentId")?,
        ),
        "evaluate_workflow" => workflow::evaluate(&payload),
        "evaluate_dispatch_state" => workflow::dispatch_state(
            req(&payload, "state")?, required_str(&payload, "orderId")?,
        ),
        "validate_workflow" => {
            validation::validate(req(&payload, "state")?, payload.get("before"))?;
            Ok(json!({"valid": true}))
        },
        "apply_workflow_action" => workflow::apply(&payload),
        "validate_reception_boundary" => {
            validation::validate_reception(
                req(&payload, "before")?, req(&payload, "state")?,
            )?;
            Ok(json!({"valid": true}))
        },
        _ => Err(format!("지원하지 않는 업무 operation: {operation}")),
    }
}

fn req<'a>(value: &'a Value, key: &str) -> Result<&'a Value, String> {
    value.get(key).ok_or_else(|| format!("필수 입력 누락: {key}"))
}
fn required_str<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
    value.get(key).and_then(Value::as_str)
        .ok_or_else(|| format!("필수 문자열 누락: {key}"))
}
fn field<'a>(value: &'a Value, key: &str) -> &'a Value {
    value.get(key).unwrap_or(&Value::Null)
}
fn str_field<'a>(value: &'a Value, key: &str) -> &'a str {
    field(value, key).as_str().unwrap_or("")
}
fn rows(value: &Value) -> &[Value] {
    value.as_array().map(Vec::as_slice).unwrap_or(&[])
}
fn flag(value: &Value, key: &str) -> bool {
    field(value, key).as_bool() == Some(true)
}
fn safe(value: &Value) -> Option<i64> {
    value.as_i64().filter(|n| (0..=MAX_SAFE).contains(n))
}
fn checked_sum(values: impl IntoIterator<Item = i64>) -> Option<i64> {
    values.into_iter().try_fold(0_i64, |a, b| {
        a.checked_add(b).filter(|n| (0..=MAX_SAFE).contains(n))
    })
}
fn obj_mut(value: &mut Value) -> Result<&mut serde_json::Map<String, Value>, String> {
    value.as_object_mut().ok_or_else(|| "JSON 객체 형식을 확인하세요.".to_string())
}
fn set(value: &mut Value, key: &str, other: Value) -> Result<(), String> {
    obj_mut(value)?.insert(key.to_string(), other);
    Ok(())
}
fn find_by_id<'a>(values: &'a Value, id: &str) -> Option<&'a Value> {
    rows(values).iter().find(|v| str_field(v, "id") == id)
}
fn has_value(value: &Value) -> bool {
    !value.is_null()
}
