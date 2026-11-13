//! Port of shippingBundles / recommendShipping in src/shipping.ts.
//! Tariff selection is read-only; historical shipment charges are not rewritten.
use std::collections::{BTreeMap, BTreeSet};
use serde_json::{json, Value};
use super::{checked_sum, field, find_by_id, flag, has_value, rows, safe, str_field};

fn initial_shipping() -> Value {
    // The seed tariff values are from initialShipping(). Versions in the
    // persisted SQLite state always take precedence over these fallbacks.
    let group = |id: &str, name: &str, fees: Value, max: Value, confirmed: bool, per_item: Value| {
        json!({"id":id,"name":name,"current":{
            "version":"unpersisted-initial-tariff","fees":fees,
            "maxBundle":max,"maxConfirmed":confirmed,"perItem":per_item
        }})
    };
    json!({"epoch":1,"productRules":{},"combinations":[],"groups":[
        group("music","일반 보면대",json!({"1":3000,"2":4000,"3":null,"4":null,"5":null,"6":null}),json!(4),false,Value::Null),
        group("microphone","일반 마이크스탠드",json!({"1":3000,"2":4000,"3":null,"4":null,"5":null,"6":null}),Value::Null,false,Value::Null),
        group("940","940 계열",json!({"1":null,"2":null,"3":null,"4":null,"5":null,"6":null}),Value::Null,false,Value::Null),
        group("conductor","지휘자 스탠드",json!({}),json!(1),true,json!(5000))
    ]})
}
fn assign(versions: &mut Vec<(String, String)>, key: String, value: String) {
    if let Some(entry) = versions.iter_mut().find(|(k, _)| k == &key) {
        entry.1 = value;
    } else {
        versions.push((key, value));
    }
}
fn versions_value(pairs: &[(String, String)]) -> Value {
    let mut m = serde_json::Map::new();
    for (k, v) in pairs {
        m.insert(k.clone(), json!(v));
    }
    Value::Object(m)
}
fn versions_json(pairs: &[(String, String)]) -> String {
    let inner = pairs.iter().map(|(k, v)| {
        format!("{}:{}", json!(k), json!(v))
    }).collect::<Vec<_>>().join(",");
    format!("{{{inner}}}")
}
fn active_group<'a>(shipping: &'a Value, product: &Value) -> Option<&'a Value> {
    let group_id = str_field(product, "shippingGroupId");
    rows(field(shipping, "groups")).iter()
        .find(|g| str_field(g, "id") == group_id && !has_value(field(g, "deletedAt")))
}
fn rule_for<'a>(shipping: &'a Value, product: &Value) -> (Option<&'a Value>, Option<&'a Value>) {
    let group = active_group(shipping, product);
    let rule = group.map(|g| field(g, "current"))
        .or_else(|| field(field(shipping, "productRules"), str_field(product, "id"))
            .as_object().map(|_| field(field(shipping, "productRules"), str_field(product, "id"))));
    (group, rule)
}
fn combination_versions(key: &str, shipping: &Value, state: &Value) -> Vec<(String, String)> {
    let mut versions = Vec::new();
    for chunk in key.split('|').skip(1) {
        let pid = chunk.split('@').next().unwrap_or("");
        let product = find_by_id(field(state, "products"), pid);
        let group = product.and_then(|p| active_group(shipping, p));
        let group_id = group.map(|g| str_field(g, "id")).unwrap_or("individual");
        assign(&mut versions, format!("assignment:{pid}"), group_id.to_string());
        let rule_key = group.map(|g| format!("group:{}",str_field(g,"id")))
            .unwrap_or_else(|| format!("product:{pid}"));
        let version = group.map(|g| str_field(field(g,"current"),"version"))
            .or_else(|| {
                field(field(shipping,"productRules"),pid).get("version").and_then(Value::as_str)
            })
            .unwrap_or("unregistered");
        assign(&mut versions, rule_key, version.to_string());
    }
    versions
}
fn valid_item(item: &Value) -> bool {
    !str_field(item,"productId").is_empty()
        && !str_field(item,"variantId").is_empty()
        && field(item,"quantity").as_i64().is_some_and(|q| q != 0)
}
pub(super) fn recommend(order: &Value, state: &Value) -> Result<Value, String> {
    let fallback;
    let shipping = if has_value(field(state,"shipping")) { field(state,"shipping") }
        else { fallback = initial_shipping(); &fallback };
    let epoch = field(shipping,"epoch").as_i64().unwrap_or(1);
    let mut bundles: Vec<Value> = Vec::new();
    let mut versions_for_string: Vec<String> = Vec::new();
    for recipient in rows(field(order,"recipients")) {
        for origin in ["STORE","FACTORY"] {
            let items: Vec<Value> = rows(field(recipient,"items")).iter()
                .filter(|i| str_field(i,"origin") == origin).cloned().collect();
            if items.is_empty() { continue; }
            let mut grouped: BTreeMap<String,i64> = BTreeMap::new();
            for item in &items {
                let product = field(item,"productId").as_str().unwrap_or("?");
                let variant = field(item,"variantId").as_str().unwrap_or("?");
                let key = format!("{product}@{variant}");
                let quantity = field(item,"quantity").as_i64().unwrap_or(0);
                *grouped.entry(key).or_default() += quantity;
            }
            let key = format!("{}|{}",origin,grouped.iter()
                .map(|(name, quantity)| format!("{name}:{quantity}"))
                .collect::<Vec<_>>().join("|"));
            let mut versions = combination_versions(&key,shipping,state);
            let mut by_group: Vec<(String,Vec<Value>,Value,String)> = Vec::new();
            let mut unknown = false;
            let mut expired = false;
            for item in &items {
                let product = find_by_id(field(state,"products"),str_field(item,"productId"));
                let Some(product) = product else { unknown = true; continue };
                let (group, basis) = rule_for(shipping,product);
                if has_value(field(recipient,"dispatchOrigin"))
                    && str_field(product,"origin") != origin {
                    unknown = true;
                    continue;
                }
                let Some(rule) = basis else {
                    unknown = true;
                    continue;
                };
                // A ShippingRule exists regardless of the legacy validity dates.
                if !rule.is_object() {
                    unknown = true;
                    expired = true;
                    continue;
                }
                let effective = group.map(|g| format!("group:{}",str_field(g,"id")))
                    .unwrap_or_else(|| format!("product:{}",str_field(product,"id")));
                assign(&mut versions,effective.clone(),str_field(rule,"version").to_string());
                assign(&mut versions,
                    format!("assignment:{}",str_field(product,"id")),
                    group.map(|g| str_field(g,"id")).unwrap_or("individual").to_string());
                let name = group.map(|g| str_field(g,"name"))
                    .unwrap_or_else(|| str_field(product,"name")).to_string();
                if let Some(entry) = by_group.iter_mut().find(|(k,_,_,_)| *k == effective) {
                    entry.1.push(item.clone());
                    entry.2 = rule.clone();
                } else {
                    by_group.push((effective,vec![item.clone()],rule.clone(),name));
                }
            }
            let values = versions_value(&versions);
            let known = rows(field(shipping,"combinations")).iter()
                .filter(|c| flag(c,"active") && str_field(c,"key") == key &&
                    field(c,"epoch").as_i64() == Some(epoch) &&
                    field(c,"versions") == &values)
                .max_by(|a,b| str_field(a,"at").cmp(str_field(b,"at")));
            let (recommendation,reason,source): (Option<i64>,String,&str) =
                if items.iter().any(|i| !valid_item(i) ||
                    field(i,"quantity").as_i64().is_none_or(|q| q < 0 || q > super::MAX_SAFE)) {
                    (None,"상품/옵션/수량 확인 필요".into(),"MANUAL")
                } else if let Some(known) = known.filter(|_| !expired) {
                    (safe(field(known,"charge")),"현재 기준의 확인된 동일 조합".into(),"COMBINATION")
                } else if unknown {
                    (None,"상품별 기본 운임 미등록 / 직원 확인 필요".into(),"MANUAL")
                } else {
                    let mut charges = Vec::new();
                    let mut reason = String::new();
                    for (_key, group_items, rule, group_name) in &by_group {
                        let q = group_items.iter().filter_map(|i| field(i,"quantity").as_i64())
                            .sum::<i64>();
                        if group_items.iter().any(|i| field(i,"quantity").as_i64()
                            .is_none_or(|n| n == 0)) {
                            reason = "수량 확인 필요".into(); break;
                        }
                        if let Some(per_item) = safe(field(rule,"perItem")) {
                            if let Some(v) = per_item.checked_mul(q).filter(|n| safe(&json!(n)).is_some()) {
                                charges.push(v);
                                continue;
                            }
                            reason = "운임 금액 오류".into(); break;
                        }
                        if flag(rule,"maxConfirmed") && field(rule,"maxBundle").as_i64() == Some(1) {
                            if let Some(single) = safe(field(field(rule,"fees"),"1")) {
                                if let Some(v) = single.checked_mul(q).filter(|n| safe(&json!(n)).is_some()) {
                                    charges.push(v); continue;
                                }
                            }
                            reason = format!("{group_name} 1개 운임 확인 필요"); break;
                        }
                        if flag(rule,"maxConfirmed") &&
                            field(rule,"maxBundle").as_i64().is_some_and(|m| q > m) {
                            reason = format!("{group_name} 합포장 제한 초과 / 운임 확인 필요"); break;
                        }
                        if let Some(fee) = safe(field(field(rule,"fees"),&q.to_string())) {
                            charges.push(fee);
                        } else {
                            reason = format!("{group_name} {q}개 운임 확인 필요"); break;
                        }
                    }
                    if reason.is_empty() && !by_group.is_empty() {
                        (checked_sum(charges),"현재 상품별/동급 그룹 기본 운임표".into(),"GROUP")
                    } else {
                        (None,reason,"MANUAL")
                    }
                };
            let description = format!("{} / {}",
                if str_field(recipient,"name").is_empty() {"수취인 확인"}
                else {str_field(recipient,"name")},
                items.iter().map(|i| {
                    let q = if field(i,"quantity").is_null() {"null".to_string()}
                        else {field(i,"quantity").to_string()};
                    format!("{} × {q}",str_field(i,"name"))
                }).collect::<Vec<_>>().join(" + "));
            versions_for_string.push(versions_json(&versions));
            bundles.push(json!({
                "key":key,"recipientId":field(recipient,"id"),"origin":origin,
                "items":items,"versions":values,"description":description,
                "recommendation":recommendation,"reason":reason,"source":source
            }));
        }
    }
    let total = if bundles.is_empty() || bundles.iter()
        .any(|b| !has_value(field(b,"recommendation"))) {
        None
    } else {
        bundles.iter().map(|b| safe(field(b,"recommendation")))
            .collect::<Option<Vec<_>>>().and_then(checked_sum)
    };
    let version = format!("{{\"epoch\":{epoch},\"groups\":[{}]}}",
        versions_for_string.join(","));
    Ok(json!({"bundles":bundles,"total":total,"version":version}))
}
