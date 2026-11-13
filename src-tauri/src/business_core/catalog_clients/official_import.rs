//! Native finalization for approved official-site product imports.
//! Oracle: src/official-product-import.ts::applyOfficialProductPreview.
//! HTML/DOM parsing remains the browser adapter; authoritative master-data
//! decisions run through Rust and persist only via the normal SQLite saver.
use serde_json::{json,Value};
use std::collections::HashSet;
use super::{field,items,product_url_ok,validate_product};
use super::registration::registry_key;

fn active(p:&Value)->bool {
    p.get("active")!=Some(&Value::Bool(false)) &&
        field(p,"deletedAt").is_empty() && field(p,"supersededBy").is_empty()
}
fn catalog(p:&Value)->&str{
    if field(p,"catalog").is_empty(){"BANDOSTAND"}else{field(p,"catalog")}
}
fn source_matches<'a>(state:&'a Value,cat:&str,site_id:&str)->Vec<&'a Value>{
    items(state,"products").iter().filter(|p|{
        active(p) && catalog(p)==cat &&
        (field(p,"siteId")==site_id ||
         items(p,"siteRefs").iter().any(|id|id.as_str()==Some(site_id)) ||
         items(p,"variants").iter().any(|v|field(v,"siteProductId")==site_id))
    }).collect()
}
fn category_rows(state:&Value)->Vec<Value>{
    let mut cats=items(state,"categories").to_vec();
    for (id,name) in [("catalog-root:BANDOSTAND","반도스탠드"),
                      ("catalog-root:BANDOMALL","반도몰")]{
        if !cats.iter().any(|c|field(c,"id")==id){
            cats.push(json!({"id":id,"name":name,"parentId":null}));
        }
    }
    cats
}
fn path(cats:&[Value],id:&str)->Result<Vec<Value>,String>{
    let mut current=id.to_owned();
    let mut seen=HashSet::new();
    let mut result=Vec::new();
    while !current.is_empty(){
        if !seen.insert(current.clone()){
            return Err("카테고리가 순환합니다.".into())
        }
        let Some(category)=cats.iter().find(|c|field(c,"id")==current) else{break};
        result.insert(0,category.clone());
        current=field(category,"parentId").to_owned();
    }
    Ok(result)
}
pub(super) fn apply(payload:&Value)->Result<Value,String>{
    let state=payload.get("state").ok_or("현재 상태가 없습니다.")?;
    let preview=payload.get("preview").ok_or("상품 가져오기 검토 자료가 없습니다.")?;
    let imported=preview.get("product").ok_or("가져올 상품이 없습니다.")?;
    if preview.get("canApply")!=Some(&Value::Bool(true)) ||
        imported.get("requiresOption")==Some(&Value::Bool(true)) ||
        !items(preview,"optionEvidence").is_empty() ||
        field(imported,"name").trim().is_empty()
    {
        return Err("확인이 필요한 옵션 또는 모델이 있어 자동 반영을 중단했습니다.".into())
    }
    let revision=state.get("revision").and_then(Value::as_i64).unwrap_or(0);
    if preview.get("revision").and_then(Value::as_i64)!=Some(revision){
        return Err("미리보기 후 상품 데이터가 변경되었습니다. 다시 분석하세요.".into())
    }
    let site_id=field(imported,"siteId");
    let first_variant=items(imported,"variants").first();
    let source_url=field(preview,"sourceUrl");
    if site_id.is_empty() || first_variant.is_none() ||
        first_variant.is_some_and(|v|v.get("retail").is_none_or(Value::is_null)) ||
        !product_url_ok(source_url)
    {
        return Err("공식 상품 식별자 또는 판매가를 다시 확인하세요.".into())
    }
    let cat=catalog(imported);
    let matches=source_matches(state,cat,site_id);
    if matches.len()>1{
        return Err("하나의 원본 상품번호에 여러 상품이 연결되어 있습니다.".into())
    }
    let mut next=state.clone();
    if let Some(found)=matches.first(){
        let product_id=field(found,"id");
        let target=next.get_mut("products").and_then(Value::as_array_mut)
            .ok_or("상품 목록이 없습니다.")?
            .iter_mut().find(|p|field(p,"id")==product_id)
            .ok_or("기존 상품을 찾지 못했습니다.")?;
        if items(target,"variants").len()!=1{
            return Err("여러 옵션 중 대상 옵션을 확정할 수 없습니다.".into())
        }
        let fresh=first_variant.unwrap();
        let new_price=fresh.get("retail").cloned().unwrap_or(Value::Null);
        let variant=&target["variants"][0];
        let old_price=variant.get("retail").cloned().unwrap_or(Value::Null);
        if old_price==new_price{
            return Err("기존 판매가와 동일합니다. 수정할 내용이 없습니다.".into())
        }
        let variant_id=field(variant,"id").to_owned();
        target["variants"][0]["retail"]=new_price.clone();
        target["variants"][0]["officialRetail"]=new_price.clone();
        if let Some(at)=fresh.get("collectedAt"){
            target["variants"][0]["collectedAt"]=at.clone();
        }else if let Some(v)=target["variants"][0].as_object_mut(){
            v.remove("collectedAt");
        }
        target["variants"][0]["source"]=json!("OFFICIAL");
        target["variants"][0]["url"]=json!(source_url);
        if target.get("priceHistory").is_none()||target["priceHistory"].is_null(){
            target["priceHistory"]=json!([]);
        }
        let history_at=field(payload,"historyAt");
        let updated_at=field(payload,"updatedAt");
        if history_at.is_empty()||updated_at.is_empty(){
            return Err("소매가 변경 시각이 누락되었습니다.".into())
        }
        target["priceHistory"].as_array_mut().ok_or("상품 가격 이력이 올바르지 않습니다.")?
            .push(json!({
                "at":history_at, "field":format!("{variant_id}.retail"),
                "before":old_price,"after":new_price,"source":"OFFICIAL_URL"
            }));
        target["updatedAt"]=json!(updated_at);
        return Ok(json!({"next":next,"created":false}))
    }
    if items(state,"products").iter().any(|p|active(p)&&catalog(p)==cat&&
        registry_key(field(p,"name"))==registry_key(field(imported,"name")))
    {
        return Err("같은 상품명으로 등록된 상품이 존재합니다. 자동 중복 등록을 막았습니다.".into())
    }
    if items(state,"products").iter().any(|p|{
        !field(p,"deletedAt").is_empty() &&
        (field(p,"siteId")==site_id || (catalog(p)==cat&&
         registry_key(field(p,"name"))==registry_key(field(imported,"name"))))
    }){
        return Err("삭제된 상품을 자동 복구할 수 없습니다.".into())
    }
    let category_id=field(payload,"selectedCategoryId");
    let cats=category_rows(state);
    let target=cats.iter().find(|c|field(c,"id")==category_id);
    let selected_path=if let Some(c)=target{
        path(&cats,field(c,"id"))?
    }else{Vec::new()};
    let valid=target.is_some_and(|c|{
        !selected_path.is_empty() &&
        items(state,"categories").iter().any(|item|field(item,"id")==field(c,"id")) &&
        !cats.iter().any(|other|field(other,"parentId")==field(c,"id")) &&
        c.get("active")!=Some(&Value::Bool(false)) &&
        selected_path.first().is_some_and(|root|
            field(root,"id")==format!("catalog-root:{cat}"))
    });
    if !valid{
        return Err("상품이 속할 활성 최하위 카테고리를 선택하세요.".into())
    }
    let mut product=imported.clone();
    product["categories"]=json!(selected_path.iter().map(|c|field(c,"id")).collect::<Vec<_>>());
    product["category"]=json!(selected_path.iter().map(|c|field(c,"name"))
        .collect::<Vec<_>>().join(" > "));
    let mut validation=state.clone();
    validation["products"]=json!(items(state,"products").iter()
        .filter(|p|active(p)).collect::<Vec<_>>());
    validate_product(&validation,&product)?;
    next.get_mut("products").and_then(Value::as_array_mut)
        .ok_or("상품 목록이 없습니다.")?.push(product);
    Ok(json!({"next":next,"created":true}))
}

#[cfg(test)]
mod tests{
    use super::apply;
    use serde_json::json;
    #[test]
    fn official_import_never_rewrites_old_orders(){
        let state=json!({
            "revision":4,"products":[],"orders":[{"id":"locked","unitPrice":15000}],
            "categories":[{"id":"leaf","parentId":"catalog-root:BANDOSTAND",
                "name":"보면대","active":true}]
        });
        let product=json!({
            "id":"p1","code":"p1","siteId":"709","name":"BD 709",
            "catalog":"BANDOSTAND","origin":"FACTORY","category":"",
            "defaultColor":"Black","active":true,
            "createdAt":"2026-11-13","updatedAt":"2026-11-13",
            "variants":[{"id":"v1","color":"Black","retail":22000,
                "wholesale":null,"semi":null,"source":"OFFICIAL","url":"",
                "collectedAt":"2026-11-13"}]
        });
        let preview=json!({"revision":4,"canApply":true,"sourceUrl":
            "https://www.bandostand.com/product/709","product":product,
            "optionEvidence":[]});
        let result=apply(&json!({"state":state,"preview":preview,
            "selectedCategoryId":"leaf"})).unwrap();
        assert_eq!(result["created"],true);
        assert_eq!(result["next"]["orders"][0]["unitPrice"],15000);
        assert_eq!(result["next"]["products"][0]["category"],"반도스탠드 > 보면대");
    }
}
