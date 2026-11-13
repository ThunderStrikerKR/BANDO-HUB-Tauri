//! Exact original TS model-group validation and explicit representative picker.
//! Oracle: src/model-groups.ts::validateModelGroups / validateModelGroupProducts.
use serde_json::{json,Value};
use std::collections::HashSet;
use super::{field,items};

fn registered(p:&Value)->bool{
    p.get("active")!=Some(&Value::Bool(false)) &&
    field(p,"deletedAt").is_empty() &&
    field(p,"supersededBy").is_empty()
}
fn validate_product_ids(state:&Value,ids:&[Value],rep:&str)->Result<(),String>{
    if ids.len()<2{
        return Err("모델군에는 등록된 상품이 2개 이상 있어야 합니다.".into())
    }
    let unique=ids.iter().filter_map(Value::as_str).collect::<HashSet<_>>();
    if unique.len()!=ids.len(){
        return Err("모델군에 같은 상품을 중복 등록할 수 없습니다.".into())
    }
    let all=items(state,"products");
    if ids.iter().any(|id|{
        let Some(id)=id.as_str()else{return true};
        !all.iter().any(|p|field(p,"id")==id&&
            registered(p)&&field(p,"catalog")!="DEMO" &&
            items(p,"variants").len()==1 &&
            items(p,"variants").iter().all(|v|field(v,"source")!="DEMO"))
    }){
        return Err("등록된 독립 판매 상품만 모델군에 추가할 수 있습니다.".into())
    }
    if rep.is_empty()||!ids.iter().any(|v|v.as_str()==Some(rep)){
        return Err("모델군에 등록된 상품 중 하나를 대표모델로 지정하세요.".into())
    }
    Ok(())
}
fn validate(state:&Value)->Result<(),String>{
    let Some(groups)=state.get("settings").and_then(|s|s.get("colorGuidanceGroups"))
        .filter(|v|v.is_object()) else{return Ok(())};
    let mut names=HashSet::new();
    let mut used=HashSet::new();
    for (id,group) in groups.as_object().unwrap(){
        let name=field(group,"name").trim();
        if id.trim().is_empty()||name.is_empty(){
            return Err("모델군 이름을 입력하세요.".into())
        }
        let key=name.to_lowercase();
        if !names.insert(key){return Err("모델군 이름이 중복됩니다.".into())}
        let members=items(group,"productIds");
        if !field(group,"representativeProductId").is_empty(){
            validate_product_ids(state,members,field(group,"representativeProductId"))?;
        }else{
            if field(group,"representativeColor").is_empty(){
                return Err("기존 그룹도 대표모델을 직접 선택한 뒤 저장하세요.".into())
            }
            if members.len()<2 ||
                members.iter().filter_map(Value::as_str).collect::<HashSet<_>>().len()!=members.len(){
                return Err("기존 그룹의 상품 연결을 확인하세요.".into())
            }
        }
        for member in members {
            let id=member.as_str().unwrap_or("");
            if !used.insert(id.to_owned()){
                return Err("상품은 하나의 모델군에만 등록할 수 있습니다.".into())
            }
        }
    }
    Ok(())
}
pub(super) fn execute(operation:&str,payload:&Value)->Result<Value,String>{
    let state=payload.get("state").ok_or("현재 상태가 없습니다.")?;
    match operation{
        "validate_model_groups"=>{validate(state)?;Ok(json!({"valid":true}))},
        "validate_model_group_products"=>{
            validate_product_ids(state,items(payload,"productIds"),
                field(payload,"representativeProductId"))?;
            Ok(json!({"valid":true}))
        }
        _=>Err(format!("지원하지 않는 모델군 검증입니다: {operation}"))
    }
}
#[cfg(test)]
mod tests{
    use super::*;
    #[test]
    fn two_products_of_same_color_but_distinct_prices_can_group(){
        let state=json!({"products":[
            {"id":"p1","active":true,"variants":[{"id":"v1","source":"MANUAL","color":"Black","retail":10000}]},
            {"id":"p2","active":true,"variants":[{"id":"v2","source":"MANUAL","color":"Black","retail":30000}]}
        ],"settings":{"colorGuidanceGroups":{"g":{"name":"709",
            "productIds":["p1","p2"],"representativeProductId":"p1"}}}});
        assert!(validate(&state).is_ok());
    }
}
