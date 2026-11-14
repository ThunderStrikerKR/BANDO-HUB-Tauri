//! Pure JSON business-rule boundary. No SQLite, Tauri, clock or process globals.
//! Every mutation returns a new JSON value; persistence belongs to the integrator.
use serde_json::{json, Value};

mod pricing;
mod reconciliation;
mod issues;
mod product_confirmation;
mod message_audit;
mod order_mutations;
mod group_operations;
mod correction_rules;
mod reception_operations;
mod kakao_title;
mod manual_classification;
mod message_template_validation;
mod catalog_item;
mod retail_operations;
mod raw_corrections;
mod reply_rules;
mod shipping_read;
mod client_change;
mod factory_reply;
mod legacy_migration;
mod shipping;
mod workflow;
mod workflow_issues;
mod workflow_preview;
mod validation;
mod order_save;
mod history;

const MAX_SAFE: i64 = 9_007_199_254_740_991;

pub fn execute(operation: &str, payload: Value) -> Result<Value, String> {
    match operation {
        "list_order_history" => history::list(
            req(&payload,"state")?,
            str_field(&payload,"query"),
            str_field(&payload,"date"),
        ),
        "list_order_history_view" => history::list_view(
            req(&payload,"state")?,
            str_field(&payload,"query"),
            str_field(&payload,"date"),
            field(&payload,"trackingOrder"),
        ),
        "order_history_status" => Ok(json!({"status":history::status(
            req(&payload,"state")?,required_str(&payload,"orderId")?,
        )})),
        "save_order" => order_save::save(&payload),
        "calculate_price" => pricing::totals(req(&payload, "order")?, req(&payload, "client")?),
        "resolve_unit_price" => pricing::resolve_unit_price(
            req(&payload, "product")?,
            required_str(&payload, "variantId")?,
            req(&payload, "client")?,
        ).map(|price| json!({"unitPrice": price})),
        "resolve_unit_prices" => {
            let client=req(&payload,"client")?;
            let prices=rows(req(&payload,"quotes")?).iter().map(|quote|{
                pricing::resolve_unit_price(
                    req(quote,"product")?,
                    required_str(quote,"variantId")?,
                    client,
                )
            }).collect::<Result<Vec<_>,_>>()?;
            Ok(json!({"prices":prices}))
        },
        "reprice_order" => pricing::reprice_order(&payload),
        "should_refresh_pricing" => Ok(json!({"refresh": pricing::should_refresh(&payload)?})),
        "shipping_manager_view" => shipping::shipping_manager_view(&payload),
        "apply_shipping_action" => shipping::shipping_action(&payload),
        "shipping_read" => shipping_read::project(&payload),
        "reconcile_workflow" => reconciliation::reconcile(&payload),
        "calculate_shipping" => shipping::recommend(
            req(&payload, "order")?, req(&payload, "state")?,
        ),
        "calculate_shipment_totals" => workflow::shipment_totals(
            req(&payload, "state")?, required_str(&payload, "shipmentId")?,
        ),
        "evaluate_workflow" => workflow::evaluate(&payload),
        "preview_workflow" => workflow_preview::project(&payload),
        "preview_order" => workflow_preview::project_order(&payload),
        "workflow_issues" => Ok(json!({"issues":workflow_issues::workflow_issues(
            req(&payload,"state")?,required_str(&payload,"groupId")?)?})),
        "stage_issues" => Ok(json!({"issues":workflow_issues::stage_issues(
            req(&payload,"state")?,required_str(&payload,"groupId")?,
            req(&payload,"next")?.as_i64().ok_or("진행 단계 숫자가 필요합니다.")?)?})),
        "evaluate_dispatch_state" => workflow::dispatch_state(
            req(&payload, "state")?, required_str(&payload, "orderId")?,
        ),
        "order_issues" => Ok(json!({"issues": issues::order_issues(req(&payload,"order")?)})),
        "apply_issue_action" => issues::issue_action(&payload),
        "apply_product_action" => product_confirmation::apply(&payload),
        "record_message_copy" => message_audit::record(&payload),
        "factory_conflict_confirmation" | "factory_reply_review_statuses" | "analyze_factory_reply" | "preview_factory_reply" | "apply_factory_reply" =>
            factory_reply::execute(operation, &payload),
        "apply_reply_action" => reply_rules::apply(&payload),
        "finalize_billing_history" => reply_rules::finalize_billing_history(&payload),
        "client_change_issue" => client_change::check(&payload),
        "apply_raw_correction" => raw_corrections::apply(&payload),
        "apply_retail_action" => retail_operations::apply(&payload),
        "apply_reception_action" => reception_operations::apply(&payload),
        "apply_manual_classification" => manual_classification::apply(&payload),
        "validate_automatic_templates" => message_template_validation::validate(&payload),
        "validate_provisional_product_notices" => message_template_validation::validate_provisional(&payload),
        "create_catalog_item" => catalog_item::make(&payload),
        "remember_kakao_title_client" | "remembered_kakao_title_client" =>
            kakao_title::execute(operation, &payload),
        "apply_correction_action" => correction_rules::apply(&payload),
        "apply_group_action" => group_operations::mutate(&payload),
        "delete_order" => order_mutations::delete_order(&payload),
        "apply_order_raw_edit" => order_mutations::apply_raw_edit(&payload),
        "migrate_workflow" => legacy_migration::migrate(&payload),
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
