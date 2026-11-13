//! Original TS ProductManager.save candidate assembly before upsert_product.
use serde_json::{json,Value};
use super::{field,items,normalized_color,product_key,upsert,validate_product};
fn catalog_for_category(state:&Value,id:&str)->Option<&'static str>{
    let mut current=id.to_owned();
    let mut seen=std::collections::HashSet::new();
    while !current.is_empty()&&seen.insert(current.clone()){
        if current=="catalog-root:BANDOSTAND"{return Some("BANDOSTAND")}
        if current=="catalog-root:BANDOMALL"{return Some("BANDOMALL")}
        let Some(c)=items(state,"categories").iter().find(|c|field(c,"id")==current)
            else{break};
        current=field(c,"parentId").to_owned();
    }
    None
}
fn prepare(state:&Value,product:&Value,updated_at:&str)->Result<Value,String>{
    let mut p=product.clone();
    if let Some(name)=p.get("name").and_then(Value::as_str){
        p["name"]=json!(name.trim());
    }
    if field(&p,"code").is_empty(){
        p["code"]=json!(field(&p,"id"));
    }
    if items(&p,"variants").len()!=1{
        return Err("상품은 한 가지 판매 구성으로만 등록할 수 있습니다. 기존 복수 구성은 각각 별도 상품으로 전환하세요.".into());
    }
    p["saleUnit"]=json!(true);
    if p.get("familyKey").is_none_or(Value::is_null){
        p["familyKey"]=json!(field(&p,"id"));
    }
    // Historical modelKey is computed using the pre-reconciled catalog.
    p["modelKey"]=json!(product_key(&p));
    if let Some(variants)=p.get_mut("variants").and_then(Value::as_array_mut){
        for variant in variants {
            variant["color"]=json!(normalized_color(field(variant,"color")));
        }
    }
    p["defaultColor"]=json!(normalized_color(field(&p,"defaultColor")));
    if updated_at.is_empty(){return Err("상품 수정 시각이 없습니다.".into())}
    p["updatedAt"]=json!(updated_at);
    if let Some(selected)=items(&p,"categories").last().and_then(Value::as_str){
        if let Some(catalog)=catalog_for_category(state,selected){
            p["catalog"]=json!(catalog);
        }
    }
    Ok(p)
}
pub(super) fn execute(payload:&Value)->Result<Value,String>{
    let state=payload.get("state").ok_or("현재 상태가 없습니다.")?;
    let product=payload.get("product").ok_or("상품 정보가 없습니다.")?;
    let prepared=prepare(state,product,field(payload,"updatedAt"))?;
    validate_product(state,&prepared)?;
    upsert(state,&prepared,"products")
}
#[cfg(test)]
mod tests{
    use super::prepare;
    use serde_json::json;
    #[test]
    fn normalize_price_history_product_and_source_with_no_auto_family_merge(){
        let state=json!({"categories":[{"id":"leaf","name":"상품","parentId":"catalog-root:BANDOMALL"}]});
        let p=json!({"id":"p","name":" 상품 ","code":"","catalog":"BANDOSTAND",
            "familyKey":null,"categories":["leaf"],"defaultColor":"블랙",
            "variants":[{"id":"v1","color":"검정"}]});
        let out=prepare(&state,&p,"2026-11-13T00:00:00Z").unwrap();
        assert_eq!(out["modelKey"],"BANDOSTAND|P|sale:v1");
        assert_eq!(out["catalog"],"BANDOMALL");
        assert_eq!(out["variants"][0]["color"],"Black");
        assert_eq!(out["familyKey"],"p");
    }
}
