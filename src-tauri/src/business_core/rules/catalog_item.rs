//! Independent catalog item construction, matching src/domain.ts::itemFromProduct.
 //! Caller supplies a UUID; no hidden clock, randomness, SQLite or TS pricing.
use serde_json::{json,Value};
use super::{field,flag,req,required_str,rows,set,str_field};

fn normalize_color(raw:&str)->String{
    let value=raw.trim();
    let lower=value.to_lowercase();
    match lower.as_str(){
       "gold"|"골드"=>"Gold".into(),
       "rose gold"|"로즈골드"=>"Rose Gold".into(),
       "cosmo black"|"cosmoblack"|"코스모블랙"=>"Cosmo Black".into(),
       "chrome"|"크롬"=>"Chrome".into(),
       "black"|"블랙"|"검정"|"검정색"=>"Black".into(),
       "gray"|"grey"|"그레이"|"회색"=>"Gray".into(),
       "white"|"화이트"|"흰색"=>"White".into(),
       "silver"|"실버"=>"Silver".into(),
       "red"|"빨강"=>"Red".into(),
       "blue"|"파랑"=>"Blue".into(),
       "brown"|"브라운"=>"Brown".into(),
       "clear"|"클리어"=>"Clear".into(),
       "frost"|"프로스트"=>"Frost".into(),
       _=>value.into()
    }
}
fn truthy(v:&Value)->bool{
    match v {
        Value::Null=>false,
        Value::Bool(b)=>*b,
        Value::Number(n)=>n.as_f64().is_some_and(|x|x!=0.0),
        Value::String(s)=>!s.is_empty(),
        _=>true
    }
}
pub(super) fn make(payload:&Value)->Result<Value,String>{
    let product=req(payload,"product")?;
    let client=req(payload,"client")?;
    let new_id=required_str(payload,"newItemId")?;
    let variants=rows(field(product,"variants"));
    let selected_id=str_field(payload,"variantId");
    let explicit=if selected_id.is_empty(){None}else{
        variants.iter().find(|v|str_field(v,"id")==selected_id)
    };
    let color_arg=payload.get("color").and_then(Value::as_str);
    let selected_color=explicit.and_then(|v|v.get("color"))
        .and_then(Value::as_str).or(color_arg)
        .unwrap_or_else(||str_field(product,"defaultColor"));
    let normalized=normalize_color(selected_color);
    let eligible=variants.iter().filter(|v|
        normalize_color(str_field(v,"color"))==normalized).collect::<Vec<_>>();
    let selectable=variants.len()==1&&!flag(product,"requiresOption");
    let variant=if !selectable{None}else if !selected_id.is_empty(){explicit}else{
        eligible.first().copied()
    };
    let name=if str_field(product,"name").is_empty(){
        str_field(product,"code")
    }else{str_field(product,"name")};
    let name=name.strip_prefix("반도스탠드").unwrap_or(name).trim();
    let visible=if variants.iter().any(|v|str_field(v,"source")=="DEMO") &&
        !name.starts_with("[가상] "){
        format!("[가상] {name}")
    }else{name.into()};
    let defaulted=color_arg.is_none_or(str::is_empty);
    let missing_color=(str_field(product,"colorStatus")=="MISSING" ||
        (!truthy(field(product,"saleUnit"))&&
         ["색상 미표기",""].contains(&str_field(product,"defaultColor")))) && defaulted;
    let issues:Vec<&str>=if variant.is_some(){
        if missing_color {vec!["기본 색상 확인 필요"]}else{vec![]}
    }else if flag(product,"requiresOption"){
        vec!["상품 구성 미확정 / 판매 구성을 확인하세요"]
    }else{vec!["등록된 독립 상품을 다시 선택하세요"]};
    let price=if let Some(v)=variant{
        super::pricing::resolve_unit_price(product,str_field(v,"id"),client)?
    }else{Value::Null};
    let quantity=payload.get("quantity").cloned().unwrap_or(json!(1));
    let mut item=json!({
        "id":new_id,"productId":field(product,"id"),
        "variantId":variant.map(|v|field(v,"id")).unwrap_or(&Value::Null),
        "raw":field(product,"name"),"name":visible,"color":normalized,
        "quantity":quantity,"unitPrice":price,"origin":field(product,"origin"),
        "defaulted":defaulted,"issues":issues,
        "url":variant.map(|v|str_field(v,"url")).unwrap_or("")
    });
    if let Some(catalog)=product.get("catalog"){set(&mut item,"catalog",catalog.clone())?;}
    Ok(json!({"item":item}))
}

#[cfg(test)]
mod tests{
    use super::*;
    #[test] fn registered_single_option_preserves_color_and_price(){
        let product=json!({"id":"p1","name":"반도스탠드 BD 709",
            "origin":"FACTORY","defaultColor":"Black","variants":[
                {"id":"v1","color":"Black","wholesale":30000,"url":""}
            ]});
        let result=make(&json!({"product":product,
            "client":{"id":"c1","tier":"wholesale"},"newItemId":"i1",
            "variantId":"v1","quantity":2})).unwrap();
        assert_eq!(result["item"]["name"],"BD 709");
        assert_eq!(result["item"]["color"],"Black");
        assert_eq!(result["item"]["quantity"],2);
        assert_eq!(result["item"]["unitPrice"],30000);
        assert_eq!(result["item"]["id"],"i1");
    }
    #[test] fn undecided_option_never_invents_variant_or_quote(){
        let product=json!({"id":"p1","name":"BD TEST",
            "origin":"FACTORY","defaultColor":"Black","requiresOption":true,
            "variants":[{"id":"v1","color":"Black","wholesale":10000}]});
        let result=make(&json!({"product":product,
            "client":{"id":"c1","tier":"wholesale"},"newItemId":"i1"})).unwrap();
        assert!(result["item"]["variantId"].is_null());
        assert!(result["item"]["unitPrice"].is_null());
        assert_eq!(result["item"]["issues"][0],"상품 구성 미확정 / 판매 구성을 확인하세요");
    }
}
