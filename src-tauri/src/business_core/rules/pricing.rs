use serde_json::{json, Value};

use super::{checked_sum, field, find_by_id, flag, has_value, req, rows, safe, set, str_field, MAX_SAFE};

pub(super) fn resolve_unit_price(
    product: &Value,
    variant_id: &str,
    client: &Value,
) -> Result<Value, String> {
    if str_field(client, "id").is_empty() {
        return Ok(Value::Null);
    }
    let variant = rows(field(product, "variants"))
        .iter()
        .find(|v| str_field(v, "id") == variant_id);
    let price = if str_field(client, "tier") == "special" {
        let overrides = field(client, "overrides");
        let by_id = field(overrides, variant_id);
        if has_value(by_id) {
            by_id.clone()
        } else {
            let by_legacy = variant
                .and_then(|v| {
                    rows(field(v, "legacyIds"))
                        .iter()
                        .find_map(|id| {
                            let p = field(overrides, id.as_str()?);
                            has_value(p).then_some(p.clone())
                        })
                });
            by_legacy
                .or_else(|| variant.map(|v| field(v, "wholesale").clone()))
                .unwrap_or(Value::Null)
        }
    } else {
        let tier = str_field(client, "tier");
        variant.map(|v| field(v, tier).clone()).unwrap_or(Value::Null)
    };
    Ok(if price.as_i64() == Some(0) { Value::Null } else { price })
}

pub(super) fn totals(order: &Value, client: &Value) -> Result<Value, String> {
    let effective_client = if flag(order, "pricesLocked") && has_value(field(order, "clientSnapshot")) {
        field(order, "clientSnapshot")
    } else {
        client
    };
    let items: Vec<&Value> = rows(field(order, "recipients")).iter()
        .flat_map(|r| rows(field(r, "items")).iter())
        .collect();
    let valid = !items.is_empty() && items.iter().all(|item| {
        !str_field(item, "productId").is_empty()
            && !str_field(item, "variantId").is_empty()
            && safe(field(item, "unitPrice")).is_some()
            && field(item, "quantity").as_i64().is_some_and(|q| q > 0 && q <= MAX_SAFE)
    });
    let subtotal = if valid {
        items.iter()
            .map(|item| {
                safe(field(item, "unitPrice"))?.checked_mul(field(item, "quantity").as_i64()?)
                    .filter(|n| (0..=MAX_SAFE).contains(n))
            })
            .collect::<Option<Vec<_>>>()
            .and_then(checked_sum)
    } else {
        None
    };
    let shipping = if flag(effective_client, "shippingFeeExcluded") ||
        str_field(order, "freightCode") == "020" {
        json!(0)
    } else {
        field(order, "shippingFee").clone()
    };
    let complete = subtotal.is_some() && safe(&shipping).is_some();
    let vat = if flag(order, "pricesLocked") && has_value(field(order, "vatAmount")) {
        field(order, "vatAmount").clone()
    } else if !flag(order, "applyVat") {
        json!(0)
    } else if complete {
        let base = subtotal.unwrap() + safe(&shipping).unwrap();
        // JS Math.round((subtotal + shipping) * 0.1) uses binary64.
        let value = ((base as f64) * 0.1).round() as i64;
        json!(value)
    } else {
        Value::Null
    };
    let total = if complete {
        safe(&vat).and_then(|v| checked_sum([subtotal.unwrap(), safe(&shipping).unwrap(), v]))
    } else {
        None
    };
    // TS totals() clears an unsafe total together with the subtotal and VAT.
    if complete && total.is_none() {
        return Ok(json!({"subtotal":null,"shipping":shipping,"vat":null,"total":null}));
    }
    Ok(json!({"subtotal":subtotal,"shipping":shipping,"vat":vat,"total":total}))
}

pub(super) fn should_refresh(payload: &Value) -> Result<bool, String> {
    let order = req(payload, "order")?;
    let id = str_field(order, "id");
    let persisted = rows(field(payload, "persistedOrders"))
        .iter().chain(rows(field(payload, "persistedOrderIds")).iter())
        .any(|v| v.as_str() == Some(id) || str_field(v, "id") == id);
    Ok(!has_value(field(order, "confirmedAt"))
        && !has_value(field(order, "deletedAt"))
        && !flag(order, "pricesLocked")
        && !persisted)
}

pub(super) fn reprice_order(payload: &Value) -> Result<Value, String> {
    let mut order = req(payload, "order")?.clone();
    if has_value(field(&order, "confirmedAt")) || flag(&order, "pricesLocked") {
        return Ok(json!({"order":order,"refreshed":false}));
    }
    // An explicit employee edit may refresh persisted orders, but never frozen orders.
    let refresh = flag(payload, "explicitEdit") || should_refresh(payload)?;
    if !refresh {
        return Ok(json!({"order":order,"refreshed":false}));
    }
    let client = req(payload, "client")?;
    let products = payload.get("products")
        .or_else(|| payload.get("state").map(|s| field(s, "products")))
        .ok_or_else(|| "상품 목록 입력이 필요합니다.".to_string())?;
    let recipients = order.get_mut("recipients").and_then(Value::as_array_mut)
        .ok_or_else(|| "수취인 목록을 확인하세요.".to_string())?;
    for recipient in recipients {
        let items = recipient.get_mut("items").and_then(Value::as_array_mut)
            .ok_or_else(|| "상품 목록을 확인하세요.".to_string())?;
        for item in items {
            let pid = str_field(item, "productId").to_string();
            let vid = str_field(item, "variantId").to_string();
            if vid.is_empty() { continue; }
            if let Some(product) = find_by_id(products, &pid) {
                let unit_price = resolve_unit_price(product, &vid, client)?;
                set(item, "unitPrice", unit_price)?;
                if flag(field(item, "modelProposal"), "required") {
                    if let Some(variant) = rows(field(product, "variants"))
                        .iter().find(|v| str_field(v, "id") == vid) {
                        if has_value(field(variant, "url")) {
                            set(item, "url", field(variant, "url").clone())?;
                        }
                    }
                }
            }
        }
    }
    Ok(json!({"order":order,"refreshed":true}))
}
