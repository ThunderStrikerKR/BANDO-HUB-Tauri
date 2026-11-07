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
    fn ambiguous_order_or_alias_aborts_conversion_without_guessing(){
        let mut old:Value=serde_json::from_str(include_str!("../resources/legacy-state-seed-303.json")).unwrap();
        old["aliases"]=json!([{"id":"a1","productId":"bando-site-351","text":"아크릴 악보대"}]);
        assert!(transform(old).unwrap_err().contains("별칭"));
    }
}
