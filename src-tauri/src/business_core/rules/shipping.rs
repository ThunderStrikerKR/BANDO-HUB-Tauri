//! Port of shippingBundles / recommendShipping in src/shipping.ts.
//! Tariff selection is read-only; historical shipment charges are not rewritten.
use std::collections::{BTreeMap, BTreeSet};
use serde_json::{json, Value};
use super::{checked_sum, field, find_by_id, flag, has_value, rows, safe, str_field};

// Read-only shipping-manager projections from editableShippingRule and
// combinationCurrent. Active pricing never depends on historical tariff dates.
fn editable_rule(rule:&Value)->Value {
    let mut next=rule.clone();
    let price=field(rule,"perItem");
    if super::safe(price).is_some() {
        if !field(&next,"fees").is_object() {next["fees"]=json!({});}
        next["fees"]["1"]=price.clone();
        next["perItem"]=Value::Null;
        next["maxBundle"]=json!(1);
        next["maxConfirmed"]=json!(true);
    }
    next
}
fn current_combination(record:&Value,state:&Value,shipping:&Value)->bool {
    if !flag(record,"active")||field(record,"epoch")!=field(shipping,"epoch"){
        return false;
    }
    let Some(versions)=field(record,"versions").as_object() else{return false};
    for (key,version) in versions {
        let expected=if let Some(group_id)=key.strip_prefix("group:"){
            rows(field(shipping,"groups")).iter().any(|g|
                str_field(g,"id")==group_id &&
                field(field(g,"current"),"version")==version &&
                !field(g,"current").is_null())
        }else if let Some(pid)=key.strip_prefix("product:"){
            let rule=field(field(shipping,"productRules"),pid);
            let actual=if rule.is_null(){"unregistered"}else{str_field(rule,"version")};
            actual==version.as_str().unwrap_or("") 
        }else if let Some(pid)=key.strip_prefix("assignment:"){
            let product=find_by_id(field(state,"products"),pid);
            let group=product.map(|p|str_field(p,"shippingGroupId"))
                .filter(|v|!v.is_empty()).unwrap_or("individual");
            group==version.as_str().unwrap_or("")
        }else{
            rows(field(shipping,"groups")).iter().any(|g|
                str_field(g,"id")==key &&
                field(field(g,"current"),"version")==version)
        };
        if !expected{return false;}
    }
    true
}
// Source oracle: shipping.ts::effectiveShippingRule / editableShippingRule.
// Pure read-only projection: existing/current and historical rates are unchanged.
pub(super) fn product_freight_view(payload:&Value)->Result<Value,String>{
    let state=super::req(payload,"state")?;
    let shipping=field(state,"shipping");
    let mut by_product=serde_json::Map::new();
    for product in rows(field(state,"products")){
        let id=str_field(product,"id");
        let group_id=field(product,"shippingGroupId").as_str();
        let group=rows(field(shipping,"groups")).iter().find(|candidate|
            group_id==candidate.get("id").and_then(Value::as_str) &&
            !has_value(field(candidate,"deletedAt")));
        let rule=group.map(|g|field(g,"current"))
            .unwrap_or_else(||field(field(shipping,"productRules"),id));
        by_product.insert(id.into(),json!({
            "rule":rule,
            "group":group.cloned().unwrap_or(Value::Null),
            "editableRule":if rule.is_null(){Value::Null}else{editable_rule(rule)}
        }));
    }
    Ok(json!({"byProduct":by_product}))
}
pub(super) fn shipping_manager_view(payload:&Value)->Result<Value,String>{
    let state=super::req(payload,"state")?;
    let shipping=super::req(payload,"shipping")?;
    let mut editable=serde_json::Map::new();
    for group in rows(field(shipping,"groups")){
        editable.insert(str_field(group,"id").into(),editable_rule(field(group,"current")));
    }
    let mut current=serde_json::Map::new();
    for record in rows(field(shipping,"combinations")){
        current.insert(str_field(record,"id").into(),
            json!(current_combination(record,state,shipping)));
    }
    Ok(json!({"editableRules":editable,"currentCombinations":current}))
}
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
                let current = grouped.entry(key).or_default();
                *current = current.checked_add(quantity)
                    .ok_or_else(|| "수량 합계를 확인하세요.".to_string())?;
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
                    field(i,"quantity").as_i64().is_none_or(|q| q > super::MAX_SAFE)) {
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
                            .try_fold(0_i64, |sum, n| sum.checked_add(n))
                            .unwrap_or(i64::MAX);
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


/// State-changing tariff operations corresponding to src/shipping.ts. IDs and
/// timestamps are supplied by the caller instead of reading process globals.
pub(super) fn shipping_action(payload: &Value) -> Result<Value, String> {
    use super::{req, required_str, set};
    let action=required_str(payload,"action")?;
    match action {
        "upgrade" => {
            // src/shipping.ts::upgradeShipping: preserve every existing record
            // and append only missing historical base classifications.
            let mut shipping=req(payload,"shipping")?.clone();
            let now=required_str(payload,"now")?;
            for (prefix,label,names) in [
                ("music","일반 보면대",["경량형","표준형","중량형"]),
                ("microphone","일반 마이크스탠드",["소형 포장","중형 포장","대형 포장"])
            ] {
                for (i,name) in names.iter().enumerate() {
                    let id=format!("{prefix}-type-{}",i+1);
                    let exists=rows(field(&shipping,"groups")).iter()
                        .any(|g|str_field(g,"id")==id);
                    if exists {continue;}
                    let version=field(field(payload,"groupVersions"),&id)
                        .as_str().filter(|value|!value.is_empty())
                        .ok_or_else(||format!("기존 운임 그룹 버전 ID 누락: {id}"))?;
                    let group=json!({"id":id,"name":format!("{label} / {name}"),
                        "current":{
                            "version":version,"at":now,
                            "fees":{"1":null,"2":null,"3":null,"4":null,"5":null,"6":null},
                            "maxBundle":null,"maxConfirmed":false,"perItem":null,
                            "notes":"직원이 분류와 운임을 확인해 입력하세요."
                        },"history":[]});
                    shipping["groups"].as_array_mut().ok_or("운임 그룹 목록 누락")?
                        .push(group);
                }
            }
            Ok(json!({"shipping":shipping}))
        }
        "save_group_rule" => {
            // Port of ShippingManager::saveEditedRule. Preserve the old
            // current rate as immutable history, and leave other groups
            // untouched. The caller supplies version and timestamp.
            let mut shipping=req(payload,"shipping")?.clone();
            let group_id=required_str(payload,"groupId")?;
            let rule=req(payload,"rule")?;
            let over_limit=field(rule,"maxBundle").as_f64().is_some_and(|max| {
                field(rule,"fees").as_object().is_some_and(|fees| fees.iter().any(|(count,fee)| {
                    fee.is_number() && count.parse::<f64>().is_ok_and(|qty|qty>max)
                }))
            });
            if over_limit {
                return Err("최대 묶음 수량을 초과하는 운임 구간을 확인하세요.".into());
            }
            let version=required_str(payload,"versionId")?;
            let at=required_str(payload,"now")?;
            let index=rows(field(&shipping,"groups")).iter()
                .position(|g|str_field(g,"id")==group_id)
                .ok_or("수정할 운임 그룹이 없습니다.")?;
            let previous=field(&shipping["groups"][index],"current").clone();
            shipping["groups"][index]["history"].as_array_mut()
                .ok_or("그룹 운임 변경 이력을 확인하세요.")?.push(previous);
            let mut next=rule.clone();
            set(&mut next,"maxConfirmed",json!(!field(rule,"maxBundle").is_null()))?;
            set(&mut next,"version",json!(version))?;
            set(&mut next,"at",json!(at))?;
            let object=next.as_object_mut().ok_or("운임 규칙 형식 오류")?;
            for field in ["validFrom","validUntil","basis","packable"] {
                object.remove(field);
            }
            set(&mut shipping["groups"][index],"current",next)?;
            Ok(json!({"shipping":shipping}))
        }
        "copy_group_rule" => {
            // ProductFreightPanel: manually copy a confirmed group tariff
            // into selected standalone product tariff slots. Preserve the
            // per-product history, without changing group membership.
            let mut shipping=req(payload,"shipping")?.clone();
            let group_id=required_str(payload,"groupId")?;
            let selected=rows(req(payload,"productIds")?);
            let group=rows(field(&shipping,"groups")).iter()
                .find(|g|str_field(g,"id")==group_id)
                .ok_or("복사할 운임 그룹을 찾지 못했습니다.")?;
            let template=field(group,"current").clone();
            let now=required_str(payload,"now")?;
            if !field(&shipping,"productRules").is_object() {
                set(&mut shipping,"productRules",json!({}))?;
            }
            if !field(&shipping,"productHistory").is_object() {
                set(&mut shipping,"productHistory",json!({}))?;
            }
            for id in selected {
                let pid=id.as_str().ok_or("선택한 상품 ID를 확인하세요.")?;
                let old=field(&shipping["productRules"],pid).clone();
                if !old.is_null() {
                    if !field(&shipping["productHistory"],pid).is_array() {
                        set(&mut shipping["productHistory"],pid,json!([]))?;
                    }
                    shipping["productHistory"][pid].as_array_mut()
                        .ok_or("상품 운임 이력 형식 오류")?.push(old);
                }
                let version=required_str(field(payload,"versionIds"),pid)?;
                let mut copy=template.clone();
                set(&mut copy,"version",json!(version))?;
                set(&mut copy,"at",json!(now))?;
                set(&mut shipping["productRules"],pid,copy)?;
            }
            Ok(json!({"shipping":shipping}))
        }
        "assign_products" => {
            // ShippingManager::savePending: batch assignment changes apply to
            // current products only; clearing an assignment issues a fresh
            // standalone unresolved tariff and archives any earlier version.
            let mut state=req(payload,"state")?.clone();
            let assignments=req(payload,"assignments")?.as_object()
                .ok_or("배송 그룹 지정 내역 형식 오류")?;
            let now=required_str(payload,"now")?;
            if !field(&state,"shipping").is_object() {
                return Err("운임 기준을 확인하세요.".into());
            }
            for (pid,group) in assignments {
                let target=group.as_str().ok_or("배송 그룹 값을 확인하세요.")?;
                if !target.is_empty() { continue; }
                if !field(&state["shipping"],"productRules").is_object() {
                    set(&mut state["shipping"],"productRules",json!({}))?;
                }
                if !field(&state["shipping"],"productHistory").is_object() {
                    set(&mut state["shipping"],"productHistory",json!({}))?;
                }
                let previous=field(field(&state["shipping"],"productRules"),pid).clone();
                if !previous.is_null() {
                    if !field(&state["shipping"]["productHistory"],pid).is_array() {
                        set(&mut state["shipping"]["productHistory"],pid,json!([]))?;
                    }
                    state["shipping"]["productHistory"][pid].as_array_mut()
                        .ok_or("이전 상품 운임 기록 형식 오류")?.push(previous);
                }
                let version=required_str(field(payload,"versionIds"),pid)?;
                let current=json!({
                    "version":version,"at":now,
                    "fees":{"1":null,"2":null,"3":null,"4":null,"5":null,"6":null},
                    "maxBundle":null,"maxConfirmed":false,"perItem":null,
                    "notes":"상품의 최대 묶음 수량과 운임을 확인해 입력하세요."
                });
                set(&mut state["shipping"]["productRules"],pid,current)?;
            }
            for product in state["products"].as_array_mut()
                .ok_or("상품 목록을 확인하세요.")? {
                let pid=str_field(product,"id");
                let Some(group)=assignments.get(pid).and_then(Value::as_str) else {continue};
                if group.is_empty() {
                    product.as_object_mut().ok_or("상품 정보 형식 오류")?
                        .remove("shippingGroupId");
                } else {
                    set(product,"shippingGroupId",json!(group))?;
                }
            }
            Ok(json!({"state":state}))
        }
        "save_product_rule" => {
            // Port of ProductFreightPanel::writeRule for a standalone product.
            // Older versions must remain intact even when the new group
            // assignment later replaces which tariff is currently used.
            let mut shipping=req(payload,"shipping")?.clone();
            let product_id=required_str(payload,"productId")?;
            let rule=req(payload,"rule")?;
            let over_limit=field(rule,"maxBundle").as_f64().is_some_and(|max| {
                field(rule,"fees").as_object().is_some_and(|fees| fees.iter().any(|(count,fee)| {
                    fee.is_number() && count.parse::<f64>().is_ok_and(|qty|qty>max)
                }))
            });
            if over_limit {
                return Err("최대 묶음 수량을 초과하는 운임 구간을 삭제하거나 수량을 다시 설정하세요.".into());
            }
            if !field(&shipping,"productRules").is_object() {
                set(&mut shipping,"productRules",json!({}))?;
            }
            if !field(&shipping,"productHistory").is_object() {
                set(&mut shipping,"productHistory",json!({}))?;
            }
            let old=field(field(&shipping,"productRules"),product_id).clone();
            if !old.is_null() {
                if !field(&shipping["productHistory"],product_id).is_array() {
                    set(&mut shipping["productHistory"],product_id,json!([]))?;
                }
                shipping["productHistory"][product_id].as_array_mut()
                    .ok_or("상품 운임 변경 이력을 확인하세요.")?.push(old);
            }
            let mut next=rule.clone();
            set(&mut next,"maxConfirmed",json!(!field(rule,"maxBundle").is_null()))?;
            set(&mut next,"version",json!(required_str(payload,"versionId")?))?;
            set(&mut next,"at",json!(required_str(payload,"now")?))?;
            let object=next.as_object_mut().ok_or("운임 규칙 형식 오류")?;
            for key in ["validFrom","validUntil","basis","packable"] {
                object.remove(key);
            }
            set(&mut shipping["productRules"],product_id,next)?;
            Ok(json!({"shipping":shipping}))
        }
        "create_group" => {
            // ShippingManager: staff adds a new, unconfirmed packaging group.
            let mut shipping=req(payload,"shipping")?.clone();
            let id=required_str(payload,"groupId")?;
            let name=required_str(payload,"name")?.trim();
            let version=required_str(payload,"versionId")?;
            let now=required_str(payload,"now")?;
            if name.is_empty() {return Err("새 배송 그룹명을 입력하세요.".into());}
            if rows(field(&shipping,"groups")).iter().any(|g|
                str_field(g,"name")==name) {
                return Err("같은 배송 그룹이 있습니다.".into());
            }
            shipping["groups"].as_array_mut().ok_or("운임 그룹 목록 오류")?.push(json!({
                "id":id,"name":name,
                "current":{"version":version,"at":now,"fees":{},"maxBundle":null,
                    "maxConfirmed":false,"perItem":null,"notes":"운임 확인 필요"},
                "history":[]
            }));
            Ok(json!({"shipping":shipping}))
        }
        "rename_group" => {
            // Match ShippingManager::rename group: does not rotate tariff
            // versions and must not erase existing rate history.
            let mut shipping=req(payload,"shipping")?.clone();
            let group_id=required_str(payload,"groupId")?;
            let name=required_str(payload,"name")?.trim();
            if name.is_empty() {return Err("배송 그룹명을 입력하세요.".into());}
            let index=rows(field(&shipping,"groups")).iter()
                .position(|g|str_field(g,"id")==group_id)
                .ok_or("수정할 운임 그룹이 없습니다.")?;
            set(&mut shipping["groups"][index],"name",json!(name))?;
            Ok(json!({"shipping":shipping}))
        }
        "revise_combination" => {
            // ShippingManager history: a manual price revision retires
            // only the selected combination and retains its charge/actual
            // metadata on a new active version. Calculation of the version
            // fingerprint uses the actual current product/group assignments.
            let mut shipping=req(payload,"shipping")?.clone();
            let state=req(payload,"state")?;
            let source_id=required_str(payload,"combinationId")?;
            let new_id=required_str(payload,"newId")?;
            let charge=safe(req(payload,"charge")?)
                .ok_or("올바른 운임을 입력하세요.")?;
            let now=required_str(payload,"now")?;
            let index=rows(field(&shipping,"combinations")).iter()
                .position(|v|str_field(v,"id")==source_id)
                .ok_or("수정할 예외 운임 기록이 없습니다.")?;
            let original=shipping["combinations"][index].clone();
            let key=str_field(&original,"key");
            let versions=combination_versions(key,&shipping,state);
            let mut next=original.clone();
            let obj=next.as_object_mut().ok_or("예외 운임 기록 형식 오류")?;
            for key in ["verifiedAt","shipmentId","observedCharge"] {
                obj.remove(key);
            }
            set(&mut next,"sampleCount",json!(0))?;
            set(&mut next,"id",json!(new_id))?;
            set(&mut next,"charge",json!(charge))?;
            set(&mut next,"epoch",field(&shipping,"epoch").clone())?;
            set(&mut next,"versions",versions_value(&versions))?;
            set(&mut next,"at",json!(now))?;
            set(&mut next,"active",json!(true))?;
            set(&mut shipping["combinations"][index],"active",json!(false))?;
            shipping["combinations"].as_array_mut()
                .ok_or("예외 운임 이력 형식 오류")?.push(next);
            Ok(json!({"shipping":shipping}))
        }
        "save_combination" => {
            let mut shipping=req(payload,"shipping")?.clone();
            let bundle=req(payload,"bundle")?;
            let charge=safe(req(payload,"charge")?)
                .ok_or("운임은 0 이상의 원 단위 정수로 입력하세요.")?;
            let actual=field(payload,"actual");
            if !actual.is_null() && safe(actual).is_none() {
                return Err("운임은 0 이상의 원 단위 정수로 입력하세요.".into());
            }
            let id=required_str(payload,"combinationId")?;
            let at=required_str(payload,"now")?;
            if find_by_id(field(&shipping,"combinations"),id).is_some() {
                return Err("운임 조합 ID가 중복됩니다.".into());
            }
            let key=str_field(bundle,"key");
            for previous in shipping["combinations"].as_array_mut()
                .ok_or("운임 조합 목록 누락")? {
                if str_field(previous,"key")==key && flag(previous,"active") {
                    set(previous,"active",json!(false))?;
                }
            }
            let combination=json!({
                "id":id,"key":key,"epoch":field(&shipping,"epoch"),
                "versions":field(bundle,"versions"),"charge":charge,
                "actual":actual,"at":at,"active":true,
                "description":field(bundle,"description")
            });
            shipping["combinations"].as_array_mut()
                .ok_or("운임 조합 목록 누락")?.push(combination);
            Ok(json!({"shipping":shipping}))
        }
        "delete_group" => {
            let mut state=req(payload,"state")?.clone();
            let id=required_str(payload,"groupId")?;
            let idx=rows(field(field(&state,"shipping"),"groups")).iter().position(|g|
                str_field(g,"id")==id && !has_value(field(g,"deletedAt")))
                .ok_or("현재 그룹이 없습니다.")?;
            let linked=rows(field(&state,"products")).iter().filter(|p|
                !has_value(field(p,"deletedAt")) &&
                !has_value(field(p,"supersededBy")) &&
                str_field(p,"shippingGroupId")==id)
                .map(|p|str_field(p,"name").to_string())
                .collect::<Vec<_>>();
            if !linked.is_empty() && !flag(payload,"detach") {
                return Err(format!("사용 중인 상품: {}",linked.join(", ")));
            }
            for product in state["products"].as_array_mut().ok_or("상품 목록 누락")? {
                if str_field(product,"shippingGroupId")==id {
                    product.as_object_mut().ok_or("상품 정보 오류")?.remove("shippingGroupId");
                }
            }
            set(&mut state["shipping"]["groups"][idx],"deletedAt",
                json!(required_str(payload,"now")?))?;
            for combination in state["shipping"]["combinations"].as_array_mut()
                .ok_or("운임 조합 목록 누락")? {
                if has_value(field(field(combination,"versions"),&format!("group:{id}"))) {
                    set(combination,"active",json!(false))?;
                }
            }
            Ok(json!({"state":state}))
        }
        "change_basis" => {
            let mut shipping=req(payload,"shipping")?.clone();
            let group_id=payload.get("groupId").and_then(Value::as_str);
            let now=required_str(payload,"now")?;
            if group_id.is_none() {
                let epoch=field(&shipping,"epoch").as_i64().unwrap_or(1);
                set(&mut shipping,"epoch",json!(epoch+1))?;
                let rules=field(&shipping,"productRules").as_object()
                    .cloned().unwrap_or_default();
                for (pid,old) in rules {
                    if !shipping["productHistory"].is_object() {
                        set(&mut shipping,"productHistory",json!({}))?;
                    }
                    if !shipping["productHistory"][&pid].is_array() {
                        set(&mut shipping["productHistory"],&pid,json!([]))?;
                    }
                    shipping["productHistory"][&pid].as_array_mut()
                        .ok_or("운임 이력 오류")?.push(old.clone());
                    let new_version=field(field(payload,"productVersions"),&pid)
                        .as_str().filter(|v|!v.is_empty())
                        .ok_or_else(||format!("상품 운임 버전 ID 누락: {pid}"))?;
                    let mut next=old;
                    set(&mut next,"version",json!(new_version))?;
                    set(&mut next,"at",json!(now))?;
                    set(&mut next,"fees",json!({}))?;
                    set(&mut next,"perItem",Value::Null)?;
                    set(&mut next,"notes",json!("새 기준의 운임 확인 필요"))?;
                    set(&mut shipping["productRules"],&pid,next)?;
                }
            }
            for group in shipping["groups"].as_array_mut()
                .ok_or("운임 그룹 목록 누락")? {
                let group_key=str_field(group,"id").to_string();
                if group_id.is_some_and(|id|id!=group_key) {continue;}
                let new_version=field(field(payload,"groupVersions"),&group_key)
                    .as_str().filter(|v|!v.is_empty())
                    .ok_or_else(||format!("그룹 운임 버전 ID 누락: {group_key}"))?;
                let old=field(group,"current").clone();
                if !field(group,"history").is_array() {set(group,"history",json!([]))?;}
                group["history"].as_array_mut().ok_or("운임 이력 오류")?.push(old.clone());
                let mut next=old;
                set(&mut next,"version",json!(new_version))?;
                set(&mut next,"at",json!(now))?;
                set(&mut next,"fees",json!({
                    "1":null,"2":null,"3":null,"4":null,"5":null,"6":null
                }))?;
                set(&mut next,"perItem",Value::Null)?;
                set(&mut next,"notes",json!("새 기준의 운임 확인 필요"))?;
                set(group,"current",next)?;
            }
            Ok(json!({"shipping":shipping}))
        }
        "editable_rule" => {
            let mut rule=req(payload,"rule")?.clone();
            if let Some(per_item)=safe(field(&rule,"perItem")) {
                if !field(&rule,"fees").is_object() {set(&mut rule,"fees",json!({}))?;}
                set(&mut rule["fees"],"1",json!(per_item))?;
                set(&mut rule,"perItem",Value::Null)?;
                set(&mut rule,"maxBundle",json!(1))?;
                set(&mut rule,"maxConfirmed",json!(true))?;
            }
            Ok(json!({"rule":rule}))
        }
        "combination_versions" => {
            let state=req(payload,"state")?;
            let key=required_str(payload,"key")?;
            let fallback;
            let shipping=if field(state,"shipping").is_object() {field(state,"shipping")}
                else {fallback=initial_shipping(); &fallback};
            let versions=combination_versions(key,shipping,state);
            Ok(json!({"versions":versions_value(&versions)}))
        }
        "combination_current" => {
            let state=req(payload,"state")?;
            let c=req(payload,"combination")?;
            let shipping=field(state,"shipping");
            if !shipping.is_object() || !flag(c,"active") ||
                field(c,"epoch")!=field(shipping,"epoch") {
                return Ok(json!({"current":false}));
            }
            let current=field(c,"versions").as_object().is_some_and(|versions|
                versions.iter().all(|(key,version)| {
                    if let Some(id)=key.strip_prefix("group:") {
                        rows(field(shipping,"groups")).iter().any(|g|
                            str_field(g,"id")==id &&
                            field(field(g,"current"),"version")==version &&
                            field(g,"current").is_object())
                    } else if let Some(id)=key.strip_prefix("product:") {
                        let rule=field(field(shipping,"productRules"),id);
                        if rule.is_object() {field(rule,"version")==version}
                        else {version=="unregistered"}
                    } else if let Some(id)=key.strip_prefix("assignment:") {
                        let assigned=find_by_id(field(state,"products"),id)
                            .map(|p|str_field(p,"shippingGroupId"))
                            .filter(|id|!id.is_empty()).unwrap_or("individual");
                        version==assigned
                    } else {
                        rows(field(shipping,"groups")).iter().find(|g|
                            str_field(g,"id")==key).is_some_and(|g|
                                field(field(g,"current"),"version")==version)
                    }
                })
            );
            Ok(json!({"current":current}))
        }
        _=>Err(format!("지원하지 않는 운임 action: {action}"))
    }
}
