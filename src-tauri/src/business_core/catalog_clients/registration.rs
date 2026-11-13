//! Native finalization of reviewed batch product registration.
//! Oracle: src/product-registration-xlsx.ts::prepareRegistrationCommit.
//! No generated timestamps/UUIDs: they are supplied by the trusted UI caller.
use serde_json::{json,Value};
use unicode_normalization::UnicodeNormalization;
use super::{field,items,normalized_color,validate_product,product_key};

fn registry_key(text:&str)->String{
    text.nfkc().collect::<String>()
        .trim().chars().flat_map(char::to_lowercase)
        .collect::<String>()
        .split_whitespace().collect::<Vec<_>>().join(" ")
}
fn color(v:&Value)->String {normalized_color(field(v,"color"))}
fn existing_matches(products:&[Value],product:&Value)->Vec<String>{
    let variant=items(product,"variants").first().unwrap_or(&Value::Null);
    products.iter().filter(|p|{
        let catalog=if field(p,"catalog").is_empty() {"BANDOSTAND"}else{field(p,"catalog")};
        if catalog!=field(product,"catalog"){return false}
        if registry_key(field(p,"name"))!=registry_key(field(product,"name")){return false}
        if !field(product,"registrationIdentity").is_empty()
            && field(p,"registrationIdentity")==field(product,"registrationIdentity"){
            return true
        }
        if registry_key(field(p,"specification"))!=registry_key(field(product,"specification")){
            return false
        }
        let unit=if field(p,"sellingUnit").is_empty(){"개"}else{field(p,"sellingUnit")};
        let requested=if field(product,"sellingUnit").is_empty(){"개"}else{field(product,"sellingUnit")};
        if registry_key(unit)!=registry_key(requested){return false}
        items(p,"variants").iter().any(|v|{
            color(v)==color(variant) &&
            registry_key(field(v,"option"))==registry_key(field(variant,"option"))
        })
    }).map(|p|field(p,"id").to_owned()).collect()
}
pub(super) fn commit(payload:&Value)->Result<Value,String>{
    let state=payload.get("state").ok_or("현재 상태가 없습니다.")?;
    let preview=payload.get("preview").ok_or("상품 등록 검토 자료가 없습니다.")?;
    let revision=state.get("revision").and_then(Value::as_i64).unwrap_or(0);
    if preview.get("revision").and_then(Value::as_i64)!=Some(revision){
        return Err("상품 데이터가 변경되었습니다. 등록 파일을 다시 검증하세요.".into())
    }
    let ready=items(preview,"rows").iter().filter(|r|
        field(r,"status")=="READY"&&r.get("product").is_some_and(|p|!p.is_null()))
        .collect::<Vec<_>>();
    if ready.is_empty(){return Err("등록 가능한 상품이 없습니다.".into())}
    let mut next=state.clone();
    let mut created_ids=vec![];
    for row in ready{
        let product=row["product"].clone();
        let row_num=row.get("row").and_then(Value::as_u64).unwrap_or(0);
        let existing=items(&next,"products");
        if !existing_matches(existing,&product).is_empty(){
            return Err(format!("{row_num}행: 중복 상품이 발견됐습니다. 다시 검증하세요."))
        }
        // Original TS validates only against registered/active products.
        let valid=existing.iter().filter(|p|p.get("active")!=Some(&Value::Bool(false))
            && field(p,"deletedAt").is_empty() && field(p,"supersededBy").is_empty())
            .cloned().collect::<Vec<_>>();
        let mut validation_state=next.clone();
        validation_state["products"]=json!(valid);
        validate_product(&validation_state,&product)?;
        let key=product_key(&product);
        if items(&next,"deletedProductKeys").iter().any(|k|k.as_str()==Some(key.as_str())){
            return Err(format!("{row_num}행: 삭제된 상품은 재등록하지 않습니다."))
        }
        let id=field(&product,"id").to_owned();
        next["products"].as_array_mut().ok_or("상품 목록이 없습니다.")?.push(product);
        created_ids.push(id);
    }
    let batch_id=field(payload,"batchId");
    let at=field(payload,"now");
    if batch_id.is_empty() || at.is_empty(){
        return Err("상품 등록 기록 ID 및 시간이 누락됐습니다.".into())
    }
    let rows=items(preview,"rows").iter().map(|row|{
        let mut item=row.clone();
        if let Some(map)=item.as_object_mut(){map.remove("product");}
        item
    }).collect::<Vec<_>>();
    let batch=json!({
        "id":batch_id,
        "fingerprint":preview.get("fingerprint").cloned().unwrap_or(Value::Null),
        "at":at, "actor":field(payload,"actor"),"rows":rows,
        "createdIds":created_ids
    });
    if next.get("registrationBatches").is_none()||next["registrationBatches"].is_null(){
        next["registrationBatches"]=json!([]);
    }
    next["registrationBatches"].as_array_mut()
        .ok_or("상품 등록 기록 형식이 올바르지 않습니다.")?.push(batch.clone());
    Ok(json!({"next":next,"batch":batch,"created":created_ids.len(),
        "skipped":items(preview,"rows").len()-created_ids.len()}))
}
