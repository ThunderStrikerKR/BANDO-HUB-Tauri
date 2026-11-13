//! Alias save policy and diagnostics, originally src/matching.ts.
//! Native operations never modify historical orders or unselected products.
use serde_json::{json,Value};
use unicode_normalization::UnicodeNormalization;
use regex::Regex;
use super::{field,items};

fn model_key(text:&str)->String{
    let nfkc=text.nfkc().collect::<String>();
    let collapsed=nfkc.chars().flat_map(char::to_uppercase)
        .filter(|c|!c.is_whitespace()).collect::<String>();
    collapsed.strip_prefix("BD").unwrap_or(&collapsed).to_owned()
}
fn model_names(product:&Value)->Vec<String>{
    let lead=field(product,"name").split('/').next().unwrap_or("").trim();
    if lead.is_empty(){return vec![]}
    let no_brand=Regex::new(r"(?i)^BD[\s-]+").unwrap().replace(lead,"").to_string();
    if no_brand==lead{vec![lead.to_owned()]}else{vec![lead.to_owned(),no_brand]}
}
fn visible(product:&Value)->bool{
    field(product,"deletedAt").is_empty()&&field(product,"supersededBy").is_empty()
}
fn alias_problem(record:&Value,aliases:&[Value],products:&[Value])->Vec<String>{
    let target=products.iter().find(|p|field(p,"id")==field(record,"productId"));
    let key=model_key(field(record,"text"));
    let mut out=vec![];
    if field(record,"text").trim().is_empty() ||
        target.is_none_or(|p|!field(p,"deletedAt").is_empty()){
        out.push("별칭과 연결할 상품을 입력하세요.".to_owned());
    }
    if aliases.iter().any(|a|field(a,"id")!=field(record,"id")&&
        a.get("clientId")==record.get("clientId")&&
        model_key(field(a,"text"))==key&&
        (a.get("productId")!=record.get("productId")||
         a.get("variantId")!=record.get("variantId"))){
        out.push("같은 적용 범위의 별칭이 충돌합니다.".to_owned());
    }
    if let Some(target)=target{
        if products.iter().any(|p|visible(p)&&
            model_names(p).iter().chain(std::iter::once(&field(p,"name").to_owned()))
                .any(|name|model_key(name)==key) &&field(p,"id")!=field(target,"id")){
            out.push("다른 등록 상품명 또는 모델 표기와 충돌하는 별칭입니다.".to_owned());
        }
    }
    let suffix=Regex::new(r"^(\d{3}(?:-\d+)?)(BK|BR|B|C|W|G)$").unwrap();
    if let Some(captures)=suffix.captures(&key){
        let base=captures.get(1).unwrap().as_str();
        if !products.iter().any(|p|field(p,"deletedAt").is_empty()&&
            model_names(p).iter().any(|n|model_key(n)==key)){
            let bases=products.iter().filter(|p|field(p,"deletedAt").is_empty()&&
                model_names(p).iter().any(|n|model_key(n)==base)).collect::<Vec<_>>();
            let variant=target.and_then(|p|items(p,"variants").iter()
                .find(|v|field(v,"id")==field(record,"variantId")));
            let desired=match captures.get(2).unwrap().as_str(){
                "BK"|"B"=>"black","BR"=>"brown","C"=>"chrome",
                "W"=>"white",_=>"gray"
            };
            let actual=variant.map(|v|{
                let color=field(v,"color");
                match color{"블랙"|"검정"=>"black","브라운"=>"brown","크롬"=>"chrome",
                    "화이트"=>"white","그레이"|"회색"=>"gray",_=>color}
            });
            if !bases.is_empty() && (target.is_none()||
                !bases.iter().any(|p|field(p,"id")==field(record,"productId"))||
                actual.is_some_and(|color|!color.eq_ignore_ascii_case(desired))){
                out.push("상품명의 색상 또는 구성 표기와 충돌하는 별칭입니다.".to_owned());
            }
        }
    }
    if !field(record,"variantId").is_empty() &&
       !target.is_some_and(|p|items(p,"variants").iter()
            .any(|v|field(v,"id")==field(record,"variantId"))){
        out.push("별칭 색상 / 옵션 연결을 확인하세요.".to_owned())
    }
    out
}
fn save_alias(state:&Value,record:&Value)->Result<Value,String>{
    let mut next=state.clone();
    let all=items(&next,"aliases");
    let key=model_key(field(record,"text"));
    let same=all.iter().find(|a|a.get("clientId")==record.get("clientId")&&
        model_key(field(a,"text"))==key);
    let by_id=all.iter().find(|a|field(a,"id")==field(record,"id"));
    if same.is_some()&&by_id.is_some()&&
        field(same.unwrap(),"id")!=field(by_id.unwrap(),"id"){
        return Err("같은 적용 범위의 별칭이 이미 있습니다.".into());
    }
    if let Some(existing)=same{
        if by_id.is_none() && (existing.get("productId")!=record.get("productId")||
            existing.get("variantId")!=record.get("variantId")){
            return Err("기존 별칭과 연결 상품이 충돌합니다. 기존 연결을 확인하세요.".into())
        }
    }
    let mut proposed=record.clone();
    proposed["id"]=json!(by_id.or(same).map(|r|field(r,"id"))
        .unwrap_or_else(||field(record,"id")));
    let errors=alias_problem(&proposed,all,items(&next,"products"));
    if !errors.is_empty(){return Err(errors.join("\n"))}
    let existing=by_id.or(same).map(|e|field(e,"id").to_owned());
    let aliases=next.get_mut("aliases").and_then(Value::as_array_mut)
        .ok_or("별칭 목록이 없습니다.")?;
    if let Some(existing_id)=existing{
        if let Some(row)=aliases.iter_mut().find(|r|field(r,"id")==existing_id){
            if let (Some(target),Some(patch))=(row.as_object_mut(),proposed.as_object()){
                for (key,val) in patch{target.insert(key.clone(),val.clone());}
            }
        }
    }else{aliases.push(proposed);}
    Ok(json!({"state":next}))
}
pub(super) fn execute(operation:&str,payload:&Value)->Result<Value,String>{
    let state=payload.get("state").ok_or("현재 상태가 없습니다.")?;
    match operation{
        "save_alias"=>save_alias(state,payload.get("record")
            .ok_or("별칭 저장 정보가 없습니다.")?),
        "alias_problems"=>{
            let all=items(state,"aliases");let products=items(state,"products");
            Ok(json!(all.iter().map(|a|json!({
                "id":field(a,"id"),"problems":alias_problem(a,all,products)
            })).collect::<Vec<_>>()))
        }
        "alias_problems_one"=>{
            Ok(json!(alias_problem(payload.get("record").ok_or("별칭이 없습니다.")?,
                items(state,"aliases"),items(state,"products"))))
        }
        _=>Err(format!("지원하지 않는 별칭 업무입니다: {operation}"))
    }
}
#[cfg(test)]
mod tests{
    use super::*;
    #[test]
    fn overwrite_same_scope_preserves_id_and_old_orders(){
        let state=json!({"aliases":[{"id":"a1","text":"보면대","productId":"p",
            "variantId":"v","clientId":null}],"products":[{"id":"p","name":"BD 709",
            "variants":[{"id":"v","color":"Black"}]}],"orders":[{"id":"old"}]});
        let row=json!({"id":"a2","text":"보면대","productId":"p","variantId":"v",
            "clientId":null});
        let next=save_alias(&state,&row).unwrap();
        assert_eq!(next["state"]["aliases"][0]["id"],"a1");
        assert_eq!(next["state"]["orders"][0]["id"],"old");
    }
}
