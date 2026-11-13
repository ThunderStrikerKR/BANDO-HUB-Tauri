//! Pure catalog, client and recommendation reads. These are not "just UI":
//! their candidate/ordering decisions are authoritative Rust business rules.
//! Original TS oracles: domain.ts, product-search.ts, product-registry.ts,
//! model-groups.ts and official-links.ts.
use serde_json::{json,Value};
use std::collections::{HashMap,HashSet};
use std::cmp::Ordering;
use regex::Regex;
use url::Url;
use super::{field,items};

fn active(p:&Value)->bool{
    p.get("active")!=Some(&Value::Bool(false)) &&
    field(p,"deletedAt").is_empty() && field(p,"supersededBy").is_empty()
}
fn no_whitespace(text:&str)->String {
    text.chars().filter(|c|!c.is_whitespace()).flat_map(char::to_lowercase).collect()
}
fn search_key(text:&str)->String {no_whitespace(text)}
fn ids<'a>(list:impl Iterator<Item=&'a Value>)->Value{
    json!(list.map(|p|field(p,"id").to_owned()).collect::<Vec<_>>())
}
fn client_search(state:&Value,payload:&Value)->Value{
    let clients=items(state,"clients");
    let query=no_whitespace(field(payload,"query"));
    let raw=field(payload,"raw");
    let matches=clients.iter().filter(|c|{
        field(c,"deletedAt").is_empty() && !query.is_empty() &&
        ["name","displayName","phone","mobile","address","shortNames","identifiers"]
            .iter().any(|key|no_whitespace(field(c,key)).contains(&query))
    });
    let suggested=clients.iter().filter(|c|{
        field(c,"deletedAt").is_empty()&&["name","displayName"].iter().any(|key|{
            let term=field(c,key).trim();
            term.encode_utf16().count()>=2 && raw.contains(term)
        })
    });
    json!({"ids":ids(matches),"suggestedIds":ids(suggested)})
}
fn cats_with_roots(state:&Value)->Vec<Value>{
    let mut cats=items(state,"categories").to_vec();
    for (id,name) in [("catalog-root:BANDOSTAND","반도스탠드"),
                      ("catalog-root:BANDOMALL","반도몰")]{
        if !cats.iter().any(|c|field(c,"id")==id){
            cats.push(json!({"id":id,"name":name,"parentId":null}))
        }
    }
    cats
}
fn parent_id(c:&Value)->&str{field(c,"parentId")}
fn category_path<'a>(cats:&'a[Value],id:&str)->Vec<&'a Value>{
    let mut path=Vec::new();
    let mut seen=HashSet::new();
    let mut cur=id;
    while !cur.is_empty()&&seen.insert(cur.to_owned()){
        let Some(c)=cats.iter().find(|c|field(c,"id")==cur)else{break};
        path.insert(0,c);
        cur=parent_id(c);
    }
    path
}
fn descendants(cats:&[Value],id:&str)->HashSet<String>{
    cats.iter().filter(|c|category_path(cats,field(c,"id"))
        .iter().any(|ancestor|field(ancestor,"id")==id))
        .map(|c|field(c,"id").to_owned()).collect()
}
fn category_ids(state:&Value,major:&str,minor:&str)->HashSet<String>{
    let cats=cats_with_roots(state);
    let selected=cats.iter().filter(|c|if !minor.is_empty(){
        field(c,"id")==minor
    }else{field(c,"id")==major||(!major.is_empty()&&parent_id(c)==major)}).collect::<Vec<_>>();
    let mut ids=descendants(&cats,if minor.is_empty(){major}else{minor});
    for c in &selected{ids.insert(field(c,"id").to_owned());}
    for c in selected{
        let parent=cats.iter().find(|p|field(p,"id")==parent_id(c));
        if field(c,"name")=="악세사리"{
            if let Some(parent)=parent{
                for reversed in cats.iter().filter(|x|field(x,"name")==field(parent,"name")&&
                    cats.iter().any(|p|field(p,"id")==parent_id(x)&&field(p,"name")=="스탠드 악세사리")){
                    ids.insert(field(reversed,"id").to_owned());
                }
            }
        }
        if let Some(parent)=parent {
            if field(parent,"name")=="스탠드 악세사리" {
                for reversed in cats.iter().filter(|x|field(x,"name")=="악세사리"&&
                    cats.iter().any(|p|field(p,"id")==parent_id(x)&&field(p,"name")==field(c,"name"))){
                    ids.insert(field(reversed,"id").to_owned());
                }
            }
        }
    }
    ids
}
fn classified<'a>(state:&'a Value,major:&str,minor:&str,brand:&str)->Vec<&'a Value>{
    let ids=category_ids(state,major,minor);
    items(state,"products").iter().filter(|p|{
        field(p,"deletedAt").is_empty()&&field(p,"supersededBy").is_empty()&&
        (brand.is_empty()||field(p,"brandId")==brand)&&
        (major.is_empty()||items(p,"categories").iter().any(|category|
            category.as_str().is_some_and(|c|ids.contains(c))))
    }).collect()
}
fn product_search<'a>(state:&'a Value,query:&str,client:&str,category:&str)
    ->Vec<&'a Value>{
    let terms=query.split_whitespace().filter(|t|!t.is_empty()).collect::<Vec<_>>();
    items(state,"products").iter().filter(|p|{
        active(p)&&
        (category.is_empty()||
            items(p,"categories").iter().any(|c|c.as_str()==Some(category))||
            field(p,"category")==category)&&
        terms.iter().all(|term|{
            let key=search_key(term);
            let brand=items(state,"brands").iter().find(|b|field(b,"id")==field(p,"brandId"));
            let brand_matches=brand.is_some_and(|b|{
                ["name","korean"].iter().any(|f|search_key(field(b,f)).contains(&key))||
                items(b,"aliases").iter().any(|v|v.as_str().is_some_and(|t|search_key(t).contains(&key)))
            });
            search_key(field(p,"name")).contains(&key)||
                search_key(field(p,"subtitle")).contains(&key)||brand_matches||
                items(state,"aliases").iter().any(|a|
                    field(a,"productId")==field(p,"id")&&
                    (a.get("clientId").is_some_and(Value::is_null)||
                     (!client.is_empty()&&field(a,"clientId")==client))&&
                    search_key(field(a,"text")).contains(&key))
        })
    }).collect()
}
fn family_kind(text:&str)->Option<&'static str>{
    let key=no_whitespace(text);
    if key.contains("키보드스탠드")||key.contains("건반스탠드")||key.contains("키보드"){
        Some("키보드")
    }else if key.contains("마이크스탠드")||key.contains("마이크"){
        Some("마이크")
    }else if key.contains("보면대")||key.contains("악보대"){
        Some("보면대")
    }else{None}
}
fn expression_key(text:&str)->String{
    let re=Regex::new(r"(?i)\s*\d+\s*(?:개|대|세트|ea).*$").unwrap();
    let normalized=re.replace(text,"");
    normalized.trim().to_uppercase().chars()
        .filter(|c|!c.is_whitespace()).collect::<String>()
        .strip_prefix("BD").unwrap_or_else(||"")
        .to_owned()
}
// The JS modelKey drops only an initial BD; keep the original key when there
// is no prefix (not an empty identity).
fn model_expression(text:&str)->String{
    let re=Regex::new(r"(?i)\s*\d+\s*(?:개|대|세트|ea).*$").unwrap();
    let compact=re.replace(text,"").trim().to_uppercase().chars()
        .filter(|c|!c.is_whitespace()).collect::<String>();
    compact.strip_prefix("BD").unwrap_or(&compact).to_owned()
}
fn accessory(text:&str)->bool{
    ["부속","라이트","바퀴","조명","브라켓","홀더","보면대등","부품","판대","스마트폰"]
        .iter().any(|s|text.contains(s))
}
fn natural_cmp(a:&str,b:&str)->Ordering{
    // Korean JavaScript Intl.Collator's numeric option is preserved for
    // mixed name prefixes. Hangul UTF8 codepoint order is already syllabic.
    let number=Regex::new(r"\d+|\D+").unwrap();
    let left=number.find_iter(a).map(|v|v.as_str()).collect::<Vec<_>>();
    let right=number.find_iter(b).map(|v|v.as_str()).collect::<Vec<_>>();
    for (x,y) in left.iter().zip(&right){
        let numeric=x.chars().all(|c|c.is_ascii_digit())&&y.chars().all(|c|c.is_ascii_digit());
        let cmp=if numeric{x.parse::<u128>().unwrap_or(0).cmp(&y.parse::<u128>().unwrap_or(0))}
            else{x.cmp(y)};
        if cmp!=Ordering::Equal{return cmp}
    }
    left.len().cmp(&right.len())
}
fn representative_products(state:&Value,raw:&str,client:&str)->Vec<String>{
    let Some(family)=family_kind(raw)else{return vec![]};
    let candidates=items(state,"products").iter()
        .filter(|p|active(p)&&search_key(&format!("{} {} {}",field(p,"category"),
            field(p,"name"),field(p,"subtitle"))).contains(family))
        .collect::<Vec<_>>();
    let non_demo=candidates.iter().any(|p|
        !items(p,"variants").iter().any(|v|field(v,"source")=="DEMO"));
    let mut pool=candidates.into_iter().filter(|p|
        !non_demo||!items(p,"variants").iter().any(|v|field(v,"source")=="DEMO"))
        .collect::<Vec<_>>();
    let mut history=HashMap::<String,u64>::new();
    let requested=model_expression(raw);
    for order in items(state,"orders"){
        if !field(order,"deletedAt").is_empty()||field(order,"confirmedAt").is_empty()||
            field(order,"clientId")!=client{continue}
        let mut seen=HashSet::new();
        for recipient in items(order.get("confirmationSnapshot").unwrap_or(&Value::Null),"recipients"){
            for item in items(recipient,"items"){
                let evidence=item.get("selectionEvidence").unwrap_or(&Value::Null);
                if evidence.is_null()||model_expression(field(evidence,"expression"))!=requested||
                    field(evidence,"productId")!=field(item,"productId")||
                    field(evidence,"variantId")!=field(item,"variantId"){continue}
                let identity=format!("{}|{}",field(evidence,"productId"),field(evidence,"variantId"));
                if seen.insert(identity){
                    *history.entry(field(evidence,"productId").to_owned()).or_default()+=1;
                }
            }
        }
    }
    let mut sold=HashMap::<String,u64>::new();
    for order in items(state,"orders"){
        if !field(order,"deletedAt").is_empty()||
            (!client.is_empty()&&field(order,"clientId")!=client){continue}
        let transferred=items(state.get("workflow").unwrap_or(&Value::Null),"shipments")
            .iter().any(|shipment|field(shipment,"orderId")==field(order,"id")&&
                (shipment.get("step").and_then(Value::as_i64).unwrap_or(0)>=1||
                 shipment.get("transferred")==Some(&Value::Bool(true))));
        if !transferred{continue}
        for recipient in items(order,"recipients"){
            for item in items(recipient,"items"){
                *sold.entry(field(item,"productId").to_owned()).or_default()+=
                    item.get("quantity").and_then(Value::as_u64).unwrap_or(0);
            }
        }
    }
    pool.sort_by(|a,b|{
        let text_a=format!("{} {} {}",field(a,"category"),field(a,"name"),field(a,"subtitle"));
        let text_b=format!("{} {} {}",field(b,"category"),field(b,"name"),field(b,"subtitle"));
        accessory(&text_a).cmp(&accessory(&text_b))
            .then_with(||history.get(field(b,"id")).unwrap_or(&0).cmp(
                history.get(field(a,"id")).unwrap_or(&0)))
            .then_with(||sold.get(field(b,"id")).unwrap_or(&0).cmp(
                sold.get(field(a,"id")).unwrap_or(&0)))
            .then_with(||(b.get("isDefaultSale")==Some(&Value::Bool(true))).cmp(
                &(a.get("isDefaultSale")==Some(&Value::Bool(true)))))
            .then_with(||natural_cmp(field(a,"name"),field(b,"name")))
    });
    pool.iter().take(3).map(|p|field(p,"id").to_owned()).collect()
}
fn suggest_group(state:&Value, candidate_ids:&[Value])->Value{
    let mut unique=Vec::<String>::new();
    for id in candidate_ids.iter().filter_map(Value::as_str){
        if !unique.iter().any(|x|x==id){unique.push(id.to_owned())}
    }
    if unique.len()<2{return Value::Null}
    if unique.iter().any(|id|!items(state,"products").iter().any(|p|active(p)&&field(p,"id")==id)){
        return Value::Null
    }
    let Some(groups)=state.get("settings").and_then(|s|s.get("colorGuidanceGroups"))
        .and_then(Value::as_object)else{return Value::Null};
    let matching=groups.iter().filter(|(_,group)|{
        let members=items(group,"productIds");
        let rep=field(group,"representativeProductId");
        !rep.is_empty() && unique.iter().all(|id|members.iter().any(|m|m.as_str()==Some(id)))&&
            unique.iter().any(|id|id==rep)
    }).collect::<Vec<_>>();
    if matching.len()!=1{return Value::Null}
    let (group_id,group)=matching[0];
    let members=items(group,"productIds");
    let rep=field(group,"representativeProductId");
    if members.len()<2 || members.iter().filter_map(Value::as_str).collect::<HashSet<_>>().len()!=members.len() ||
        !members.iter().any(|m|m.as_str()==Some(rep)) {return Value::Null}
    for id in members.iter().filter_map(Value::as_str){
        let Some(p)=items(state,"products").iter().find(|p|active(p)&&field(p,"id")==id &&
            field(p,"catalog")!="DEMO"&&items(p,"variants").len()==1&&
            items(p,"variants").iter().all(|v|field(v,"source")!="DEMO"))else{return Value::Null};
        let _=p;
    }
    let Some(product)=items(state,"products").iter().find(|p|field(p,"id")==rep)else{return Value::Null};
    json!({"groupId":group_id,"productId":rep,"productName":field(product,"name")})
}
fn valid_official(link:&str)->Option<(String,String)>{
    let url=Url::parse(link).ok()?;
    let host=url.host_str()?;
    if url.scheme()!="https"||!["bandostand.com","www.bandostand.com",
        "bandomall.co.kr","www.bandomall.co.kr"].contains(&host)||
        !url.username().is_empty()||url.password().is_some()||url.port().is_some(){
        return None
    }
    let segments=url.path_segments()?.filter(|s|!s.is_empty()).collect::<Vec<_>>();
    let number=if url.path()=="/product/detail.html"{
        let ids=url.query_pairs().filter(|(k,_)|k=="product_no")
            .map(|(_,v)|v.into_owned()).collect::<Vec<_>>();
        if ids.len()!=1{return None}
        ids[0].clone()
    }else{
        if segments.len()<3||segments[0]!="product"||segments[1]=="detail.html"{return None}
        segments[2].to_owned()
    };
    if number.is_empty()||!number.chars().all(|c|c.is_ascii_digit()){return None}
    Some((host.trim_start_matches("www.").to_owned(),number))
}
fn official_links(report:&Value)->Value{
    let mut seen=HashSet::new();
    let mut links=Vec::<Value>::new();
    for p in items(report,"products"){
        let id=field(p,"siteId");
        let name=field(p,"name").trim();
        if id.is_empty()||name.is_empty(){continue}
        let first=items(p,"variants").iter().filter_map(|v|{
            let link=field(v,"url").trim();
            valid_official(link).map(|(host,number)|(link.to_owned(),host,number))
        }).next();
        let Some((link,host,number))=first else{continue};
        if number!=id{continue}
        if !seen.insert(format!("{host}|{number}")){continue}
        links.push(json!({"name":name,"url":link}));
    }
    links.sort_by(|a,b|natural_cmp(field(a,"name"),field(b,"name")));
    json!(links)
}
pub(super) fn execute(operation:&str,payload:&Value)->Result<Value,String>{
    let state=payload.get("state").unwrap_or(&Value::Null);
    let result=match operation{
        "client_candidates"=>client_search(state,payload),
        "classified_products"=>ids(classified(state,field(payload,"category"),
            field(payload,"minor"),field(payload,"brand")).into_iter()),
        "category_ids"=>json!(category_ids(state,field(payload,"category"),
            field(payload,"minor")).into_iter().collect::<Vec<_>>()),
        "search_products"=>{
            let major=field(payload,"major");
            let brand=field(payload,"brand");
            let permitted=if major.is_empty()&&brand.is_empty(){None}
                else{Some(classified(state,major,"",brand).into_iter()
                    .map(|p|field(p,"id").to_owned()).collect::<HashSet<_>>())};
            let candidates=product_search(state,field(payload,"query"),
                field(payload,"clientId"),field(payload,"category"));
            ids(candidates.into_iter().filter(|p|
                permitted.as_ref().is_none_or(|set|set.contains(field(p,"id"))) &&
                (payload.get("excludeDemo")!=Some(&Value::Bool(true)) ||
                 (field(p,"catalog")!="DEMO"&&
                  !items(p,"variants").iter().any(|v|field(v,"source")=="DEMO")))))
        }
        "representative_products"=>json!(representative_products(state,
            field(payload,"text"),field(payload,"clientId"))),
        "suggest_group_representative"=>suggest_group(state,items(payload,"candidateIds")),
        "official_links"=>official_links(payload.get("report").unwrap_or(&Value::Null)),
        _=>return Err(format!("지원하지 않는 조회 업무입니다: {operation}")),
    };
    Ok(result)
}
#[cfg(test)]
mod tests{
    use super::*;
    #[test]
    fn customers_are_filtered_without_touching_historical_orders(){
        let state=json!({"clients":[{"id":"a","name":"반도 악기","address":"서울"},
            {"id":"b","name":"다른 곳","deletedAt":"2025-01-01"}]});
        let result=client_search(&state,&json!({"query":"반도","raw":"반도 악기 주문"}));
        assert_eq!(result["ids"],json!(["a"]));
        assert_eq!(result["suggestedIds"],json!(["a"]));
    }
}
