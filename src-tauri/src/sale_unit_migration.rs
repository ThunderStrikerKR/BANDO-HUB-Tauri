//! Conservative one-time migration from old homepage groups (many variants)
 //! to one independent saleable product per actual selling configuration.
 //! The curated seed is the authority for historic public site mappings.
use serde_json::{json,Value};
use std::collections::{HashMap,HashSet};

fn arr<'a>(s:&'a Value,key:&str)->Result<&'a Vec<Value>,String>{
    s.get(key).and_then(Value::as_array).ok_or_else(||format!("{key} 배열이 없습니다."))
}
fn ident<'a>(s:&'a Value,label:&str)->Result<&'a str,String>{
    s.get("id").and_then(Value::as_str).filter(|s|!s.is_empty())
        .ok_or_else(||format!("{label} 고유 ID가 없습니다."))
}
pub(super) fn transform(mut state:Value)->Result<Value,String>{
    let reference:Value=serde_json::from_str(include_str!("../resources/state-seed.json"))
        .map_err(|e|e.to_string())?;
    let mut by_legacy:HashMap<(String,String),Value>=HashMap::new();
    for candidate in arr(&reference,"products")?{
        if let Some(source)=candidate["sourceProductId"].as_str(){
            let v=arr(candidate,"variants")?.first().ok_or("정리된 상품의 가격 정보가 없습니다.")?;
            by_legacy.insert((source.to_string(),ident(v,"가격 기록")?.to_string()),candidate.clone());
        }
    }
    let original=arr(&state,"products")?.clone();
    let mut products=Vec::new();
    let mut changes:HashMap<(String,String),String>=HashMap::new();
    let mut affected:HashSet<String>=HashSet::new();
    for p in &original {
        let id=ident(p,"기존 상품")?.to_owned();
        let variants=arr(p,"variants")?;
        if variants.len()==1 {
            let mut existing=p.clone();
            existing["saleUnit"]=json!(true);
            existing["requiresOption"]=json!(false);
            products.push(existing);
            continue;
        }
        if variants.is_empty() {
            return Err(format!("상품 {id}에 가격 기록이 없습니다."));
        }
        affected.insert(id.clone());
        for v in variants {
            let vid=ident(v,"기존 가격 기록")?.to_string();
            let template=by_legacy.get(&(id.clone(),vid.clone()))
                .ok_or_else(||format!("상품 {id}의 판매 구성 {vid}은 원본 303개 목록에서 안전하게 확인되지 않았습니다. 변경 전 백업을 보존하고 중단합니다."))?;
            let mut unit=p.clone();
            unit["id"]=template["id"].clone();
            unit["name"]=template["name"].clone();
            unit["code"]=template["code"].clone();
            unit["sourceProductId"]=json!(id);
            unit["familyKey"]=template["familyKey"].clone();
            unit["modelKey"]=template["modelKey"].clone();
            unit["modelCodes"]=template["modelCodes"].clone();
            unit["defaultColor"]=v["color"].clone();
            unit["variants"]=json!([v]);
            unit["saleUnit"]=json!(true);
            unit["requiresOption"]=json!(false);
            if unit.get("originalName").is_none(){
                unit["originalName"]=p["name"].clone();
            }
            if unit.get("originalCode").is_none(){
                unit["originalCode"]=p["code"].clone();
            }
            if let Some(extra)=template.get("dataIssues"){
                let mut issues=unit.get("dataIssues").and_then(Value::as_array)
                    .cloned().unwrap_or_default();
                for issue in extra.as_array().into_iter().flatten(){
                    if !issues.contains(issue){issues.push(issue.clone());}
                }
                unit["dataIssues"]=json!(issues);
            }
            let dest=ident(&unit,"독립 상품")?.to_string();
            changes.insert((id.clone(),vid),dest);
            products.push(unit);
        }
    }
    if products.iter().any(|p|arr(p,"variants").map_or(true,|v|v.len()!=1)){
        return Err("독립 상품으로 분리되지 않은 상품이 있습니다.".into());
    }
    let mut all=HashSet::new();
    for p in &products {
        let id=ident(p,"독립 상품")?;
        if !all.insert(id.to_string()) {return Err(format!("독립 상품 ID 중복: {id}"));}
    }
    // Draft order references are remapped by an exact historical price ID.
    // Confirmed immutable orders keep the original frozen product references.
    if let Some(orders)=state["orders"].as_array_mut(){
        for order in orders {
            if order["confirmedAt"].as_str().is_some_and(|s|!s.is_empty()){continue;}
            if let Some(recipients)=order["recipients"].as_array_mut(){
                for recipient in recipients {
                    if let Some(items)=recipient["items"].as_array_mut(){
                        for item in items {
                            let Some(id)=item["productId"].as_str() else {continue};
                            if !affected.contains(id){continue;}
                            let vid=item["variantId"].as_str().unwrap_or("");
                            let dest=changes.get(&(id.to_string(),vid.to_string()))
                                .ok_or_else(||format!("미확정 주문에서 상품 {id}의 판매 구성 ID가 불명확해 이전을 중단합니다."))?;
                            item["originalProductId"]=json!(id);
                            item["productId"]=json!(dest);
                        }
                    }
                }
            }
        }
    }
    // Do not invent a default selection when an alias describes multiple sale units.
    if let Some(aliases)=state["aliases"].as_array_mut(){
        for alias in aliases {
            let Some(id)=alias["productId"].as_str() else {continue};
            if !affected.contains(id){continue;}
            let vid=alias["variantId"].as_str().unwrap_or("");
            let dest=changes.get(&(id.to_string(),vid.to_string()))
                .ok_or_else(||format!("별칭에서 상품 {id}의 판매 구성 ID가 누락됐습니다. 임의 연결하지 않았습니다."))?;
            alias["productId"]=json!(dest);
        }
    }
    if let Some(links)=state["sourceLinks"].as_array_mut(){
        for link in links {
            let Some(id)=link["productId"].as_str() else {continue};
            if !affected.contains(id){continue;}
            let matches=original.iter().filter(|p|p["id"].as_str()==Some(id))
                .flat_map(|p|p["variants"].as_array().into_iter().flatten())
                .filter(|v|v["siteOptionId"].as_str()==link["optionId"].as_str())
                .filter_map(|v|v["id"].as_str())
                .filter_map(|vid|changes.get(&(id.to_string(),vid.to_string())))
                .collect::<Vec<_>>();
            if matches.len()!=1 {
                return Err(format!("공식 사이트 연결의 상품 {id} 옵션 식별자가 불명확합니다. 원본을 보존합니다."));
            }
            link["productId"]=json!(matches[0]);
        }
    }
    if let Some(representatives)=state["settings"]["modelRepresentatives"].as_object_mut(){
        for config in representatives.values_mut(){
            let Some(id)=config["productId"].as_str() else {continue};
            if !affected.contains(id){continue;}
            let vid=config["variantId"].as_str().unwrap_or("");
            let dest=changes.get(&(id.to_string(),vid.to_string()))
                .ok_or_else(||format!("모델군 대표의 상품 {id} 가격 기록이 불명확합니다."))?;
            config["productId"]=json!(dest);
        }
    }
    if let Some(map)=state["productMappings"].as_object_mut(){
        for ((id,vid),target) in &changes {
            map.insert(format!("{id}|{vid}"),json!(target));
        }
    }else if !changes.is_empty(){
        let mut map=serde_json::Map::new();
        for ((id,vid),target) in &changes{
            map.insert(format!("{id}|{vid}"),json!(target));
        }
        state["productMappings"]=Value::Object(map);
    }
    state["products"]=json!(products);
    Ok(state)
}

#[cfg(test)]
mod tests{
    use super::*;
    #[test]
    fn converts_all_original_303_website_groups_into_360_distinct_sale_units(){
        let old:Value=serde_json::from_str(include_str!("../resources/legacy-state-seed-303.json")).unwrap();
        let result=transform(old.clone()).unwrap();
        assert_eq!(old["products"].as_array().unwrap().len(),303);
        assert_eq!(result["products"].as_array().unwrap().len(),360);
        let old_prices=old["products"].as_array().unwrap().iter()
            .flat_map(|p|p["variants"].as_array().unwrap())
            .map(|v|(v["id"].clone(),v["retail"].clone())).collect::<Vec<_>>();
        let new_prices=result["products"].as_array().unwrap().iter()
            .map(|p|(&p["variants"][0]["id"],&p["variants"][0]["retail"]))
            .map(|(id,price)|(id.clone(),price.clone())).collect::<Vec<_>>();
        assert_eq!(old_prices,new_prices);
        assert!(result["products"].as_array().unwrap().iter()
            .all(|p|p["variants"].as_array().unwrap().len()==1));
    }
    #[test]
    fn preserves_custom_prices_special_overrides_scoped_aliases_and_both_order_states(){
        let mut old:Value=serde_json::from_str(
            include_str!("../resources/legacy-state-seed-303.json")).unwrap();
        let pos=old["products"].as_array().unwrap().iter()
            .position(|p|p["id"]=="bando-site-351").unwrap();
        let original_id="bando-site-351";
        let first=old["products"][pos]["variants"][0]["id"].as_str().unwrap().to_string();
        let second=old["products"][pos]["variants"][1]["id"].as_str().unwrap().to_string();
        let first_option=old["products"][pos]["variants"][0]["siteOptionId"].clone();
        let second_option=old["products"][pos]["variants"][1]["siteOptionId"].clone();

        // Deliberately non-default employee prices must override the bundled template.
        old["products"][pos]["variants"][0]["wholesale"]=json!(41731);
        old["products"][pos]["variants"][0]["semi"]=json!(53729);
        old["products"][pos]["variants"][0]["retail"]=json!(123457);
        old["products"][pos]["variants"][1]["wholesale"]=json!(41993);
        old["products"][pos]["variants"][1]["semi"]=json!(53873);
        old["products"][pos]["variants"][1]["retail"]=json!(123491);
        old["products"][pos]["priceHistory"]=json!([{
            "field":format!("{first}.retail"),"before":119000,"after":123457,
            "source":"MANUAL","at":"2026-11-08T00:00:00+09:00"
        }]);
        let original_price_records=old["products"][pos]["variants"].clone();
        let original_history=old["products"][pos]["priceHistory"].clone();
        let override_amount=38291;
        let mut overrides=serde_json::Map::new();
        overrides.insert(first.clone(),json!(override_amount));
        old["clients"]=json!([
            {"id":"dealer-special","name":"가상특수대리점","tier":"special",
             "address":"가상 주소","phone":"010-0000-0000",
             "overrides":overrides},
            {"id":"dealer-retail","name":"가상소매점","tier":"retail",
             "address":"가상 주소","phone":"010-1111-1111","overrides":{}}
        ]);
        let original_clients=old["clients"].clone();
        old["aliases"]=json!([
            {"id":"alias-global","clientId":null,"text":"투명아크릴","productId":original_id,"variantId":first},
            {"id":"alias-private","clientId":"dealer-special","text":"불투명아크릴",
             "productId":original_id,"variantId":second}
        ]);
        old["sourceLinks"]=json!([
            {"id":"source-first","productId":original_id,"optionId":first_option},
            {"id":"source-second","productId":original_id,"optionId":second_option}
        ]);
        old["settings"]["modelRepresentatives"]=json!({
            "acrylic-clear":{"productId":original_id,"variantId":first}
        });
        let draft_item=json!({
            "id":"item-draft","productId":original_id,"variantId":second,
            "name":"BD 707A1 프로스트","quantity":2,"unitPrice":53873
        });
        let confirmed_item=json!({
            "id":"item-confirmed","productId":original_id,"variantId":first,
            "name":"BD 707A 클리어","quantity":3,"unitPrice":38291
        });
        let snapshot=json!({
            "at":"2026-11-07T12:00:00+09:00",
            "recipients":[{"id":"snapshot-recipient","items":[confirmed_item.clone()]}],
            "client":old["clients"][0].clone()
        });
        old["orders"]=json!([
            {"id":"draft-1","clientId":"dealer-special","status":"REVIEW",
             "recipients":[{"id":"recipient-draft","name":"받는 사람 A","items":[draft_item.clone()]}]},
            {"id":"confirmed-1","clientId":"dealer-special","status":"STATEMENT",
             "confirmedAt":"2026-11-07T12:00:00+09:00",
             "recipients":[{"id":"recipient-confirmed","name":"받는 사람 B","items":[confirmed_item.clone()]}],
             "confirmationSnapshot":snapshot,
             "receipt":{"original":"가상원문","actor":"가상 직원"}}
        ]);
        let original_confirmed=old["orders"][1].clone();
        let original_links=old["sourceLinks"].clone();
        let migrated=transform(old).unwrap();
        let a=migrated["products"].as_array().unwrap().iter()
            .find(|p|p["variants"][0]["id"]==first).unwrap();
        let b=migrated["products"].as_array().unwrap().iter()
            .find(|p|p["variants"][0]["id"]==second).unwrap();
        assert_ne!(a["id"],b["id"]);
        assert_eq!(a["variants"][0],original_price_records[0]);
        assert_eq!(b["variants"][0],original_price_records[1]);
        assert_eq!(a["priceHistory"],original_history);
        assert_eq!(b["priceHistory"],original_history);
        assert_eq!(migrated["clients"],original_clients);
        assert_eq!(migrated["clients"][0]["overrides"][first.as_str()],override_amount);
        assert_eq!(migrated["orders"][0]["recipients"][0]["items"][0]["productId"],b["id"]);
        assert_eq!(migrated["orders"][0]["recipients"][0]["items"][0]["variantId"],second);
        assert_eq!(migrated["orders"][0]["recipients"][0]["items"][0]["unitPrice"],53873);
        assert_eq!(migrated["orders"][0]["recipients"][0]["items"][0]["originalProductId"],original_id);
        // Frozen confirmation and receipt data are never silently rewritten.
        assert_eq!(migrated["orders"][1],original_confirmed);
        assert_eq!(migrated["aliases"][0]["productId"],a["id"]);
        assert_eq!(migrated["aliases"][1]["productId"],b["id"]);
        assert_eq!(migrated["aliases"][0]["clientId"],Value::Null);
        assert_eq!(migrated["aliases"][1]["clientId"],"dealer-special");
        assert_eq!(migrated["aliases"][0]["variantId"],first);
        assert_eq!(migrated["aliases"][1]["variantId"],second);
        assert_eq!(migrated["sourceLinks"][0]["productId"],a["id"]);
        assert_eq!(migrated["sourceLinks"][1]["productId"],b["id"]);
        assert_eq!(migrated["sourceLinks"][0]["optionId"],original_links[0]["optionId"]);
        assert_eq!(migrated["sourceLinks"][1]["optionId"],original_links[1]["optionId"]);
        assert_eq!(migrated["settings"]["modelRepresentatives"]["acrylic-clear"]["productId"],a["id"]);
        assert_eq!(migrated["productMappings"][format!("{original_id}|{first}").as_str()],a["id"]);
        assert_eq!(migrated["productMappings"][format!("{original_id}|{second}").as_str()],b["id"]);
        assert_eq!(migrated["revision"],0);
    }

    #[test]
    fn ambiguous_draft_order_refuses_migration_without_fabricating_product(){
        let mut old:Value=serde_json::from_str(
            include_str!("../resources/legacy-state-seed-303.json")).unwrap();
        old["orders"]=json!([{"id":"draft-ambiguous","status":"REVIEW","recipients":[{
            "id":"recipient-ambiguous","name":"가상 수취인",
            "items":[{"id":"item-ambiguous","productId":"bando-site-351",
                "variantId":null,"name":"아크릴 보면대","quantity":1}]
        }]}]);
        assert!(transform(old).unwrap_err().contains("미확정 주문"));
    }

    #[test]
    fn ambiguous_official_link_refuses_migration_without_selecting_a_variant(){
        let mut old:Value=serde_json::from_str(
            include_str!("../resources/legacy-state-seed-303.json")).unwrap();
        old["sourceLinks"]=json!([{"id":"wrong-source","productId":"bando-site-351",
            "optionId":"UNKNOWN"}]);
        assert!(transform(old).unwrap_err().contains("공식 사이트 연결"));
    }

    #[test]
    fn ambiguous_order_or_alias_aborts_conversion_without_guessing(){
        let mut old:Value=serde_json::from_str(include_str!("../resources/legacy-state-seed-303.json")).unwrap();
        old["aliases"]=json!([{"id":"a1","productId":"bando-site-351","text":"아크릴 악보대"}]);
        assert!(transform(old).unwrap_err().contains("별칭"));
    }
}
