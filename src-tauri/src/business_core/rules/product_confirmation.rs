//! Employee-owned product selection and proposed-product confirmation.
//! Exact source behavior: src/issue-actions.ts; UI owns form fields only.
use regex::Regex;
use serde_json::{json,Value};
use std::collections::HashSet;
use super::{field,find_by_id,flag,has_value,req,required_str,rows,set,str_field};

fn active(product:&Value)->bool {
    product.get("active").and_then(Value::as_bool)!=Some(false)
        &&!has_value(field(product,"deletedAt"))
        &&!has_value(field(product,"supersededBy"))
}
fn color(value:&str)->String {
    let v=value.trim();
    let normalized=match v.to_lowercase().as_str(){
        "gold"|"골드"=>"Gold","rose gold"|"로즈골드"=>"Rose Gold",
        "cosmo black"|"cosmoblack"|"코스모블랙"=>"Cosmo Black",
        "chrome"|"크롬"=>"Chrome","black"|"블랙"|"검정"|"검정색"=>"Black",
        "gray"|"grey"|"그레이"|"회색"=>"Gray",
        "white"|"화이트"|"흰색"=>"White","silver"|"실버"=>"Silver",
        "red"|"빨강"=>"Red","blue"|"파랑"=>"Blue",
        "brown"|"브라운"=>"Brown","clear"|"클리어"=>"Clear",
        "frost"|"프로스트"=>"Frost", _=>v
    };
    normalized.to_string()
}
fn color_label(value:&str)->String{
    let s=value.trim();
    let normalized=match s.to_lowercase().as_str(){
        "black"|"블랙"|"검정"=>"블랙","white"|"화이트"|"흰색"=>"화이트",
        "gray"|"grey"|"그레이"|"회색"=>"그레이","brown"|"브라운"=>"브라운",
        "gold"|"골드"=>"골드","rose gold"|"로즈골드"=>"로즈골드",
        "cosmo black"|"코스모블랙"=>"코스모블랙","silver"|"실버"=>"실버",
        "clear"|"클리어"=>"클리어","frost"|"frosted"|"프로스트"=>"프로스트",
        "red"|"레드"=>"레드","blue"|"블루"=>"블루",
        "색상 미표기"=>"",_=>s
    };
    normalized.to_string()
}
fn key(s:&str)->String {
    let upper=s.chars().flat_map(char::to_uppercase).filter(|c|!c.is_whitespace())
        .collect::<String>();
    upper.strip_prefix("BD").unwrap_or(&upper).to_string()
}
fn model_names(product:&Value)->Vec<String>{
    let lead=str_field(product,"name").split('/').next().unwrap_or("").trim();
    if lead.is_empty(){return vec![];}
    let without=if lead.get(..2).is_some_and(|prefix|prefix.eq_ignore_ascii_case("BD")){
        let rest=&lead[2..];let trimmed=rest.trim_start_matches(|c:char|c.is_whitespace()||c=='-');
        if trimmed.len()!=rest.len(){trimmed}else{lead}
    }else{lead};
    if without==lead{vec![lead.to_string()]}
    else{vec![lead.to_string(),without.to_string()]}
}
fn alias_problems(record:&Value,state:&Value)->Vec<String>{
    let aliases=rows(field(state,"aliases"));
    let products=rows(field(state,"products"));
    let target=find_by_id(field(state,"products"),str_field(record,"productId"));
    let alias_key=key(str_field(record,"text"));
    let mut problems=Vec::new();
    if str_field(record,"text").trim().is_empty()||
        target.is_none_or(|p|has_value(field(p,"deletedAt"))){
        problems.push("별칭과 연결할 상품을 입력하세요.".to_string());
    }
    if aliases.iter().any(|x|str_field(x,"id")!=str_field(record,"id")&&
        field(x,"clientId")==field(record,"clientId")&&
        key(str_field(x,"text"))==alias_key&&
        (field(x,"productId")!=field(record,"productId")||
         field(x,"variantId")!=field(record,"variantId"))){
        problems.push("같은 적용 범위의 별칭이 충돌합니다.".to_string());
    }
    if products.iter().any(|p|!has_value(field(p,"deletedAt"))&&
        !has_value(field(p,"supersededBy"))&&
        (key(str_field(p,"name"))==alias_key||
         model_names(p).iter().any(|name|key(name)==alias_key))&&
        target.is_some()&&str_field(p,"id")!=str_field(record,"productId")){
        problems.push("다른 등록 상품명 또는 모델 표기와 충돌하는 별칭입니다.".to_string());
    }
    let suffix=Regex::new(r"^(\d{3}(?:-\d+)?)(BK|BR|B|C|W|G)$").expect("literal");
    if let Some(m)=suffix.captures(&alias_key){
        let exact=products.iter().any(|p|!has_value(field(p,"deletedAt"))&&
            model_names(p).iter().any(|name|key(name)==alias_key));
        if !exact {
            let base=m.get(1).map(|m|m.as_str()).unwrap_or("");
            let bases=products.iter().filter(|p|!has_value(field(p,"deletedAt"))&&
                model_names(p).iter().any(|name|key(name)==base)).collect::<Vec<_>>();
            let colors=match m.get(2).map(|m|m.as_str()).unwrap_or(""){
                "BK"|"B"=>"black","BR"=>"brown","C"=>"chrome",
                "W"=>"white","G"=>"gray",_=>"",
            };
            let variant=target.and_then(|p|rows(field(p,"variants")).iter()
                .find(|v|str_field(v,"id")==str_field(record,"variantId")));
            let variant_mismatch=variant.is_some_and(|v|{
                let c=str_field(v,"color");
                let lower=match c {
                    "블랙"|"검정"=>"black","브라운"=>"brown",
                    "크롬"=>"chrome","화이트"=>"white","그레이"|"회색"=>"gray",
                    _=>c
                };
                lower.to_lowercase()!=colors
            });
            if !bases.is_empty()&&
                (target.is_none()||
                 !bases.iter().any(|p|str_field(p,"id")==str_field(record,"productId"))||
                 variant_mismatch){
                problems.push("상품명의 색상 또는 구성 표기와 충돌하는 별칭입니다.".to_string());
            }
        }
    }
    if !str_field(record,"variantId").is_empty()&&target.is_some_and(|p|
        !rows(field(p,"variants")).iter().any(|v|str_field(v,"id")==str_field(record,"variantId"))){
        problems.push("별칭 색상 / 옵션 연결을 확인하세요.".to_string());
    }
    problems
}
fn save_alias(state:&mut Value,record:&Value)->Result<(),String>{
    let aliases=rows(field(state,"aliases"));
    let same=aliases.iter().position(|a|
        field(a,"clientId")==field(record,"clientId")&&
        key(str_field(a,"text"))==key(str_field(record,"text")));
    let by_id=aliases.iter().position(|a|str_field(a,"id")==str_field(record,"id"));
    if let (Some(si),Some(bi))=(same,by_id){
        if si!=bi{return Err("같은 적용 범위의 별칭이 이미 있습니다.".into());}
    }
    if let Some(si)=same {
        if by_id.is_none()&&
            (field(&aliases[si],"productId")!=field(record,"productId")||
             field(&aliases[si],"variantId")!=field(record,"variantId")){
            return Err("기존 별칭과 연결 상품이 충돌합니다. 기존 연결을 확인하세요.".into());
        }
    }
    let mut proposed=record.clone();
    if let Some(i)=by_id.or(same){set(&mut proposed,"id",field(&aliases[i],"id").clone())?;}
    let problems=alias_problems(&proposed,state);
    if !problems.is_empty(){return Err(problems.join("\n"));}
    let items=state["aliases"].as_array_mut().ok_or("별칭 목록이 없습니다.")?;
    if let Some(i)=by_id.or(same){
        let target=items[i].as_object_mut().ok_or("별칭 형식 오류")?;
        for (k,v) in proposed.as_object().ok_or("별칭 형식 오류")?{
            target.insert(k.clone(),v.clone());
        }
    }else{items.push(proposed);}
    Ok(())
}
fn registered_independent<'a>(state:&'a Value,id:&str,exclude_demo:bool)->Option<&'a Value>{
    find_by_id(field(state,"products"),id).filter(|p|
        active(p)&&rows(field(p,"variants")).len()==1&&
        (!exclude_demo||
         (str_field(p,"catalog")!="DEMO"&&
          rows(field(p,"variants")).iter().all(|v|str_field(v,"source")!="DEMO"))))
}
fn validate_model_group(state:&Value,ids:&Value,representative:&str)->Result<(),String>{
    let all=rows(ids);
    if all.len()<2{return Err("모델군에는 등록된 상품이 2개 이상 있어야 합니다.".into());}
    let names=all.iter().filter_map(Value::as_str).collect::<Vec<_>>();
    if names.iter().collect::<HashSet<_>>().len()!=all.len(){
        return Err("모델군에 같은 상품을 중복 등록할 수 없습니다.".into());
    }
    if names.iter().any(|id|registered_independent(state,id,true).is_none()){
        return Err("등록된 독립 판매 상품만 모델군에 추가할 수 있습니다.".into());
    }
    if representative.is_empty()||!names.contains(&representative){
        return Err("모델군에 등록된 상품 중 하나를 대표모델로 지정하세요.".into());
    }
    Ok(())
}
fn validate_color_group(state:&Value,ids:&Value,representative:&str)->Result<(),String>{
    let all=rows(ids);
    if all.len()<2 {
        return Err("대표색상 그룹은 색상이 다른 독립 상품 2개 이상이 필요합니다.".into());
    }
    let products=all.iter().map(|id|
        registered_independent(state,id.as_str().unwrap_or(""),false)).collect::<Vec<_>>();
    if products.iter().any(Option::is_none){
        return Err("등록된 독립 판매 상품만 그룹에 추가하세요.".into());
    }
    let variants=products.iter().filter_map(|p|p.map(|p|&p["variants"][0]))
        .collect::<Vec<_>>();
    let colors=variants.iter().map(|v|color_label(str_field(v,"color")).to_lowercase())
        .collect::<Vec<_>>();
    if colors.iter().any(|c|c.is_empty()||c=="단일"||c=="색상 미표기"){
        return Err("실제 색상이 등록된 상품만 그룹에 추가하세요.".into());
    }
    if colors.iter().collect::<HashSet<_>>().len()!=colors.len(){
        return Err("같은 색상 상품이 중복됐습니다. 다른 규격은 별도 그룹으로 관리하세요.".into());
    }
    let first=variants[0];
    if ["wholesale","semi","retail"].iter().all(|k|field(first,k).is_null()){
        return Err("비교할 가격이 없는 상품은 대표색상 그룹으로 등록할 수 없습니다.".into());
    }
    if variants.iter().any(|v|["wholesale","semi","retail"].iter()
        .any(|k|field(v,k)!=field(first,k))){
        return Err("색상에 따라 가격이 다릅니다. 동일한 가격의 상품만 대표색상 그룹으로 등록하세요.".into());
    }
    if !colors.contains(&color_label(representative).to_lowercase()){
        return Err("대표색상은 그룹에 등록된 상품의 실제 색상에서 선택하세요.".into());
    }
    Ok(())
}
fn quantity_text(raw:&str,source:bool)->String{
    let pattern=if source {
        r"\s*(?:\d+)\s*(?:개|대|세트|ea).*$"
    }else{
        r"\s*\d+\s*(?:개|대).*$"
    };
    Regex::new(pattern).expect("literal").replace(raw,"").trim().to_string()
}
fn selected_item(product:&Value,client:&Value,chosen_color:&str,quantity:&Value,
    new_id:&str)->Result<Value,String>{
    let normalized=color(chosen_color);
    let variants=rows(field(product,"variants"));
    let selectable=variants.len()==1&&!flag(product,"requiresOption");
    let selected=if selectable {
        variants.iter().find(|v|color(str_field(v,"color"))==normalized)
    }else{None};
    let name=str_field(product,"name");
    let basic=if name.is_empty(){str_field(product,"code")}else{name};
    let basic=basic.strip_prefix("반도스탠드").unwrap_or(basic).trim();
    let mut visible=basic.to_string();
    if variants.iter().any(|v|str_field(v,"source")=="DEMO")&&!visible.starts_with("[가상] "){
        visible=format!("[가상] {visible}");
    }
    let variant_id=selected.map(|v|field(v,"id").clone()).unwrap_or(Value::Null);
    let price=if let Some(v)=selected{
        super::pricing::resolve_unit_price(product,str_field(v,"id"),client)?
    }else{Value::Null};
    let issues=if selected.is_some(){
        if (str_field(product,"colorStatus")=="MISSING" ||
            (!flag(product,"saleUnit")&&
             ["색상 미표기",""].contains(&str_field(product,"defaultColor"))))&&
            chosen_color.is_empty(){
            vec!["기본 색상 확인 필요"]
        }else{vec![]}
    }else if flag(product,"requiresOption"){
        vec!["상품 구성 미확정 / 판매 구성을 확인하세요"]
    }else{vec!["등록된 독립 상품을 다시 선택하세요"]};
    let mut item=json!({
        "id":new_id,"productId":field(product,"id"),"variantId":variant_id,
        "raw":field(product,"name"),"name":visible,"color":normalized,
        "quantity":quantity,"unitPrice":price,
        "origin":field(product,"origin"),"defaulted":chosen_color.is_empty(),
        "issues":issues,"url":selected.map(|v|str_field(v,"url")).unwrap_or("")
    });
    if let Some(catalog)=product.get("catalog"){set(&mut item,"catalog",catalog.clone())?;}
    Ok(item)
}
fn resolve(payload:&Value)->Result<Value,String>{
    let mut state=req(payload,"state")?.clone();
    let mut order=req(payload,"order")?.clone();
    let rid=required_str(payload,"recipientId")?;
    let iid=required_str(payload,"itemId")?;
    let pid=required_str(payload,"productId")?;
    let scope=required_str(payload,"scope")?;
    let needs_customer=flag(payload,"needsCustomer");
    if !["once","client","common"].contains(&scope){
        return Err("별칭 저장 범위를 확인하세요.".into());
    }
    let product=find_by_id(field(&state,"products"),pid).filter(|p|active(p))
        .cloned();
    let client=if str_field(&order,"orderType")=="RETAIL"{
        field(&order,"clientSnapshot").clone()
    }else if (has_value(field(&order,"confirmedAt"))||flag(&order,"pricesLocked"))&&
        has_value(field(&order,"clientSnapshot")){
        field(&order,"clientSnapshot").clone()
    }else{
        find_by_id(field(&state,"clients"),str_field(&order,"clientId"))
            .cloned().or_else(||order.get("clientSnapshot").cloned()).unwrap_or(Value::Null)
    };
    let ri=rows(field(&order,"recipients")).iter()
        .position(|r|str_field(r,"id")==rid);
    let ii=ri.and_then(|ri|rows(field(&order["recipients"][ri],"items")).iter()
        .position(|i|str_field(i,"id")==iid));
    if ri.zip(ii).is_none()||product.is_none()||client.is_null(){
        return Err("거래처 / 수취인 / 등록 상품을 확인하세요.".into());
    }
    let (ri,ii)=ri.zip(ii).unwrap();
    let product=product.unwrap();
    let old=order["recipients"][ri]["items"][ii].clone();
    let selected_id=str_field(payload,"variantId");
    let variant=if selected_id.is_empty(){
        rows(field(&product,"variants")).first()
    }else{
        rows(field(&product,"variants")).iter().find(|v|str_field(v,"id")==selected_id)
    }.ok_or("실제 상품 옵션을 선택하세요.")?;
    let changed=str_field(&old,"productId")!=pid ||
        (!selected_id.is_empty()&&str_field(&old,"variantId")!=selected_id);
    let mut default_color=None::<Value>;
    let mut representative=None::<Value>;
    let group_id=str_field(payload,"defaultColorGroupId");
    if !group_id.is_empty(){
        let group=field(field(field(&state,"settings"),"colorGuidanceGroups"),group_id);
        if group.is_null()||!rows(field(group,"productIds")).iter()
            .any(|id|id.as_str()==Some(pid)){
            return Err("대표모델 그룹과 선택 상품이 일치하지 않습니다.".into());
        }
        if group.get("representativeProductId").is_some(){
            let rep=str_field(group,"representativeProductId");
            validate_model_group(&state,field(group,"productIds"),rep)?;
            if rep!=pid||rows(field(&product,"variants")).len()!=1||
                str_field(&product["variants"][0],"id")!=str_field(variant,"id"){
                return Err("지정한 대표모델과 실제 선택 상품이 일치하지 않습니다.".into());
            }
            representative=Some(json!({"groupId":group_id,"productId":pid,
                "productName":field(&product,"name")}));
        }else{
            let rep_color=str_field(group,"representativeColor");
            if rep_color.is_empty()||color(rep_color)!=color(str_field(variant,"color"))||
                (!str_field(&old,"color").is_empty()&&
                 !["색상 미표기","단일"].contains(&str_field(&old,"color"))){
                return Err("기존 기본색상과 선택 상품이 일치하지 않습니다.".into());
            }
            validate_color_group(&state,field(group,"productIds"),rep_color)?;
            default_color=Some(json!({"groupId":group_id,"color":field(variant,"color")}));
        }
    }
    let mut chosen=selected_item(&product,&client,str_field(variant,"color"),
        field(&old,"quantity"),required_str(payload,"newItemId")?)?;
    let dispatch_origin=order["recipients"][ri].get("dispatchOrigin").cloned();
    // Object.assign(originalItem, selectedCatalogItem, employeeEvidence, flags).
    let updated=&mut order["recipients"][ri]["items"][ii];
    let map=updated.as_object_mut().ok_or("상품 데이터 오류")?;
    for (k,v) in chosen.as_object_mut().ok_or("상품 데이터 오류")?{
        map.insert(k.clone(),v.clone());
    }
    for name in ["id","raw","sources","quantityConfirmed","quantityApproval"]{
        if let Some(value)=old.get(name){map.insert(name.into(),value.clone());}
        else{map.remove(name);}
    }
    map.remove("pendingAlias");
    map.insert("manuallyConfirmed".into(),json!(true));
    map.insert("temporary".into(),json!(false));
    map.insert("match".into(),json!({"kind":"NAME","term":field(&product,"name"),
        "productIds":[pid]}));
    let expression=rows(field(&old,"sources")).iter().find(|span|
        str_field(span,"field")=="product").and_then(|s|s.get("text"))
        .and_then(Value::as_str).filter(|s|!s.is_empty())
        .map(str::to_string).unwrap_or_else(||quantity_text(str_field(&old,"raw"),false));
    set(updated,"selectionEvidence",json!({"expression":expression,
        "productId":pid,"variantId":field(variant,"id")}))?;
    if let Some(value)=default_color {set(updated,"appliedDefaultColor",value)?;}
    else{updated.as_object_mut().ok_or("상품 데이터 오류")?.remove("appliedDefaultColor");}
    if let Some(value)=representative {set(updated,"appliedRepresentativeModel",value)?;}
    else{updated.as_object_mut().ok_or("상품 데이터 오류")?.remove("appliedRepresentativeModel");}
    if let Some(origin)=dispatch_origin.filter(|v|!v.is_null()){
        set(updated,"origin",origin)?;
    }
    if changed{updated.as_object_mut().ok_or("상품 데이터 오류")?.remove("quantityApproval");}
    if needs_customer{
        set(updated,"modelProposal",json!({"original":field(&old,"raw"),"required":true}))?;
        if !field(updated,"issues").is_array(){set(updated,"issues",json!([]))?;}
        updated["issues"].as_array_mut().ok_or("상품 오류 목록")?
            .push(json!("추천 상품 고객 확인 필요"));
    }else{
        updated.as_object_mut().ok_or("상품 데이터 오류")?.remove("modelProposal");
    }
    if scope!="once"{
        let raw=str_field(&old,"raw");
        let text=quantity_text(raw,true);
        let record=json!({
            "id":required_str(payload,"aliasId")?,
            "text":text,"productId":pid,"variantId":field(variant,"id"),
            "clientId":if scope=="common"{Value::Null}else{field(&client,"id").clone()},
            "createdAt":required_str(payload,"now")?,
            "actor":if str_field(field(&state,"settings"),"operatorName").is_empty(){
                "직원"}else{str_field(field(&state,"settings"),"operatorName")}
        });
        if needs_customer{
            let errors=alias_problems(&record,&state);
            if !errors.is_empty(){return Err(errors.join("\n"));}
            set(updated,"pendingAlias",record)?;
        }else{
            save_alias(&mut state,&record)?;
        }
    }
    Ok(json!({"state":state,"order":order}))
}
fn confirm(payload:&Value)->Result<Value,String>{
    let mut state=req(payload,"state")?.clone();
    let mut order=req(payload,"order")?.clone();
    let rid=required_str(payload,"recipientId")?;
    let iid=required_str(payload,"itemId")?;
    let ri=rows(field(&order,"recipients")).iter().position(|r|str_field(r,"id")==rid);
    let ii=ri.and_then(|ri|rows(field(&order["recipients"][ri],"items")).iter()
        .position(|i|str_field(i,"id")==iid));
    let (ri,ii)=ri.zip(ii).ok_or("고객 확인 대기 품목을 선택하세요.")?;
    let item=&mut order["recipients"][ri]["items"][ii];
    if !flag(field(item,"modelProposal"),"required"){
        return Err("고객 확인 대기 품목을 선택하세요.".into());
    }
    let pending=item.get("pendingAlias").cloned();
    if let Some(alias)=pending.as_ref(){save_alias(&mut state,alias)?;}
    let item=&mut order["recipients"][ri]["items"][ii];
    item.as_object_mut().ok_or("상품 데이터 오류")?.remove("pendingAlias");
    set(&mut item["modelProposal"],"required",json!(false))?;
    let issues=rows(field(item,"issues")).iter().filter(|i|
        i.as_str()!=Some("추천 상품 고객 확인 필요")).cloned().collect::<Vec<_>>();
    set(item,"issues",json!(issues))?;
    Ok(json!({"state":state,"order":order}))
}
pub(super) fn apply(payload:&Value)->Result<Value,String>{
    match required_str(payload,"action")?{
        "resolve_product"=>resolve(payload),
        "confirm_proposed_product"=>confirm(payload),
        action=>Err(format!("지원하지 않는 상품 확정 action: {action}"))
    }
}
