//! Prepare frozen Logen rows. No XLSX serialization or mutable order rewrites occur here.
//! The factory and store use different product-label policies from the legacy UI.
use serde_json::{json, Value};
use std::collections::HashSet;

const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
const LOGEN_COLUMN_COUNT: usize = 16;

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}
fn children<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    value.get(key).and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}
fn trimmed(value: &Value, key: &str) -> String {
    text(value, key).trim().to_owned()
}
fn active(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(false)
}
fn find_by_id<'a>(items: &'a [Value], id: &str) -> Option<&'a Value> {
    items.iter().find(|item| text(item, "id") == id)
}
fn valid_quantity(value: &Value) -> Option<i64> {
    value.as_i64().filter(|n| *n > 0 && *n <= MAX_SAFE_INTEGER)
}
fn regex_capture(text: &str, expression: &str) -> Option<String> {
    let re = regex::Regex::new(expression).expect("constant regex");
    re.captures(text).and_then(|parts| parts.get(1)).map(|m| m.as_str().to_owned())
}
fn equipment_group(option: &str) -> &str {
    match option {
        "미포함" | "미장착" | "없음" => "EXCLUDED",
        "포함" | "장착" | "있음" => "INCLUDED",
        _ => "UNKNOWN",
    }
}
fn top_type(text: &str) -> Option<&'static str> {
    if regex::Regex::new(r"(?:비타공|무타공)\s*상판").unwrap().is_match(text) {
        Some("NONPERFORATED")
    } else if regex::Regex::new(r"타공\s*상판").unwrap().is_match(text) {
        Some("PERFORATED")
    } else {
        None
    }
}
fn top_style(text: &str) -> Option<String> {
    regex_capture(text, r"([AB])타입\s*상판")
}
fn resolve_historical<'a>(
    state: &'a Value,
    product_id: &str,
    variant_id: &str,
) -> Option<(&'a Value, bool)> {
    let products = children(state, "products");
    if let Some(direct) = find_by_id(products, product_id) {
        let variants = children(direct, "variants");
        return if variants.len() == 1 && text(&variants[0], "id") == variant_id {
            Some((direct, false))
        } else {
            None
        };
    }
    let mapping_key = format!("{}|{}", product_id, variant_id);
    let mapped_id = state.get("productMappings")?.get(&mapping_key)?.as_str()?;
    let mapped = find_by_id(products, mapped_id)?;
    let variants = children(mapped, "variants");
    if text(mapped, "sourceProductId") == product_id
        && variants.len() == 1 && text(&variants[0], "id") == variant_id
    {
        Some((mapped, true))
    } else {
        None
    }
}
fn validate_factory_product(state: &Value, item: &Value) -> Result<(), String> {
    let product_id = text(item, "productId");
    let variant_id = text(item, "variantId");
    if product_id.is_empty() || variant_id.is_empty() {
        return Err("과거 주문의 상품 또는 가격 기록 ID가 없습니다. 발송 전 품목을 확인하세요.".into());
    }
    let (product, historical) = match resolve_historical(state, product_id, variant_id) {
        Some(linked) => linked,
        None => {
            if let Some(older) = find_by_id(children(state, "products"), product_id) {
                if children(older, "variants").len() != 1 {
                    return Err("복수 판매 구성이 묶인 옛 상품은 공장 발송할 수 없습니다. 독립 상품을 확인하세요.".into());
                }
            }
            return Err("과거 주문의 상품 ID와 가격 기록 ID가 현재 독립 상품에 연결되지 않습니다. 발송 전 확인하세요.".into());
        }
    };
    let variants = children(product, "variants");
    if variants.len() != 1 {
        return Err("복수 판매 구성이 묶인 옛 상품은 공장 발송할 수 없습니다. 독립 상품을 확인하세요.".into());
    }
    if variant_id != text(&variants[0], "id") {
        return Err("공장 출고 상품과 가격 기록의 식별자가 다릅니다.".into());
    }

    let stored_name = text(product, "name");
    let frozen_name = text(item, "name");
    for component in ["가방", "바퀴"] {
        let expression = format!(r"{}\s*(미포함|포함|미장착|장착|없음|있음)", component);
        if let Some(expected) = regex_capture(stored_name, &expression) {
            let actual = regex_capture(frozen_name, &expression);
            if equipment_group(&expected) != equipment_group(actual.as_deref().unwrap_or("")) {
                return Err(format!("{} 포함 / 미포함 정보가 실제 출고 구성과 다릅니다. 주문을 확인하세요.", component));
            }
        }
    }
    if let Some(expected) = top_type(stored_name) {
        if top_type(frozen_name) != Some(expected) {
            return Err("상판 타공 / 비타공 구분이 확정된 출고 품목명과 다릅니다.".into());
        }
    }
    if let Some(expected) = top_style(stored_name) {
        if top_style(frozen_name) != Some(expected) {
            return Err("상판 A/B타입 구분이 확정된 출고 품목명과 다릅니다.".into());
        }
    }
    if historical {
        let color = trimmed(&variants[0], "color");
        if !color.is_empty() && color != "단일" && color != "색상 미표기"
            && stored_name.contains(&color) && !frozen_name.contains(&color)
        {
            return Err("과거 주문의 색상 구분이 독립 상품 기록과 일치하는지 확인하세요.".into());
        }
    }
    Ok(())
}
fn export_row(state: &Value, entry: &Value, origin: &str) -> Result<Value, String> {
    let factory = origin == "FACTORY";
    let label = if factory { "공장" } else { "매장" };
    if text(entry, "origin") != origin
        || text(entry, "status") != "QUEUED"
        || !entry.get("snapshot").is_some_and(Value::is_object)
    {
        return Err(format!("{} {} 상태의 배송 건만 선택하세요.", label, if factory { "출력 대기" } else { "발송 대기" }));
    }
    let shipment_id = text(entry, "shipmentId");
    let shipments = state.get("workflow").map(|w| children(w, "shipments")).unwrap_or(&[]);
    let ship = find_by_id(shipments, shipment_id);
    let ship = match ship {
        Some(s) if active(s, "transferred") && s.get("step").and_then(Value::as_i64) == Some(4)
            && !active(s, "legacyArchived") => s,
        _ => return Err(format!("{} 이관이 완료된 배송 건인지 확인하세요.", label)),
    };
    let entry_id = text(entry, "id");
    if children(state, "exports").iter().any(|ex| children(ex, "queueEntryIds")
        .iter().any(|id| id.as_str() == Some(entry_id)))
        || state.get("workflow").map(|w| children(w, "queue")).unwrap_or(&[])
            .iter().any(|other| text(other, "id") != entry_id
                && text(other, "shipmentId") == shipment_id
                && text(other, "origin") == origin
                && text(other, "status") == "EXPORTED")
    {
        return Err(format!("이미 작성한 {} Excel이 있습니다. 출력 이력을 확인하세요.", label));
    }
    let order_id = text(ship, "orderId");
    let order = find_by_id(children(state, "orders"), order_id);
    let order = match order {
        Some(order) if text(order, "deletedAt").is_empty() => order,
        _ => return Err(if factory { "원본 주문을 찾을 수 없습니다." } else { "원본 주문을 찾지 못했습니다." }.into()),
    };
    let _ = order; // Check that the snapshot's source order still exists.
    let snapshot = &entry["snapshot"];
    let recipient = &snapshot["recipient"];
    let sender = &snapshot["sender"];
    if trimmed(recipient, "name").is_empty()
        || trimmed(recipient, "address").is_empty()
        || (trimmed(recipient, "phone").is_empty() && trimmed(recipient, "mobile").is_empty())
    {
        return Err("수취인 성함, 주소, 연락처가 누락되었습니다.".into());
    }
    if trimmed(sender, "name").is_empty()
        || trimmed(sender, "address").is_empty()
        || (trimmed(sender, "phone").is_empty() && trimmed(sender, "mobile").is_empty())
    {
        return Err("대리발송 송하인의 상호, 주소, 연락처가 누락되었습니다.".into());
    }
    let code = text(snapshot, "freightCode");
    if code != "010" && code != "020" {
        return Err("운임구분은 010(선불) 또는 020(착불)이어야 합니다.".into());
    }
    let items = children(recipient, "items");
    if items.is_empty() || items.iter().any(|item|
        text(item, "origin") != origin || trimmed(item, "name").is_empty()
            || item.get("quantity").and_then(valid_quantity).is_none()
    ) {
        return Err(format!("{} 출고 품목명과 수량이 불명확합니다.", label));
    }
    if factory {
        for item in items {
            validate_factory_product(state, item)?;
        }
    }
    let goods = if factory {
        items.iter().map(|item| {
            format!("◆ {} {}개", trimmed(item, "name"), item["quantity"].as_i64().unwrap())
        }).collect::<Vec<_>>().join(" ")
    } else {
        items.iter().map(|item| {
            let name = trimmed(item, "name");
            let color = trimmed(item, "color");
            let color_suffix = if color.is_empty() || color == "단일" {
                String::new()
            } else {
                format!(" {}", color)
            };
            format!("{}{} {}개", name, color_suffix, item["quantity"].as_i64().unwrap())
        }).collect::<Vec<_>>().join(" / ")
    };
    let sender_name = if text(sender, "displayName").is_empty() {
        trimmed(sender, "name")
    } else {
        trimmed(sender, "displayName")
    };
    let values = vec![
        trimmed(recipient, "name"), String::new(), trimmed(recipient, "address"),
        trimmed(recipient, "phone"), trimmed(recipient, "mobile"),
        String::new(), String::new(), code.to_owned(),
        goods, String::new(), trimmed(recipient, "note"), sender_name,
        trimmed(sender, "postcode"), trimmed(sender, "address"),
        trimmed(sender, "phone"), trimmed(sender, "mobile"),
    ];
    if values.len() != LOGEN_COLUMN_COUNT {
        return Err("로젠 열 수가 일치하지 않습니다.".into());
    }
    Ok(json!({
        "queueId": entry_id, "shipmentId": shipment_id, "orderId": order_id, "values": values
    }))
}
pub(super) fn prepare(state: &Value, ids: &Value, origin: &str) -> Result<Value, String> {
    if !state.is_object() {
        return Err("현재 주문 데이터를 확인할 수 없습니다.".into());
    }
    let ids = ids.as_array().ok_or("배송 건 선택 목록이 올바르지 않습니다.")?;
    if ids.is_empty() || ids.len() > 500 {
        return Err(if origin == "FACTORY" { "공장 배송 1~500건을 선택하세요." } else { "매장 배송 1~500건을 선택하세요." }.into());
    }
    let mut selected = HashSet::new();
    let mut shipments = HashSet::new();
    let mut rows = Vec::with_capacity(ids.len());
    let queue = state.get("workflow").map(|w| children(w, "queue")).unwrap_or(&[]);
    for id in ids {
        let id = id.as_str().ok_or("배송 건 선택 ID가 올바르지 않습니다.")?;
        if !selected.insert(id) {
            return Err("중복 선택한 배송 건이 있습니다.".into());
        }
        let entry = find_by_id(queue, id).ok_or(
            if origin == "FACTORY" {
                "이전 방식의 주문 또는 존재하지 않는 배송 건입니다. 주문 이관 상태를 확인하세요."
            } else {
                "존재하지 않거나 이관 전인 매장 배송 건입니다."
            }
        )?;
        let row = export_row(state, entry, origin)?;
        let shipment_id = row["shipmentId"].as_str().unwrap_or("");
        if !shipments.insert(shipment_id.to_owned()) {
            return Err(if origin == "FACTORY" {
                "동일 배송 건을 두 번 선택했습니다."
            } else { "동일 배송 건이 두 번 선택됐습니다." }.into());
        }
        rows.push(row);
    }
    Ok(json!({ "revision": state.get("revision").and_then(Value::as_i64).unwrap_or(0),
        "ids": ids, "rows": rows }))
}
