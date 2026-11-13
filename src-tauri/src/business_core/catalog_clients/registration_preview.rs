//! Native product registration Excel preview after ExcelJS has read raw cells.
//! The source is the original TS previewRegistrationWorkbook row algorithm.
//! Inputs contain only worksheet text, unsafe-cell marker and caller-supplied IDs.
use serde_json::{json, Value,Map};
use unicode_normalization::UnicodeNormalization;
use std::collections::{HashMap,HashSet};
use super::{field,items,normalized_color,product_url_ok,validate_product};
use super::registration::{registry_key,existing_matches};

fn strval<'a>(v:&'a Value,k:&str)->&'a str{field(v,k)}
fn categories(state:&Value)->Vec<Value>{
    let mut cats=items(state,"categories").to_vec();
    for (id,name) in [("catalog-root:BANDOSTAND","반도스탠드"),
        ("catalog-root:BANDOMALL","반도몰")]{
        if !cats.iter().any(|c|field(c,"id")==id){
            cats.push(json!({"id":id,"name":name,"parentId":null}));
        }
    }
    cats
}
fn category_path(all:&[Value],id:&str)->Result<Vec<Value>,String>{
    let mut output=vec![];
    let mut current=id.to_owned();
    let mut seen=HashSet::new();
    while !current.is_empty(){
        if !seen.insert(current.clone()){return Err("카테고리가 순환합니다.".into())}
        let Some(cat)=all.iter().find(|c|field(c,"id")==current)else{break};
        output.insert(0,cat.clone());
        current=field(cat,"parentId").into();
    }
    Ok(output)
}
fn matching_category(state:&Value,requested:&str,catalog:&str)->Result<Option<Vec<Value>>,String>{
    let all=categories(state);
    let requested=requested.split(|c|c=='/'||c=='>')
        .map(str::trim).filter(|s|!s.is_empty()).collect::<Vec<_>>().join(" / ");
    let mut found=vec![];
    for cat in &all{
        let id=field(cat,"id");
        if cat.get("active")==Some(&Value::Bool(false)){continue}
        if all.iter().any(|child|field(child,"parentId")==id){continue}
        let path=category_path(&all,id)?;
        let names=path.iter().map(|c|field(c,"name")).collect::<Vec<_>>().join(" / ");
        let root=path.first().map(|c|field(c,"id")).unwrap_or("");
        let expected=if catalog=="BANDOMALL"{"catalog-root:BANDOMALL"}
            else{"catalog-root:BANDOSTAND"};
        if root==expected && names==requested{found.push(path);}
    }
    Ok(if found.len()==1{found.pop()}else{None})
}
fn label_color(color:&str)->String{
    match color.trim().to_lowercase().as_str(){
        "gold"|"골드"=>"골드",
        "rose gold"|"로즈골드"=>"로즈골드",
        "cosmo black"|"코스모블랙"=>"코스모블랙",
        "black"|"검정"|"블랙"=>"블랙",
        "gray"|"grey"|"회색"|"그레이"=>"그레이",
        "brown"|"브라운"=>"브라운",
        "white"|"흰색"|"화이트"=>"화이트",
        "clear"|"클리어"=>"클리어",
        "frost"|"frosted"|"프로스트"=>"프로스트",
        "silver"|"실버"=>"실버",
        "blue"|"블루"=>"블루",
        "red"|"레드"=>"레드",
        "색상 미표기"=>"",
        _=>color
    }.to_owned()
}
fn identity(values:&Value,catalog:&str,color:&str)->String{
    let label=label_color(color);
    let fields=[strval(values,"브랜드"),strval(values,"최종 등록명"),
        label.as_str(),strval(values,"규격"),strval(values,"판매 단위")];
    let data=fields.iter().map(|s|registry_key(s)).collect::<Vec<_>>().join("|");
    format!("{}|{}|{}",catalog,data,registry_key(strval(values,"최종 등록명")))
}
fn price(raw:&str)->Result<Value,String>{
    if raw.is_empty(){return Ok(Value::Null)}
    // Accept either ungrouped decimal digits or comma thousands grouping.
    let valid=if !raw.contains(','){raw.bytes().all(|b|b.is_ascii_digit())}
        else{
            let groups=raw.split(',').collect::<Vec<_>>();
            !groups.is_empty() && (1..=3).contains(&groups[0].len()) &&
            groups.iter().enumerate().all(|(i,g)|
                g.bytes().all(|b|b.is_ascii_digit()) && (i==0||g.len()==3))
        };
    if !valid{return Err("가격은 0 이상의 원 단위 정수로 입력하세요.".into())}
    let raw=raw.replace(',',"");
    let parsed=raw.parse::<u64>().map_err(|_|"가격이 허용 범위를 벗어났습니다.")?;
    if parsed>9_007_199_254_740_991{
        return Err("가격이 허용 범위를 벗어났습니다.".into())
    }
    Ok(if parsed==0{Value::Null}else{json!(parsed)})
}
fn brands(state:&Value,brand:&str)->Vec<Value>{
    items(state,"brands").iter().filter(|b|{
        let mut terms=vec![field(b,"name"),field(b,"korean")];
        terms.extend(items(b,"aliases").iter().filter_map(Value::as_str));
        terms.iter().any(|term|registry_key(term)==registry_key(brand))
    }).cloned().collect()
}
fn product_record(values:&Value,id:&str,variant_id:&str,at:&str,
    catalog:&str,path:&[Value],brands:&[Value],color:&str,
    prices:&[Value],identity:&str)->Value{
    let mut p=json!({
        "id":id,"code":id,"name":strval(values,"최종 등록명"),"catalog":catalog,
        "origin":if catalog=="BANDOSTAND"{"FACTORY"}else{"STORE"},
        "category":path.iter().map(|c|field(c,"name")).collect::<Vec<_>>().join(" > "),
        "categories":path.iter().map(|c|field(c,"id")).collect::<Vec<_>>(),
        "sellingUnit":strval(values,"판매 단위"),
        "saleUnit":true,"registrationIdentity":identity,"verificationStatus":"REGISTERED",
        "familyKey":id,"modelKey":format!("REG|{}",identity),"defaultColor":color,
        "colorStatus":if color=="단일"{"NOT_REQUIRED"}else{"KNOWN"},"active":true,
        "variants":[{"id":variant_id,"color":color,"option":strval(values,"구성 구분"),
            "wholesale":prices[0],"semi":prices[1],"retail":prices[2],
            "url":strval(values,"상품 링크"),"source":"MANUAL"}],
        "createdAt":at,"updatedAt":at
    });
    if let Some(b)=brands.first(){p["brandId"]=b.get("id").cloned().unwrap_or(Value::Null)}
    let spec=strval(values,"규격");
    if !spec.is_empty(){p["specification"]=json!(spec);}
    p
}
pub(super) fn preview(payload:&Value)->Result<Value,String>{
    let state=payload.get("state").ok_or("현재 상태가 없습니다.")?;
    let data=items(payload,"rows");
    if data.len()>2_000{return Err("한 번에 최대 2,000행까지 등록할 수 있습니다.".into())}
    let mut rows=vec![];
    let mut seen=HashMap::<String,u64>::new();
    let mut prior=items(state,"products").to_vec();
    let generated=items(payload,"generated");
    for (index,line) in data.iter().enumerate(){
        let values=line.get("values").ok_or("상품 등록 행 정보가 없습니다.")?;
        let row_no=line.get("row").and_then(Value::as_u64).unwrap_or(0);
        if let Some(map)=values.as_object(){
            if map.values().all(|v|v.as_str().is_none_or(str::is_empty)){continue;}
        }
        let mut errors=vec![];
        let mut holds=vec![];
        if line.get("unsafeCells")==Some(&Value::Bool(true)){
            errors.push("병합 셀과 수식은 허용하지 않습니다.".to_owned());
        }
        let name=strval(values,"최종 등록명");
        if name.is_empty(){errors.push("최종 등록명을 입력하세요.".into())}
        let config=strval(values,"구성 구분").trim();
        if !config.is_empty() && !registry_key(name).contains(&registry_key(config)){
            holds.push("구성 구분 정보는 별도 옵션이 아니라 최종 등록명에 포함해야 합니다.".into())
        }
        if strval(values,"판매 단위").is_empty(){
            errors.push("판매 단위를 입력하세요.".into())
        }
        let catalog=match strval(values,"상품군"){
            "반도스탠드"=>Some("BANDOSTAND"),"반도몰"=>Some("BANDOMALL"),_=>None
        };
        if catalog.is_none(){errors.push("상품군을 반도스탠드 또는 반도몰로 지정하세요.".into())}
        let path=if let Some(c)=catalog{
            matching_category(state,strval(values,"카테고리 경로"),c)?
        }else{None};
        if path.is_none(){holds.push("카테고리 맵의 최하위 분류 경로를 확인하세요.".into())}
        let brand_name=strval(values,"브랜드");
        let matched_brands=brands(state,brand_name);
        if !brand_name.is_empty() && matched_brands.len()!=1 {
            holds.push("브랜드 등록 정보가 모호하거나 없습니다.".into())
        }
        let mut prices=vec![];
        for key in ["도매가","반도매가","소매가"]{
            match price(strval(values,key)){
                Ok(value)=>prices.push(value),
                Err(message)=>{
                    errors.push(format!("{key}: {message}"));
                    prices.push(Value::Null);
                }
            }
        }
        let url=strval(values,"상품 링크");
        if !url.is_empty()&&!product_url_ok(url){
            errors.push("반도스탠드 / 반도몰 공식 상품 링크만 허용됩니다.".into())
        }
        let color=normalized_color(if strval(values,"색상").is_empty(){"단일"}
            else{strval(values,"색상")});
        let identifier=identity(values,catalog.unwrap_or("UNKNOWN"),&color);
        let ids=generated.get(index).ok_or("상품 등록 ID가 누락됐습니다.")?;
        let at=field(ids,"at");
        let product_id=field(ids,"productId");
        let variant_id=field(ids,"variantId");
        if at.is_empty()||product_id.is_empty()||variant_id.is_empty(){
            return Err("신규 상품 UUID 또는 생성 시간이 누락됐습니다.".into())
        }
        let product=if !name.is_empty() && catalog.is_some() && path.is_some() && errors.is_empty(){
            Some(product_record(values,product_id,variant_id,at,catalog.unwrap(),
                path.as_ref().unwrap(),&matched_brands,&color,&prices,&identifier))
        }else{None};
        let mut duplicate_ids=vec![];
        if let Some(ref p)=product{
            duplicate_ids=existing_matches(&prior,p);
            if duplicate_ids.is_empty(){
                let mut validation=state.clone();
                validation["products"]=json!(prior.iter().filter(|other|
                    other.get("active")!=Some(&Value::Bool(false))
                    && field(other,"deletedAt").is_empty()
                    && field(other,"supersededBy").is_empty()).collect::<Vec<_>>());
                if let Err(err)=validate_product(&validation,p){errors.push(err)}
            }
        }
        if let Some(earlier)=seen.get(&identifier){
            holds.push(format!("{earlier}행과 같은 판매 구성입니다."));
        }else{seen.insert(identifier.clone(),row_no);}
        let status=if !errors.is_empty(){"ERROR"}
            else if !duplicate_ids.is_empty(){"DUPLICATE"}
            else if !holds.is_empty(){"HOLD"}else{"READY"};
        let mut serialized=Map::new();
        serialized.insert("row".into(),json!(row_no));
        serialized.insert("values".into(),values.clone());
        serialized.insert("identity".into(),json!(identifier));
        serialized.insert("status".into(),json!(status));
        errors.extend(holds);
        serialized.insert("errors".into(),json!(errors));
        serialized.insert("duplicateIds".into(),json!(duplicate_ids));
        if status=="READY" {
            if let Some(p)=product{
                prior.push(p.clone());
                serialized.insert("product".into(),p);
            }
        }
        rows.push(Value::Object(serialized));
    }
    if rows.is_empty(){return Err("등록할 상품 행이 없습니다.".into())}
    Ok(json!({
        "fingerprint":strval(payload,"fingerprint"),
        "revision":state.get("revision").and_then(Value::as_i64).unwrap_or(0),
        "rows":rows
    }))
}
