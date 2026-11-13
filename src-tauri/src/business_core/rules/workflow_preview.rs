//! Read-only Rust projection of the live workflow board.
//! Never creates events, allocates IDs, changes persisted state, or saves SQLite.
//! Derives the visible per-shipment and per-group totals from the same Rust
//! rules that validate subsequent staff-approved workflow transitions.
use serde_json::{json, Value};
use super::{checked_sum, field, find_by_id, flag, has_value, req, rows, safe, set, str_field};
use super::{workflow, workflow_issues};

fn sum_field(totals: &[Value], key: &str) -> Value {
    if totals.is_empty() { return Value::Null; }
    totals.iter()
        .map(|row| safe(field(row, key)))
        .collect::<Option<Vec<_>>>()
        .and_then(checked_sum)
        .map_or(Value::Null, |value| json!(value))
}

fn vat_applies(order: &Value, recipient: &Value) -> bool {
    field(recipient, "vatOverride").as_bool()
        .or_else(|| field(recipient, "vatDefault").as_bool())
        .unwrap_or_else(|| flag(order, "applyVat"))
}

/// Returns a pure projection of all active workflow groups, with no state
/// mutation. All amounts and action blockers are calculated in compiled Rust.
/// React remains responsible only for presenting this result.
pub(super) fn project(payload: &Value) -> Result<Value, String> {
    let state = req(payload, "state")?;
    let orders = field(state, "orders");
    let workflow_state = field(state, "workflow");
    let all_shipments = rows(field(workflow_state, "shipments"));
    let mut projected = Vec::new();

    for group in rows(field(workflow_state, "groups")) {
        if has_value(field(group, "deletedAt")) { continue; }
        let group_id = str_field(group, "id");
        let ships = all_shipments.iter()
            .filter(|ship| str_field(ship, "groupId") == group_id)
            .filter(|ship| !flag(ship, "legacyArchived"))
            .filter(|ship| !find_by_id(orders, str_field(ship, "orderId"))
                .is_some_and(|order| has_value(field(order, "deletedAt"))))
            .collect::<Vec<_>>();
        if ships.is_empty() { continue; }

        // GroupAccount in the original TypeScript sees only this group's
        // recipients, which matters when one source order is split between
        // BANDOMALL and BANDOSTAND account mappings.
        let first_order = find_by_id(orders, str_field(ships[0], "orderId"))
            .ok_or("배송 건의 발주서 / 수취인 / 거래처 연결을 확인하세요.")?;
        let mut group_order = first_order.clone();
        let group_rows = rows(field(first_order, "recipients")).iter()
            .filter(|row| ships.iter().any(|ship|
                str_field(ship, "recipientId") == str_field(row, "id")))
            .cloned().collect::<Vec<_>>();
        set(&mut group_order, "recipients", json!(group_rows))?;
        if let Some(mode) = group.get("accountMode").filter(|v| !v.is_null()) {
            set(&mut group_order, "accountMode", mode.clone())?;
        }
        if str_field(group, "accountMode") == "MANUAL" {
            set(&mut group_order, "accountId", field(group, "accountId").clone())?;
        }
        let account_key = |value: &Value| json!([
            field(value, "id"),
            str_field(value, "bank").trim(),
            str_field(value, "number").trim(),
            str_field(value, "holder").trim()
        ]);
        // Retail can legitimately have no saved client; it has no account
        // allocations to display in group management.
        let account_id = workflow::party(state, &group_order)
            .and_then(|party| workflow::account_for(state, group, &group_order, party))
            .map(account_key);

        let mut totals = Vec::with_capacity(ships.len());
        let mut shipment_projections = Vec::with_capacity(ships.len());
        let mut all_vat = true;
        let mut any_vat = false;
        for ship in &ships {
            let order = find_by_id(orders, str_field(ship, "orderId"))
                .ok_or("배송 건의 발주서 / 수취인 / 거래처 연결을 확인하세요.")?;
            let recipient = find_by_id(field(order, "recipients"), str_field(ship, "recipientId"))
                .ok_or("배송 건의 발주서 / 수취인 / 거래처 연결을 확인하세요.")?;
            let vat = vat_applies(order, recipient);
            let freight_code = workflow::shipment_freight_code(order, recipient);
            let excluded = workflow::party(state, order)
                .is_some_and(|client| flag(client, "shippingFeeExcluded"));
            let mut display_charges = serde_json::Map::new();
            for item in rows(field(recipient, "items")) {
                let origin = str_field(item, "origin");
                if !["FACTORY", "STORE"].contains(&origin) { continue; }
                let value = if freight_code == "020" || excluded {
                    json!(0)
                } else {
                    field(field(ship, "charges"), origin).clone()
                };
                display_charges.insert(origin.to_string(), value);
            }
            all_vat &= vat;
            any_vat |= vat;
            let amount = workflow::shipment_totals(state, str_field(ship, "id"))?;
            // Only settled allocations with the selected group's account
            // count as paid; confirmations do not create a second payment.
            let mut paid = 0_i64;
            for payment in rows(field(workflow_state, "payments")).iter().filter(|payment|
                str_field(payment, "dealerId") == str_field(order, "clientId") &&
                account_id.as_ref().is_some_and(|key| *key == account_key(field(payment, "account")))) {
                for allocation in rows(field(payment, "allocations")).iter().filter(|allocation|
                    str_field(allocation, "shipmentId") == str_field(ship, "id")) {
                    let value = safe(field(allocation, "amount"))
                        .ok_or("입금 배분 금액을 확인하세요.")?;
                    paid = checked_sum([paid, value])
                        .ok_or("입금액 합계를 확인하세요.")?;
                }
            }
            shipment_projections.push(json!({
                "shipmentId": field(ship, "id"),
                "paid": paid,
                "totals": amount,
                "freightCode": freight_code,
                "displayCharges": display_charges,
                "vatIncluded": vat
            }));
            totals.push(amount);
        }
        let step = ships.iter()
            .filter_map(|ship| field(ship, "step").as_i64())
            .min().unwrap_or(0);
        let needs_notice = flag(group, "needsNotice");
        let next_step = if needs_notice && step >= 2 { 3 } else { step + 1 };
        let blockers = if next_step <= 4 {
            workflow_issues::stage_issues(state, group_id, next_step)?
        } else { Vec::new() };
        let issues = workflow_issues::workflow_issues(state, group_id)?;
        projected.push(json!({
            "groupId": group_id,
            "step": step,
            "nextStep": next_step,
            "needsNotice": needs_notice,
            "transferred": ships.iter().any(|s| flag(s, "transferred")),
            "shipmentCount": ships.len(),
            "totals": {
                "subtotal": sum_field(&totals, "subtotal"),
                "shipping": sum_field(&totals, "shipping"),
                "vat": sum_field(&totals, "vat"),
                "total": sum_field(&totals, "total")
            },
            "vatLabel": if all_vat { "부가세 포함" }
                else if any_vat { "부가세 포함/별도" }
                else { "부가세 별도" },
            "shipments": shipment_projections,
            "issues": issues,
            "nextStageBlockers": blockers
        }));
    }
    Ok(json!({ "groups": projected }))
}


/** The order-detail footer includes even transferred shipments, except
 * archived/deleted ones, exactly like workflow.ts::orderGrandTotal.
 * Recipient VAT display is separate from the monetary snapshot.
 */
pub(super) fn project_order(payload: &Value) -> Result<Value, String> {
    let state = req(payload, "state")?;
    let order_id = super::required_str(payload, "orderId")?;
    let order = find_by_id(field(state, "orders"), order_id)
        .or_else(|| payload.get("draft").filter(|draft| str_field(draft, "id") == order_id))
        .ok_or("주문 미리보기의 발주서를 확인하세요.")?;
    let groups = rows(field(field(state, "workflow"), "groups"));
    let ships = rows(field(field(state, "workflow"), "shipments")).iter()
        .filter(|ship| str_field(ship, "orderId") == order_id)
        .filter(|ship| !flag(ship, "legacyArchived"))
        .filter(|ship| !groups.iter().any(|group|
            str_field(group, "id") == str_field(ship, "groupId")
                && has_value(field(group, "deletedAt"))))
        .collect::<Vec<_>>();
    let amounts = ships.iter()
        .map(|ship| workflow::shipment_totals(state, str_field(ship, "id")))
        .collect::<Result<Vec<_>, _>>()?;
    let recipients = rows(field(order, "recipients"));
    let line_amounts = recipients.iter().flat_map(|recipient| {
        rows(field(recipient, "items")).iter().map(|item| {
            let amount = if str_field(item, "productId").is_empty()
                || str_field(item, "variantId").is_empty() {
                None
            } else {
                safe(field(item, "unitPrice"))
                    .zip(field(item, "quantity").as_i64())
                    .and_then(|(price, quantity)| price.checked_mul(quantity))
                    .filter(|value| value.abs() <= super::MAX_SAFE)
            };
            json!({
                "recipientId": field(recipient, "id"),
                "itemId": field(item, "id"),
                "amount": amount
            })
        })
    }).collect::<Vec<_>>();
    let has_vat = recipients.iter().any(|row| vat_applies(order, row));
    let has_excluded = recipients.iter().any(|row| !vat_applies(order, row));
    Ok(json!({
        "orderId": order_id,
        "shipmentCount": ships.len(),
        "lineAmounts": line_amounts,
        "total": sum_field(&amounts, "total"),
        "vatLabel": if has_vat && has_excluded { "부가세 포함/별도" }
            else if has_vat { "부가세 포함" } else { "부가세 별도" }
    }))
}

#[cfg(test)]
mod tests {
    use super::project;
    use serde_json::json;

    #[test]
    fn no_workflow_groups_returns_empty_projection_without_creating_events() {
        let state = json!({
            "orders": [], "workflow": {
                "groups": [], "shipments": [], "events": []
            }
        });
        let initial = state.clone();
        let projected = project(&json!({"state": state})).expect("empty preview");
        assert_eq!(projected, json!({"groups": []}));
        assert_eq!(initial["workflow"]["events"], json!([]));
    }

    #[test]
    fn deleted_and_empty_groups_do_not_show_or_create_rows() {
        let state = json!({
            "orders": [], "workflow": {
                "groups": [
                    {"id": "deleted", "deletedAt": "2026-11-13T00:00:00Z"},
                    {"id": "no-shipments"}
                ],
                "shipments": [], "events": []
            }
        });
        assert_eq!(
            project(&json!({"state": state})).expect("hidden groups"),
            json!({"groups": []})
        );
    }

    #[test]
    fn malformed_active_shipments_are_not_silently_reported_as_zero() {
        let state = json!({
            "orders": [],
            "workflow": {
                "groups": [{"id": "group:one"}],
                "shipments": [{
                    "id": "shipment:one", "groupId": "group:one",
                    "orderId": "missing-order", "recipientId": "recipient:one"
                }]
            }
        });
        assert!(project(&json!({"state": state})).is_err());
    }
}
