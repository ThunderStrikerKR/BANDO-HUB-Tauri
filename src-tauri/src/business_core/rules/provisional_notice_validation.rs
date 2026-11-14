//! Save-time validation of staff-managed provisional product notices.
//! Exact decision oracle: src/provisional-product-notices.ts::validateProvisionalProductNotices.
//! No state mutation and no side effects; SQLite remains behind the native settings patch.
use serde_json::{json,Value};
use std::collections::HashSet;
use super::{field,req,rows,str_field};

pub(super) fn validate(payload:&Value)->Result<Value,String>{
    let state=req(payload,"state")?;
    let notices=field(field(state,"settings"),"provisionalProductNotices");
    if notices.is_null(){return Ok(json!({"valid":true}));}
    let edits=notices.as_object().ok_or("안내문 등록 형식을 확인하세요.")?;
    if edits.len()>5000{return Err("잠정 상품 안내문 등록 한도를 초과했습니다.".into());}
    let ids=rows(field(state,"products")).iter()
        .map(|p|str_field(p,"id")).collect::<HashSet<_>>();
    for (product_id,value) in edits{
        if !ids.contains(product_id.as_str()){
            return Err("등록된 상품에만 안내문을 연결할 수 있습니다.".into());
        }
        let valid=value.as_str().is_some_and(|text|
            !text.trim().is_empty() && (1..=2000).contains(&text.chars().count()));
        if !valid{return Err("안내문은 1자 이상 2000자 이하로 입력하세요.".into());}
    }
    Ok(json!({"valid":true}))
}

#[cfg(test)]
mod tests{
    use super::*;
    #[test]fn validates_product_identity_and_unicode_character_count(){
        let make=|text:&str|json!({"state":{"products":[{"id":"p1"}],
            "settings":{"provisionalProductNotices":{"p1":text}}}});
        assert_eq!(validate(&make("선택 모델 안내")).unwrap()["valid"],true);
        assert_eq!(validate(&make(&"😀".repeat(2000))).unwrap()["valid"],true);
        assert!(validate(&make(&"😀".repeat(2001))).is_err());
        assert!(validate(&make("  ")).is_err());
        assert!(validate(&json!({"state":{"products":[],
            "settings":{"provisionalProductNotices":{"p1":"안내"}}}})).is_err());
    }
}
