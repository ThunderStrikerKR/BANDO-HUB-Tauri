//! Native brand edit and validation, preserving original
//! src/product-registry.ts::validateBrands semantics.
use serde_json::{json,Value};
use std::collections::HashMap;
use unicode_normalization::UnicodeNormalization;
use url::Url;
use super::{field,items};

fn registry_key(value:&str)->String{
    value.nfkc().collect::<String>().trim()
        .chars().flat_map(char::to_lowercase).collect::<String>()
        .split_whitespace().collect::<Vec<_>>().join(" ")
}
fn terms(brand:&Value)->Vec<String>{
    ["name","korean"].iter().filter_map(|key|brand.get(*key).and_then(Value::as_str))
        .chain(items(brand,"aliases").iter().filter_map(Value::as_str))
        .filter(|term|!term.is_empty()).map(registry_key).collect()
}
pub(super) fn validate(before:&Value,next:&Value)->Result<(),String>{
    let brands=items(next,"brands");
    for (position,brand) in brands.iter().enumerate(){
        let id=field(brand,"id");
        if items(before,"brands").iter().any(|old|field(old,"id")==id&&old==brand){
            continue
        }
        if id.is_empty() || field(brand,"name").trim().is_empty(){
            return Err("브랜드 공식명을 입력하세요.".into())
        }
        let evidence=field(brand,"evidenceUrl").trim();
        let valid=Url::parse(evidence).is_ok_and(|url|
            url.scheme()=="https" && url.host_str().is_some() &&
            url.username().is_empty() && url.password().is_none());
        if !valid{return Err("브랜드 확인 근거는 HTTPS URL이어야 합니다.".into())}
        let own=terms(brand);
        for (index,other) in brands.iter().enumerate(){
            if index==position{continue}
            if field(other,"id")==id {
                // The TS oracle checks collision terms before duplicate IDs.
                let other_terms=terms(other);
                if !own.iter().any(|name|other_terms.contains(name)){
                    return Err("브랜드 식별자가 중복되었습니다.".into())
                }
            }
            let other_terms=terms(other);
            if own.iter().any(|name|other_terms.contains(name)){
                return Err("브랜드 공식명, 한글명 또는 검색 별칭이 다른 브랜드와 중복됩니다.".into())
            }
        }
    }
    Ok(())
}
fn upsert_brand(state:&Value,payload:&Value)->Result<Value,String>{
    let edit_id=field(payload,"editing");
    let id=if edit_id.is_empty(){field(payload,"id")}else{edit_id};
    if id.is_empty(){return Err("브랜드 ID가 없습니다.".into())}
    let name=field(payload,"name").trim();
    let korean=field(payload,"korean").trim();
    let evidence=field(payload,"evidence").trim();
    // Original React Map(registryKey -> last written alias) retains the
    // order of the first occurrence for repeated normalized aliases.
    let mut aliases=Vec::<String>::new();
    let mut positions=HashMap::<String,usize>::new();
    for alias in field(payload,"aliases").split(','){
        let alias=alias.trim();
        if alias.is_empty(){continue}
        let key=registry_key(alias);
        if let Some(position)=positions.get(&key).copied(){
            aliases[position]=alias.to_owned();
        }else{
            positions.insert(key,aliases.len());
            aliases.push(alias.to_owned());
        }
    }
    let row=json!({
        "id":id,"name":name,"korean":korean,
        "aliases":aliases,"evidenceUrl":evidence
    });
    let mut next=state.clone();
    let mut brands=items(state,"brands").iter()
        .filter(|b|edit_id.is_empty()||field(b,"id")!=edit_id)
        .cloned().collect::<Vec<_>>();
    brands.push(row);
    next["brands"]=json!(brands);
    validate(state,&next)?;
    Ok(json!({"state":next}))
}
pub(super) fn execute(operation:&str,payload:&Value)->Result<Value,String>{
    let state=payload.get("state").ok_or("현재 상태가 없습니다.")?;
    match operation{
        "upsert_brand"=>upsert_brand(state,payload),
        "validate_brands"=>{
            validate(payload.get("before").unwrap_or(&Value::Null),state)?;
            Ok(json!({"valid":true}))
        }
        _=>Err(format!("지원하지 않는 브랜드 업무입니다: {operation}"))
    }
}
#[cfg(test)]
mod tests{
    use super::*;
    #[test]
    fn brand_aliases_are_deduplicated_and_other_product_references_survive(){
        let state=json!({"brands":[],"products":[{"id":"p1","brandId":"b1"}],
            "orders":[{"id":"old","total":20000}]});
        let r=upsert_brand(&state,&json!({
            "id":"b1","name":" BANDO ","korean":"반도",
            "aliases":"스탠드, STAND, 스탠드","evidence":"https://example.com/brand"
        })).unwrap();
        assert_eq!(r["state"]["brands"][0]["name"],"BANDO");
        assert_eq!(r["state"]["brands"][0]["aliases"],json!(["스탠드","STAND"]));
        assert_eq!(r["state"]["products"][0]["brandId"],"b1");
        assert_eq!(r["state"]["orders"][0]["total"],20000);
    }
}
