//! Native official product page HTML analysis (original TS oracle:
//! src/official-product-import.ts::parseOfficialProductPage).
//! HTML is treated as untrusted input; scripts are never executed.
//! UI supplies UUID and timestamp because they are nondeterministic identity
//! inputs, not business decisions. No product is written until staff approval.
use serde_json::{json,Value};
use scraper::{Html,Selector,ElementRef};
use regex::Regex;
use url::Url;
use unicode_normalization::UnicodeNormalization;
use std::collections::{HashMap,HashSet};
use super::{field,items,normalized_color};

fn rx(pattern:&str)->Regex{Regex::new(pattern).expect("static regex")}
fn clean(text:&str)->String{text.split_whitespace().collect::<Vec<_>>().join(" ")}
fn first_text(doc:&Html,selector:&str)->String{
    let selector=Selector::parse(selector).expect("static CSS selector");
    doc.select(&selector).next().map(|node|clean(&node.text().collect::<String>()))
        .unwrap_or_default()
}
fn descendants_text(element:ElementRef<'_>,selector:&str)->String{
    let selector=Selector::parse(selector).expect("static CSS selector");
    element.select(&selector).next().map(|n|clean(&n.text().collect::<String>()))
        .unwrap_or_default()
}
fn attr(doc:&Html,selector:&str,key:&str)->String{
    let selector=Selector::parse(selector).expect("static CSS selector");
    clean(doc.select(&selector).next().and_then(|n|n.value().attr(key)).unwrap_or(""))
}
fn fields(doc:&Html)->HashMap<String,String>{
    let mut out=HashMap::new();
    for (selector,heading,detail) in [("tr","th","td"),("dl","dt","dd")]{
        let selection=Selector::parse(selector).unwrap();
        for item in doc.select(&selection){
            let title=descendants_text(item,heading)
                .replace([' ',':','：'],"");
            let value=descendants_text(item,detail);
            if !title.is_empty()&&!value.is_empty(){
                out.entry(title).or_insert(value);
            }
        }
    }
    out
}
fn select_group(select:ElementRef<'_>)->String{
    let tr=select.ancestors().filter_map(ElementRef::wrap)
        .find(|ancestor|ancestor.value().name()=="tr");
    let heading=tr.map(|node|descendants_text(node,"th")).unwrap_or_default();
    if !heading.is_empty(){return heading}
    let label=clean(select.value().attr("aria-label").unwrap_or(""));
    if !label.is_empty(){label}else{"선택 옵션".to_owned()}
}
fn ancestor_label(control:ElementRef<'_>)->String{
    control.ancestors().filter_map(ElementRef::wrap)
        .find(|ancestor|ancestor.value().name()=="label")
        .map(|label|clean(&label.text().collect::<String>()))
        .unwrap_or_default()
}
fn trim_chars(s:&str,max:usize)->String{s.chars().take(max).collect()}
fn option_evidence(doc:&Html)->Vec<Value>{
    let mut result=vec![];
    let selects=Selector::parse(".xans-product-option select, select[id^=\"product_option_id\"]").unwrap();
    let options=Selector::parse("option").unwrap();
    for control in doc.select(&selects).take(20){
        let group=trim_chars(&select_group(control),80);
        let values=control.select(&options)
            .filter(|opt|{
                let raw=opt.value().attr("value").unwrap_or("").trim();
                !opt.value().attr("disabled").is_some() &&
                !raw.is_empty() && !["*","**","0"].contains(&raw)
            }).take(50).map(|opt|{
                let label=trim_chars(&clean(&opt.text().collect::<String>()),120);
                let token=trim_chars(opt.value().attr("value").unwrap_or("").trim(),100);
                json!({"label":label,"token":token})
            }).collect::<Vec<_>>();
        result.push(json!({"group":group,"kind":"SELECT","values":values}));
    }
    let controls=Selector::parse(".xans-product-option input[type=\"radio\"], .xans-product-option input[type=\"checkbox\"]").unwrap();
    for control in doc.select(&controls).take(80){
        let kind=if control.value().attr("type")==Some("radio"){"RADIO"}else{"CHECKBOX"};
        let group=clean(control.value().attr("name").unwrap_or(""));
        let group=if group.is_empty(){"선택 옵션".to_owned()}else{group};
        let position=result.iter().position(|entry|
            field(entry,"group")==group && field(entry,"kind")==kind);
        let i=if let Some(pos)=position{pos}else{
            result.push(json!({"group":group,"kind":kind,"values":[]}));
            result.len()-1
        };
        if control.value().attr("disabled").is_none() &&
            items(&result[i],"values").len()<50 {
            let label=ancestor_label(control);
            let label=if label.is_empty(){
                clean(control.value().attr("aria-label").unwrap_or(""))
            }else{label};
            let label=if label.is_empty(){
                clean(control.value().attr("value").unwrap_or(""))
            }else{label};
            let token=trim_chars(control.value().attr("value").unwrap_or(""),100);
            result[i]["values"].as_array_mut().unwrap()
                .push(json!({"label":label,"token":token}));
        }
    }
    let customs=Selector::parse(".xans-product-option [data-option-value]").unwrap();
    let found=doc.select(&customs).take(50).map(|node|{
        json!({"label":trim_chars(&clean(&node.text().collect::<String>()),120),
            "token":trim_chars(node.value().attr("data-option-value").unwrap_or(""),100)})
    }).collect::<Vec<_>>();
    if !found.is_empty(){
        result.push(json!({"group":"선택 옵션","kind":"CUSTOM","values":found}));
    }
    result
}
fn site_id(url:&Url)->Option<String>{
    if url.path()=="/product/detail.html"{
        let id=url.query_pairs().find(|(key,_)|key=="product_no")
            .map(|(_,id)|id.into_owned());
        if id.as_ref().is_some_and(|v|!v.is_empty()&&v.chars().all(|c|c.is_ascii_digit())){
            return id
        }
    }
    let path=url.path_segments()?.filter(|s|!s.is_empty()).collect::<Vec<_>>();
    if path.first().copied()!=Some("product"){return None}
    path.iter().skip(2).find(|id|!id.is_empty()&&id.chars().all(|c|c.is_ascii_digit()))
        .map(|id|(*id).to_owned())
}
fn valid_url(value:&str)->Option<Url>{
    let url=Url::parse(value).ok()?;
    if url.scheme()=="https"&&
        ["bandostand.com","www.bandostand.com","bandomall.co.kr","www.bandomall.co.kr"]
            .contains(&url.host_str().unwrap_or("")) &&
        url.path().starts_with("/product/"){Some(url)}else{None}
}
fn normalize_model(text:&str)->String{
    let trimmed=text.trim();
    let renamed=rx(r"(?i)^bd\s*").replace(trimmed,"BD ").into_owned();
    let numbered=rx(r"(?i)^BD (\d[A-Za-z0-9-]*)$");
    if let Some(cap)=numbered.captures(&renamed){
        format!("BD {}",cap[1].to_uppercase())
    }else{renamed}
}
fn explicit_model(raw:&str)->Option<String>{
    let text=clean(raw);
    if text.is_empty()||text.chars().count()>60||
        rx(r"(?i)^P[A-Z0-9]{6,}$").is_match(&text)||
        rx(r"(?i)^(?:미등록|모델명|N/A|없음|선택|선택하세요)$").is_match(&text)||
        text.chars().any(|c|"<> ,/;+".contains(c)&&c!=' ')||
        text.chars().any(|c|('가'..='힣').contains(&c)){
        return None
    }
    let bd=rx(r"(?i)^BD[\s-]*([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)$");
    Some(if let Some(caps)=bd.captures(&text){
        normalize_model(&format!("BD {}",&caps[1]))
    }else{normalize_model(&text)})
}
fn model_code(values:&HashMap<String,String>,title:&str)->(Option<String>,&'static str){
    if let Some(m)=explicit_model(values.get("모델명").map(String::as_str).unwrap_or("")){
        return (Some(m),"MODEL_FIELD")
    }
    if let Some(m)=explicit_model(values.get("자체상품코드").map(String::as_str).unwrap_or("")){
        return (Some(m),"CUSTOM_CODE")
    }
    let mut tokens=vec![];
    let direct=rx(r"(?i)\bBD[\s-]*([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)\b");
    for m in direct.captures_iter(title){
        if m[1].chars().any(|c|c.is_ascii_digit()){
            tokens.push(normalize_model(&format!("BD {}",&m[1])));
        }
    }
    if tokens.is_empty(){
        let embedded=rx(r"(?i)\b(?:[A-Z][A-Z0-9]{1,8}(?:-[A-Z0-9]{1,8}){1,3}|\d{3,4}[A-Z]{1,3})\b");
        for m in embedded.find_iter(title){
            if m.as_str().chars().any(|c|c.is_ascii_digit())&&
                !rx(r"(?i)^P[A-Z0-9]{6,}$").is_match(m.as_str()){
                tokens.push(normalize_model(m.as_str()))
            }
        }
    }
    let unique=tokens.iter().map(|v|v.to_uppercase().chars()
        .filter(|c|!c.is_whitespace()).collect::<String>()).collect::<HashSet<_>>();
    if unique.len()==1{(tokens.into_iter().next(),"TITLE")}else{(None,"UNRESOLVED")}
}
fn price(raw:&str)->Option<u64>{
    let text=clean(raw);
    if !rx(r"^(?:₩\s*)?\d+(?:,\d{3})*(?:\.00)?\s*(?:원)?$").is_match(&text){
        return None
    }
    let text=text.replace([',','₩','원',' '],"");
    let value=text.parse::<f64>().ok()?;
    if value>0.0&&value<=9007199254740991.0&&value.fract()==0.0{
        Some(value as u64)
    }else{None}
}
fn presentation(title:&str,code:Option<&str>)->(String,String){
    let title=rx(r"(?i)^(?:반도스탠드|bandostand)\s*")
        .replace(title,"").trim().to_owned();
    let Some(code)=code else{return (clean(&title),String::new())};
    let binary=rx(r"(가방|바퀴)\s*(미포함|포함|미장착|장착|없음|있음)");
    let mut flags=vec![];
    for m in binary.captures_iter(&title){
        let text=format!("{} {}",&m[1],
            if ["미포함","미장착","없음"].contains(&&m[2]){"미포함"}else{"포함"});
        if !flags.contains(&text){flags.push(text)}
    }
    let pattern=regex::escape(code).chars().map(|c|
        if c.is_whitespace(){r"\s*".to_owned()}else{c.to_string()}
    ).collect::<String>();
    let no_code=rx(&format!("(?i){pattern}")).replace(&title," ").to_string();
    let residual=binary.replace_all(&no_code," ");
    let residual=clean(&residual);
    let residual=residual.trim_matches(|c:char|
        c.is_whitespace()||",/[]()–—-".contains(c)).to_owned();
    let usage=rx(r"^(?:성악용|녹음용|국악용|탁상용|교육용|연주용|실내용|야외용|사용|추천|용도)|^[가-힣,\s]+용\s");
    let only_usage=usage.is_match(&residual);
    let base=if !residual.is_empty()&&!only_usage{
        clean(&format!("{code} {residual}"))
    }else{code.to_owned()};
    let name=std::iter::once(base).chain(flags).collect::<Vec<_>>().join(" / ");
    (name,if only_usage{residual}else{String::new()})
}
fn norm_registry(text:&str)->String{
    text.nfkc().collect::<String>().trim().chars()
        .flat_map(char::to_lowercase).collect::<String>()
        .split_whitespace().collect::<Vec<_>>().join(" ")
}
fn is_registered(p:&Value)->bool{
    p.get("active")!=Some(&Value::Bool(false)) &&
    field(p,"deletedAt").is_empty() && field(p,"supersededBy").is_empty()
}
pub(super) fn preview(payload:&Value)->Result<Value,String>{
    let state=payload.get("state").ok_or("현재 상품 목록이 없습니다.")?;
    let url_text=field(payload,"url");
    let url=valid_url(url_text).ok_or("공식 홈페이지의 HTTPS 상품 상세 URL을 입력하세요.")?;
    let id=site_id(&url).ok_or("상품번호가 없는 상세페이지는 분석할 수 없습니다.")?;
    let html=field(payload,"html");
    if html.len()>4*1024*1024{return Err("공식 HTML 크기가 너무 큽니다.".into())}
    let doc=Html::parse_document(html);
    let values=fields(&doc);
    let read=|name:&str|values.get(name).map(String::as_str).unwrap_or("");
    let name=clean(read("상품명"));
    let name=if name.is_empty(){first_text(&doc,".headingArea h2, .xans-product-detail h2")}else{name};
    let name=if name.is_empty(){attr(&doc,"meta[property=\"og:title\"]","content")}else{name};
    if name.is_empty(){return Err("공식 상세페이지에서 상품명을 확인하지 못했습니다.".into())}
    let (code,model_source)=model_code(&values,&name);
    let site_code=read("상품코드");
    let site_code=if site_code.is_empty(){read("자체상품코드")}else{site_code};
    let site_code=if rx(r"(?i)^P[A-Z0-9]{6,}$").is_match(site_code){
        Some(site_code)
    }else{None};
    let (present_name,subtitle)=presentation(&name,code.as_deref());
    let shown_price=read("판매가");
    let retail=if shown_price.is_empty(){
        price(&attr(&doc,"meta[property=\"product:price:amount\"]","content"))
            .or_else(||price(&first_text(&doc,"#span_product_price_text")))
    }else{price(shown_price)};
    let description=trim_chars(&first_text(&doc,"#prdDetail, .prdDetail"),6000);
    let english=rx(r"(?i)\b(Black|White|Gray|Grey|Silver|Brown|Blue|Red|Gold|Clear)\b");
    let korean=rx(r"(블랙|검정|화이트|그레이|회색|실버|브라운|블루|레드|골드|클리어)");
    let color_desc=rx(r"(?i)\bColor\s*:\s*(Black|White|Gray|Grey|Silver|Brown|Blue|Red|Gold|Clear)\b");
    let detected=if !read("색상").is_empty(){read("색상").to_owned()}
        else if let Some(m)=english.captures(&name){m[1].to_owned()}
        else if let Some(m)=korean.captures(&name){m[1].to_owned()}
        else if let Some(m)=color_desc.captures(&description){m[1].to_owned()}
        else{String::new()};
    let color=normalized_color(if detected.is_empty(){"단일"}else{&detected});
    let catalog=if url.host_str().unwrap_or("").ends_with("bandomall.co.kr"){
        "BANDOMALL"
    }else{"BANDOSTAND"};
    let evidence=option_evidence(&doc);
    let selectable=!evidence.is_empty();
    let unclear=rx(r"(?i)(?:색상|컬러|사이즈|규격|옵션|바퀴|가방)\s*(?:선택|옵션)")
        .is_match(&name) || read("모델명").contains([',','/',';','+']) ||
        rx(r"(?i)\bBD\s*\d{3,4}[A-Z0-9-]*\s*(?:/|,|\+)\s*(?:BD\s*)?\d{3,4}[A-Z0-9-]*")
            .is_match(&name)||
        rx(r"(?i)\bBD\s*\d{3,4}[A-Z0-9-]*\s+\d{3,4}[A-Z][A-Z0-9-]*")
            .is_match(&name);
    let matches=items(state,"products").iter().filter(|p|is_registered(p)&&
        (if field(p,"catalog").is_empty(){"BANDOSTAND"}else{field(p,"catalog")})==catalog &&
        (field(p,"siteId")==id ||
         items(p,"siteRefs").iter().any(|x|x.as_str()==Some(&id)) ||
         items(p,"variants").iter().any(|v|field(v,"siteProductId")==id)))
        .collect::<Vec<_>>();
    let same_name=items(state,"products").iter().any(|p|is_registered(p)&&
        (if field(p,"catalog").is_empty(){"BANDOSTAND"}else{field(p,"catalog")})==catalog &&
        norm_registry(field(p,"name"))==norm_registry(&present_name));
    let deleted=items(state,"products").iter().any(|p|
        !field(p,"deletedAt").is_empty() &&
        (field(p,"siteId")==id ||
         ((if field(p,"catalog").is_empty(){"BANDOSTAND"}else{field(p,"catalog")})==catalog &&
          norm_registry(field(p,"name"))==norm_registry(&present_name))));
    let mut reasons=vec![];
    if retail.is_none(){reasons.push("판매가를 확인하지 못했습니다. 가격을 임의로 입력하지 않습니다.")}
    if selectable||unclear{
        reasons.push("상품 선택 옵션이 있습니다. 옵션별 모델, 포함 / 미포함 구성과 판매가를 직접 확인해야 합니다.")
    }
    if matches.len()>1{reasons.push("원본 상품번호에 여러 상품이 연결되어 있어 자동 반영할 수 없습니다.")}
    if matches.len()==1&&items(matches[0],"variants").len()!=1{
        reasons.push("기존 상품에 여러 옵션이 연결되어 있어 대상 옵션을 확정할 수 없습니다.")
    }
    if matches.is_empty()&&same_name{
        reasons.push("같은 상품명으로 등록된 상품이 있습니다. 기존 상품을 확인해야 합니다.")
    }
    if deleted{reasons.push("삭제된 상품과 일치할 수 있으므로 자동 복원하지 않습니다.")}
    let can_apply=reasons.is_empty();
    if reasons.is_empty(){reasons.push("공식 페이지의 표시 판매가입니다. 승인 전에 상품명과 모델을 확인하세요.")}
    let now=field(payload,"now");
    let product_id=field(payload,"productId");
    let variant_id=field(payload,"variantId");
    if now.is_empty()||product_id.is_empty()||variant_id.is_empty(){
        return Err("공식 분석 ID 및 시각이 누락됐습니다.".into())
    }
    let mut product=json!({
        "id":product_id,"code":product_id,"name":present_name,"subtitle":subtitle,
        "originalName":name,"catalog":catalog,
        "origin":if catalog=="BANDOSTAND"{"FACTORY"}else{"STORE"},
        "category":"","categories":[],"active":true,"siteId":id,"siteRefs":[id],
        "defaultColor":color,
        "colorStatus":if color=="단일"{"NOT_REQUIRED"}else{"KNOWN"},
        "saleUnit":!selectable&&!unclear,"requiresOption":selectable||unclear,
        "createdAt":now,"updatedAt":now,
        "variants":[{
            "id":variant_id,"color":color,"option":"","wholesale":null,
            "semi":null,"retail":retail,"officialRetail":retail,
            "url":url.to_string(),"source":"OFFICIAL","siteProductId":id,
            "collectedAt":now
        }]
    });
    if let Some(site_code)=site_code{product["siteCode"]=json!(site_code)}
    let existing=if matches.len()==1{json!(field(matches[0],"id"))}else{Value::Null};
    Ok(json!({
        "product":product,"related":[],"sourceUrl":url.to_string(),
        "existingId":existing,"warnings":reasons,"optionEvidence":evidence,
        "modelSource":model_source,"canApply":can_apply,
        "revision":state.get("revision").cloned().unwrap_or(json!(0))
    }))
}
