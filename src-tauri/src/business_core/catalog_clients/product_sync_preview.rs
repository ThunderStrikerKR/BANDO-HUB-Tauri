//! Original oracle: src/product-sync-workbook.ts::previewProductSyncRows.
//! Runs after ExcelJS parses raw rows; no filesystem access or implicit DB save.
use serde_json::{json,Value};
use std::collections::{HashMap,HashSet,BTreeMap};
use super::{field,items,normalized_color,validate_product};

const EMPTY:&str="[비우기]";
const MAX_ROWS:usize=20_000;
fn raw(v:&Value)->Vec<String>{
    items(v,"cells").iter().map(|c|c.as_str().unwrap_or("").to_owned()).collect()
}
fn cell<'a>(values:&'a [String],index:usize)->&'a str{
    values.get(index).map(String::as_str).unwrap_or("")
}
fn archived(product:&Value)->bool{
    !field(product,"deletedAt").is_empty()||!field(product,"supersededBy").is_empty()
}
fn optional(raw:&str,previous:&str)->String{
    if raw==EMPTY{"".into()}else if raw.is_empty(){previous.to_owned()}else{raw.to_owned()}
}
fn yes_no(raw:&str,previous:bool)->Result<bool,String>{
    match raw{
        ""=>Ok(previous),"사용"|"예"|"Y"=>Ok(true),
        "중지"|"아니오"|"N"=>Ok(false),
        _=>Err("상태는 사용 또는 중지로 입력하세요.".into())
    }
}
fn catalog(raw:&str)->Result<&'static str,String>{
    match raw{
        "반도스탠드"|"BANDOSTAND"=>Ok("BANDOSTAND"),
        "반도몰"|"BANDOMALL"=>Ok("BANDOMALL"),
        _=>Err("상품군은 반도스탠드 또는 반도몰이어야 합니다.".into())
    }
}
fn group_display(product:&Value)->&'static str{
    if field(product,"catalog")=="BANDOMALL"{"반도몰"}else{"반도스탠드"}
}
fn origin_display(product:&Value)->&'static str{
    if field(product,"origin")=="STORE"{"매장"}else{"공장"}
}
fn product_row(p:&Value)->Vec<String>{
    vec![
        field(p,"id").into(),"".into(),field(p,"name").into(),
        field(p,"subtitle").into(),"".into(),group_display(p).into(),
        origin_display(p).into(),
        items(p,"categories").iter().filter_map(Value::as_str)
            .collect::<Vec<_>>().join(" / "),
        field(p,"brandId").into(),field(p,"specification").into(),
        field(p,"sellingUnit").into(),field(p,"defaultColor").into(),
        if p.get("active")==Some(&Value::Bool(false)){"중지"}else{"사용"}.into(),
        if archived(p){"보관"}else{"정상"}.into(),
    ]
}
fn variant_row(p:&Value,v:&Value)->Vec<String>{
    let price=|key|match v.get(key){
        Some(Value::Null)|None=>"".into(),
        Some(other)=>other.to_string(),
    };
    vec![field(p,"id").into(),"".into(),field(v,"id").into(),
        field(v,"color").into(),field(v,"option").into(),
        price("wholesale"),price("semi"),price("retail"),
        field(v,"source").into(),field(v,"siteOptionId").into()]
}
fn category_edit(state:&Value,p:&mut Value,raw:&str)->Result<(),String>{
    let current=items(p,"categories").iter().filter_map(Value::as_str)
        .collect::<Vec<_>>().join(" / ");
    if raw.is_empty()||raw==current{return Ok(())}
    let ids=raw.split('/').map(str::trim).filter(|s|!s.is_empty())
        .collect::<Vec<_>>();
    let cats=items(state,"categories");
    let selected=ids.iter().map(|id|cats.iter().find(|c|field(c,"id")==*id))
        .collect::<Vec<_>>();
    if ids.is_empty()||selected.iter().any(|c|c.is_none()||
        c.is_some_and(|c|c.get("active")==Some(&Value::Bool(false)))){
        return Err("등록되지 않은 카테고리 ID입니다.".into())
    }
    for i in 1..ids.len(){
        if selected[i].unwrap().get("parentId").and_then(Value::as_str)!=Some(ids[i-1]){
            return Err("카테고리 계층이 일치하지 않습니다.".into())
        }
    }
    let last=ids[ids.len()-1];
    if cats.iter().any(|c|field(c,"parentId")==last &&
        c.get("active")!=Some(&Value::Bool(false))){
        return Err("최하위 카테고리를 선택하세요.".into())
    }
    p["categories"]=json!(ids);
    p["category"]=json!(selected.iter().map(|c|field(c.unwrap(),"name"))
        .collect::<Vec<_>>().join(" > "));
    Ok(())
}
fn brand_edit(state:&Value,p:&mut Value,raw:&str)->Result<(),String>{
    if raw.is_empty(){return Ok(())}
    let value=optional(raw,field(p,"brandId"));
    if !value.is_empty() && !items(state,"brands").iter().any(|b|field(b,"id")==value){
        return Err("등록되지 않은 브랜드 ID입니다.".into())
    }
    if value.is_empty(){p.as_object_mut().unwrap().remove("brandId");}
    else{p["brandId"]=json!(value);}
    Ok(())
}
fn update_product(state:&Value,current:&Value,cells:&[String])->Result<Value,String>{
    let mut p=current.clone();
    if archived(&p){
        if product_row(&p)!=cells{
            return Err("보관된 상품은 Excel에서 변경할 수 없습니다.".into())
        }
        return Ok(p)
    }
    if !cell(cells,1).is_empty(){
        return Err("기존 상품에는 신규등록키를 입력하지 마세요.".into())
    }
    if !cell(cells,4).is_empty()&&cell(cells,4)!=EMPTY{
        return Err("신규 모델코드는 기존 상품에 사용할 수 없습니다.".into())
    }
    if !cell(cells,5).is_empty()&&cell(cells,5)!=group_display(&p){
        return Err("기존 상품군 변경은 지원하지 않습니다.".into())
    }
    if !cell(cells,6).is_empty()&&cell(cells,6)!=origin_display(&p){
        return Err("기존 상품의 출고구분은 Excel에서 변경하지 않습니다.".into())
    }
    if !cell(cells,13).is_empty()&&cell(cells,13)!="정상"{
        return Err("보관 상태는 변경할 수 없습니다.".into())
    }
    p["name"]=json!(optional(cell(cells,2),field(&p,"name")));
    if !cell(cells,3).is_empty(){
        if cell(cells,3)==EMPTY{p.as_object_mut().unwrap().remove("subtitle");}
        else{p["subtitle"]=json!(cell(cells,3));}
    }
    if field(&p,"name").is_empty(){return Err("상품명은 비울 수 없습니다.".into())}
    category_edit(state,&mut p,cell(cells,7))?;
    brand_edit(state,&mut p,cell(cells,8))?;
    for (index,key) in [(9,"specification"),(10,"sellingUnit")]{
        if !cell(cells,index).is_empty(){
            if cell(cells,index)==EMPTY{p.as_object_mut().unwrap().remove(key);}
            else{p[key]=json!(cell(cells,index));}
        }
    }
    p["defaultColor"]=json!(optional(cell(cells,11),field(&p,"defaultColor")));
    p["active"]=json!(yes_no(cell(cells,12),
        p.get("active").and_then(Value::as_bool).unwrap_or(false))?);
    Ok(p)
}
fn new_product(state:&Value,cells:&[String],id:&str,now:&str)->Result<Value,String>{
    let group=catalog(cell(cells,5))?;
    let origin=if group=="BANDOMALL"{"STORE"}else{"FACTORY"};
    let mut p=json!({
        "id":id,"name":cell(cells,2),"code":id,"catalog":group,
        "origin":origin,"category":"","defaultColor":cell(cells,11),
        "active":yes_no(cell(cells,12),true)?,"variants":[],
        "createdAt":now,"updatedAt":now,"saleUnit":true,
        "colorStatus":"KNOWN","verificationStatus":"REGISTERED",
    });
    if field(&p,"name").trim().is_empty(){return Err("신규 상품명을 입력하세요.".into())}
    if field(&p,"defaultColor").is_empty(){return Err("신규 상품의 기본 색상을 입력하세요.".into())}
    if !cell(cells,6).is_empty()&&cell(cells,6)!=origin_display(&p){
        return Err("상품군과 출고구분이 일치하지 않습니다.".into())
    }
    p["subtitle"]=json!(optional(cell(cells,3),""));
    p["specification"]=json!(optional(cell(cells,9),""));
    p["sellingUnit"]=json!(optional(cell(cells,10),""));
    category_edit(state,&mut p,cell(cells,7))?;
    brand_edit(state,&mut p,cell(cells,8))?;
    p["familyKey"]=json!(id);
    Ok(p)
}
fn parse_price(raw:&str,previous:&Value)->Result<Value,String>{
    if raw.is_empty(){return Ok(previous.clone())}
    if raw==EMPTY||raw=="삭제"{return Ok(Value::Null)}
    let valid=if raw.contains(','){
        let groups=raw.split(',').collect::<Vec<_>>();
        !groups.is_empty() && (1..=3).contains(&groups[0].len())
            && groups.iter().enumerate().all(|(i,g)|
                g.bytes().all(|b|b.is_ascii_digit())&&(i==0||g.len()==3))
    }else{raw.bytes().all(|b|b.is_ascii_digit())};
    if !valid{return Err("가격은 0 이상의 정수, 공란 또는 [비우기]로 입력하세요.".into())}
    let n=raw.replace(',',"").parse::<u64>().map_err(|_|"가격 범위를 벗어났습니다.")?;
    if n>9_007_199_254_740_991{return Err("가격 범위를 벗어났습니다.".into())}
    Ok(json!(n))
}
fn new_variant(cells:&[String],id:&str)->Result<Value,String>{
    let color=cell(cells,3);
    if color.is_empty()||color==EMPTY{
        return Err("독립 상품의 색상을 입력하세요. 색상 구분이 없으면 단일로 입력하세요.".into())
    }
    if [8,9,4].iter().any(|i|!cell(cells,*i).is_empty()){
        return Err("신규 상품의 가격 기록에는 옵션명이나 외부 식별자를 직접 입력하지 않습니다. 구분 정보는 상품명에 기재하세요.".into())
    }
    Ok(json!({"id":id,"color":color,"option":"",
        "wholesale":parse_price(cell(cells,5),&Value::Null)?,
        "semi":parse_price(cell(cells,6),&Value::Null)?,
        "retail":parse_price(cell(cells,7),&Value::Null)?,
        "source":"MANUAL","url":""}))
}
fn edit_variant(original:&Value,cells:&[String],product:&mut Value,now:&str)->Result<Value,String>{
    if !cell(cells,8).is_empty()&&cell(cells,8)!=field(original,"source"){
        return Err("가격 원본은 변경할 수 없습니다.".into())
    }
    if !cell(cells,9).is_empty()&&cell(cells,9)!=field(original,"siteOptionId"){
        return Err("공식 사이트 식별자는 변경할 수 없습니다.".into())
    }
    let mut next=original.clone();
    next["color"]=json!(optional(cell(cells,3),field(&next,"color")));
    if !cell(cells,4).is_empty()&&cell(cells,4)!=field(original,"option"){
        return Err("공식 원본 구성 표기는 수정할 수 없습니다. 상품 구분은 상품명에서 수정하세요.".into())
    }
    for (index,tier) in [(5,"wholesale"),(6,"semi"),(7,"retail")]{
        let before=next.get(tier).cloned().unwrap_or(Value::Null);
        let amount=parse_price(cell(cells,index),&before)?;
        if before!=amount{
            if product.get("priceHistory").is_none(){product["priceHistory"]=json!([]);}
            product["priceHistory"].as_array_mut()
                .ok_or("가격 변경 이력 형식 오류")?.push(json!({
                    "at":now,"field":format!("{}.{}",field(&next,"id"),tier),
                    "before":before,"after":amount,"source":"MANUAL_EXCEL"
                }));
            next[tier]=amount;
            if tier=="retail"{next["source"]=json!("MANUAL");}
        }
    }
    Ok(next)
}
fn row_record(sheet:&str,row:&Value,id:&str,name:&str,status:&str,
    changes:Vec<String>,errors:Vec<String>)->Value{
    json!({"sheet":sheet,"row":row.get("row").cloned().unwrap_or(Value::Null),
        "id":id,"name":name,"status":status,"changes":changes,"errors":errors})
}
fn model_key(name:&str)->String{
    name.chars().flat_map(char::to_uppercase)
        .filter(|c|!c.is_whitespace()&&*c!='-').collect()
}
fn identity(p:&Value)->String{
    let catalog=if field(p,"catalog").is_empty(){"BANDOSTAND"}else{field(p,"catalog")};
    format!("{}|{}",catalog,model_key(field(p,"name")))
}
fn status_priority(s:&str)->u8{
    match s{"UNCHANGED"=>0,"UPDATE"=>1,"ADD"=>2,"HOLD"=>3,"ERROR"=>4,_=>0}
}
fn consolidate(rows:&[Value])->Vec<Value>{
    let mut merged=BTreeMap::<u64,Value>::new();
    for item in rows{
        let row=item.get("row").and_then(Value::as_u64).unwrap_or(0);
        if let Some(previous)=merged.get_mut(&row){
            if status_priority(field(item,"status"))>status_priority(field(previous,"status")){
                previous["status"]=json!(field(item,"status"));
            }
            if !field(item,"name").is_empty()&&field(item,"sheet")=="상품 목록"{
                previous["name"]=json!(field(item,"name"));
            }
            for key in ["changes","errors"]{
                let additional=items(item,key).to_vec();
                if let Some(v)=previous.get_mut(key).and_then(Value::as_array_mut){
                    v.extend(additional)
                }
            }
        }else{
            let mut copy=item.clone();
            copy["sheet"]=json!("상품 목록");
            merged.insert(row,copy);
        }
    }
    merged.into_values().collect()
}
pub(super) fn preview(payload:&Value)->Result<Value,String>{
    let state=payload.get("state").ok_or("현재 상태가 없습니다.")?;
    let source=payload.get("source").ok_or("상품 Excel 원본 정보가 없습니다.")?;
    let revision=state.get("revision").and_then(Value::as_i64).unwrap_or(0);
    if source.get("revision").and_then(Value::as_i64)!=Some(revision){
        return Err("Excel 다운로드 후 상품 데이터가 변경되었습니다. 다시 내려받으세요.".into())
    }
    let sources=items(source,"products");let option_sources=items(source,"options");
    if sources.len()>MAX_ROWS||option_sources.len()>MAX_ROWS{
        return Err("Excel은 시트당 20,000행까지 지원합니다.".into())
    }
    let generated=items(payload,"productIds");let option_ids=items(payload,"optionIds");
    let now=field(payload,"now");
    if now.is_empty(){return Err("상품 변경 시간이 누락됐습니다.".into())}
    let initial=items(state,"products");
    let mut next=initial.to_vec();
    let mut rows=vec![];
    let mut seen_products=HashSet::<String>::new();
    let mut seen_options=HashSet::<String>::new();
    let mut keys=HashMap::<String,String>::new();
    let mut blocked=HashSet::<String>::new();
    let original_options=initial.iter().flat_map(|p|items(p,"variants").iter()
        .map(move|v|format!("{}|{}",field(p,"id"),field(v,"id"))))
        .collect::<HashSet<_>>();
    let (mut new_p,mut new_v,mut updated_p,mut updated_v)=(0,0,0,0);

    for (index,entry) in sources.iter().enumerate(){
        let cells=raw(entry);
        if !cells.iter().any(|c|!c.is_empty()){continue}
        let id=cell(&cells,0);let key=cell(&cells,1);
        let locator=if id.is_empty(){format!("new:{key}")}else{id.into()};
        let outcome=(||->Result<Value,String>{
            if id.is_empty()==key.is_empty(){
                return Err("기존 상품 ID 또는 신규등록키 중 하나만 입력하세요.".into())
            }
            if !seen_products.insert(locator.clone()){
                return Err("상품 ID 또는 신규등록키가 중복되었습니다.".into())
            }
            let old=if id.is_empty(){None}else{initial.iter().find(|p|field(p,"id")==id)};
            if !id.is_empty()&&old.is_none(){
                return Err("존재하지 않는 상품 ID입니다. 기존 ID를 수정하지 마세요.".into())
            }
            if !key.is_empty() &&
                (key.chars().count()>60 || key.is_empty() ||
                 !key.chars().all(|c|c.is_ascii_alphanumeric()||c=='_'||c=='-'||
                    ('가'..='힣').contains(&c))){
                return Err("신규등록키에는 공백 없이 문자, 숫자, 밑줄, 하이픈만 입력하세요.".into())
            }
            let candidate=if let Some(old)=old{update_product(state,old,&cells)?}
                else{
                    let generated_id=generated.get(index).and_then(Value::as_str)
                        .filter(|v|!v.is_empty()).ok_or("신규 상품 ID가 없습니다.")?;
                    new_product(state,&cells,generated_id,now)?
                };
            if let Some(position)=next.iter().position(|p|field(p,"id")==field(&candidate,"id")){
                next[position]=candidate.clone();
            }else{next.push(candidate.clone())}
            if !key.is_empty(){keys.insert(key.into(),field(&candidate,"id").into());}
            let changed=old.is_none_or(|previous|product_row(previous)!=product_row(&candidate));
            let status=if old.is_none(){"ADD"}else if changed{"UPDATE"}else{"UNCHANGED"};
            if status=="ADD"{new_p+=1}else if status=="UPDATE"{updated_p+=1}
            Ok(row_record("상품 목록",entry,field(&candidate,"id"),field(&candidate,"name"),
                status,if old.is_none(){vec!["신규 상품 등록".into()]}
                    else if changed{vec!["상품 정보 수정".into()]}else{vec![]},vec![]))
        })();
        match outcome{
            Ok(row)=>rows.push(row),
            Err(message)=>{
                blocked.insert(locator.clone());
                rows.push(row_record("상품 목록",entry,&locator,cell(&cells,2),
                    "ERROR",vec![],vec![message]));
            }
        }
    }
    for (index,entry) in option_sources.iter().enumerate(){
        let cells=raw(entry);
        if !cells.iter().any(|c|!c.is_empty()){continue}
        let id=cell(&cells,0);let key=cell(&cells,1);
        let option_id=cell(&cells,2);
        let locator=if id.is_empty(){format!("new:{key}")}else{id.into()};
        let attempt=(||->Result<Value,String>{
            if id.is_empty()==key.is_empty()||blocked.contains(&locator){
                return Err("옵션의 상품 ID 또는 신규등록키가 잘못되었습니다.".into())
            }
            let product_id=if id.is_empty(){keys.get(key).map(String::as_str)}
                else{Some(id)}.ok_or("옵션이 연결될 상품 행을 찾지 못했습니다.")?;
            let index=next.iter().position(|p|field(p,"id")==product_id)
                .ok_or("상품 ID가 존재하지 않습니다.")?;
            let product=&mut next[index];
            if archived(product){
                let archived_option=initial.iter().find(|p|field(p,"id")==product_id)
                    .and_then(|p|items(p,"variants").iter().find(|v|field(v,"id")==option_id));
                if archived_option.is_none_or(|v|variant_row(product,v)!=cells){
                    return Err("보관된 상품과 옵션은 Excel에서 수정할 수 없습니다.".into())
                }
                let candidate=archived_option.unwrap();
                seen_options.insert(format!("{}|{}",product_id,option_id));
                return Ok(row_record("상품별 가격",entry,
                    &format!("{}|{}",product_id,option_id),
                    &format!("{} / {}",field(product,"name"),field(candidate,"color")),
                    "UNCHANGED",vec![],vec![]))
            }
            let key_id=format!("{}|{}",product_id,
                if option_id.is_empty(){format!("new:{}|{}",
                    normalized_color(cell(&cells,3)),cell(&cells,4))}
                else{option_id.into()});
            if !seen_options.insert(key_id){
                return Err("옵션 행이 중복되었습니다.".into())
            }
            let old=if option_id.is_empty(){None}else{
                initial.iter().find(|p|field(p,"id")==product_id)
                    .and_then(|p|items(p,"variants").iter().find(|v|field(v,"id")==option_id))
            };
            if !option_id.is_empty()&&old.is_none(){
                return Err("옵션 ID가 존재하지 않습니다. 기존 옵션 ID를 변경하지 마세요.".into())
            }
            if !key.is_empty()&&!option_id.is_empty(){
                return Err("새 상품은 옵션 ID를 비워야 합니다.".into())
            }
            if old.is_none()&&!items(product,"variants").is_empty(){
                return Err("기존 상품에 두 번째 가격 구성은 추가할 수 없습니다. 별도 상품을 등록하세요.".into())
            }
            let candidate=if let Some(old)=old{edit_variant(old,&cells,product,now)?}
                else{new_variant(&cells,
                    option_ids.get(index).and_then(Value::as_str)
                    .filter(|s|!s.is_empty()).ok_or("신규 가격 기록 ID가 없습니다.")?)?};
            let price_index=items(product,"variants").iter().position(|v|
                field(v,"id")==field(&candidate,"id"));
            if let Some(i)=price_index{
                product["variants"][i]=candidate.clone();
            }else{
                product["variants"].as_array_mut().ok_or("가격 기록 목록 누락")?
                    .push(candidate.clone());
            }
            let changed=old.is_none_or(|v|v!=&candidate);
            if changed{product["updatedAt"]=json!(now)}
            if old.is_none(){new_v+=1}else if changed{updated_v+=1}
            Ok(row_record("상품별 가격",entry,
                &format!("{}|{}",product_id,field(&candidate,"id")),
                &format!("{} / {}",field(product,"name"),field(&candidate,"color")),
                if old.is_none(){"ADD"}else if changed{"UPDATE"}else{"UNCHANGED"},
                if old.is_none(){vec!["신규 옵션 등록".into()]}
                    else if changed{vec!["옵션 또는 가격 수정".into()]}else{vec![]},
                vec![]))
        })();
        match attempt{
            Ok(row)=>rows.push(row),
            Err(msg)=>rows.push(row_record("상품별 가격",entry,
                &format!("{}|{}",locator,option_id),cell(&cells,3),"ERROR",vec![],vec![msg]))
        }
    }
    for p in &mut next{
        let original=initial.iter().find(|old|field(old,"id")==field(p,"id"));
        if original.is_some_and(|old|old==p){continue}
        let result=(||->Result<(),String>{
            let variants=items(p,"variants");
            if variants.len()!=1{
                return Err("독립 상품에는 가격 기록이 정확히 하나 있어야 합니다.".into())
            }
            let names=variants.iter().map(|v|format!("{}|{}",
                normalized_color(field(v,"color")),field(v,"option").trim().to_lowercase()))
                .collect::<HashSet<_>>();
            if names.len()!=variants.len(){
                return Err("색상과 옵션명 조합이 중복되었습니다.".into())
            }
            if !variants.iter().any(|v|
                normalized_color(field(v,"color"))==normalized_color(field(p,"defaultColor"))){
                return Err("기본 색상에 해당하는 판매 옵션이 없습니다.".into())
            }
            if variants.iter().any(|v|field(v,"color").is_empty()||
                ["wholesale","semi","retail"].iter().any(|key|
                    v.get(*key).is_none_or(|n|!(n.is_null()||
                        n.as_u64().is_some_and(|n|n<=9_007_199_254_740_991))))){
                return Err("옵션 색상 또는 가격을 확인하세요.".into())
            }
            if original.is_none(){
                let duplicates=next.iter().filter(|other|
                    field(other,"id")!=field(p,"id")&&!archived(other)
                    &&identity(other)==identity(p)&&field(other,"name").trim()==field(p,"name").trim())
                    .collect::<Vec<_>>();
                if !duplicates.is_empty(){
                    return Err("같은 상품명으로 등록된 기존 상품이 있습니다.".into())
                }
                let mut validation=state.clone();
                validation["products"]=json!(initial.iter().filter(|old|
                    old.get("active")!=Some(&Value::Bool(false))&&!archived(old))
                    .collect::<Vec<_>>());
                validate_product(&validation,p)?;
            }
            p["saleUnit"]=json!(true);
            p["updatedAt"]=json!(now);
            Ok(())
        })();
        if let Err(message)=result{
            let id=field(p,"id");
            let row=sources.iter().find(|entry|{
                let cells=raw(entry);
                cell(&cells,0)==id||(!cell(&cells,1).is_empty()&&
                    keys.get(cell(&cells,1)).is_some_and(|found|found==id))
            }).and_then(|entry|entry.get("row")).cloned().unwrap_or(json!(0));
            let status=if ["같은 상품명","동일 모델코드","같은 상품코드","중복 상품"]
                .iter().any(|token|message.contains(token)){"HOLD"}else{"ERROR"};
            rows.push(json!({"sheet":"상품 목록","row":row,"id":id,
                "name":field(p,"name"),"status":status,
                "changes":[],"errors":[message]}));
        }
    }
    let missing_p=initial.iter().filter(|p|!seen_products.contains(field(p,"id"))).count();
    let missing_v=original_options.iter().filter(|id|!seen_options.contains(*id)).count();
    let unified=payload.get("unified")==Some(&Value::Bool(true));
    let rows=if unified{consolidate(&rows)}else{rows};
    if unified{
        new_p=rows.iter().filter(|r|field(r,"status")=="ADD").count();
        updated_p=rows.iter().filter(|r|field(r,"status")=="UPDATE").count();
    }
    Ok(json!({
        "revision":revision,"products":next,"rows":rows,
        "missingProducts":missing_p,"missingOptions":missing_v,
        "createdProducts":new_p,"updatedProducts":updated_p,
        "createdOptions":new_v,"updatedOptions":updated_v
    }))
}
