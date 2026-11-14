//! Exact order issue decision projection based on src/validation.ts.
//! Do not use this as the only group approval gate until workflowIssues and
//! stageIssues have their own original-TypeScript differential coverage.
use std::collections::HashSet;
use serde_json::{json,Map,Value};
use super::{field,req,required_str,rows,set,str_field};

fn evidence_value(value:&Value)->String {
    match value {
        Value::Array(xs)=>format!("[{}]",xs.iter().map(evidence_value)
            .collect::<Vec<_>>().join(",")),
        Value::Object(map)=>{
            // The original TS match objects place their discriminant
            // before other fields. serde_json's default BTreeMap sorts
            // keys, which changes JSON.stringify evidence and staff
            // decision fingerprints.
            let mut keys=map.keys().cloned().collect::<Vec<String>>();
            // Exact original parser.ts/item.match insertion order:
            // kind -> term -> productIds -> aliasId. This string is a
            // persisted employee-decision fingerprint, not cosmetic JSON.
            if map.contains_key("kind") && map.contains_key("term") {
                let expected=["kind","term","productIds","aliasId"];
                keys.retain(|key|!expected.contains(&key.as_str()));
                for key in expected.iter().rev(){
                    if map.contains_key(*key){keys.insert(0,(*key).to_owned());}
                }
            } else if map.contains_key("kind"){
                keys.retain(|key|key.as_str()!="kind");
                keys.insert(0,"kind".to_string());
            } else if map.len()==3 && ["field","value","label"].iter()
                .all(|key|map.contains_key(*key)) {
                // Original candidate objects received through the React
                // input may have value before label, unlike sorted maps.
                keys=vec!["field".into(),"value".into(),"label".into()];
            }
            format!("{{{}}}",keys.iter().map(|key|format!("{}:{}",
                json!(key),evidence_value(&map[key]))).collect::<Vec<_>>().join(","))
        },
        _=>serde_json::to_string(value).unwrap_or_else(|_|"null".to_string())
    }
}
fn js_evidence(value:Option<&Value>)->Option<String> {
    value.map(evidence_value)
}
fn issue_id(order:&Value,row:Option<&Value>,item:Option<&Value>,kind:&str)->String {
    format!("issue:{}:{}:{}:{kind}",str_field(order,"id"),
        row.map(|r|str_field(r,"id")).unwrap_or("order"),
        item.map(|i|str_field(i,"id")).unwrap_or("recipient"))
}
fn internal_model(name:&str)->String {
    let mut text=name;
    if let Some(rest)=text.strip_prefix("[가상]"){
        text=rest.trim_start_matches(char::is_whitespace);
    }
    if let Some(prefix)=text.get(..2){
        if prefix.eq_ignore_ascii_case("BD") {
            let suffix=&text[2..];
            if suffix.chars().next().is_some_and(|c|c.is_whitespace()||c.is_ascii_digit()) {
                return suffix.trim_start_matches(char::is_whitespace).to_string();
            }
        }
    }
    text.to_string()
}
fn valid_contact(value:&str)->bool {
    let digits:String=value.chars()
        .filter(|c|!c.is_whitespace()&&!['(',')','.','-'].contains(c)).collect();
    digits.chars().all(|c|c.is_ascii_digit()) &&
        ((digits.starts_with('0')&&(9..=11).contains(&digits.len())) ||
          (digits.starts_with("050")&&digits.len()==12)) &&
        (!digits.starts_with("010") || digits.len()==11)
}
fn valid_address(value:&str)->bool {
    let s=value.trim();
    if s.is_empty()||s.contains('#')||s.contains('@'){return false;}
    for marker in ["대로","로","길","사서함"]{
        if s.match_indices(marker).any(|(i,_)| s[i+marker.len()..].trim_start()
            .chars().next().is_some_and(|c|c.is_ascii_digit())) {return true;}
    }
    for (i,c) in s.char_indices() {
        if !['동','리','읍','면'].contains(&c){continue;}
        let suffix=&s[i+c.len_utf8()..];
        if !suffix.chars().next().is_some_and(char::is_whitespace){continue;}
        let mut suffix=suffix.trim_start_matches(char::is_whitespace);
        if let Some(after)=suffix.strip_prefix('산'){
            suffix=after.trim_start_matches(char::is_whitespace);
        }
        if suffix.chars().next().is_some_and(|c|c.is_ascii_digit()){return true;}
    }
    false
}
fn contact_problem(value:&str,mobile:bool)->String {
    let digits:String=value.chars()
        .filter(|c|!c.is_whitespace()&&!['(',')','.','-'].contains(c)).collect();
    if value.trim().is_empty(){
        return (if mobile {"휴대폰 번호가 없습니다."}else{"전화번호가 없습니다."}).to_string();
    }
    if digits.starts_with("010") && digits.len()!=11 {
        return format!("휴대폰 번호가 {}자리입니다. 010으로 시작하는 번호는 숫자 11자리가 필요합니다.",digits.len());
    }
    (if mobile{"휴대폰 번호의 형식과 자릿수를 확인해주세요."}
    else{"일반전화 번호의 지역번호와 자릿수를 확인해주세요."}).to_string()
}
fn unassigned_detail(row:&Value)->String {
    let candidates=rows(field(row,"unassignedEvidence"));
    let mut parts=Vec::new();
    for candidate in candidates.iter().take(4) {
        let source=str_field(candidate,"text");
        let source=if source.is_empty(){str_field(candidate,"value")} else{source};
        let normalized=source.split_whitespace().collect::<Vec<_>>().join(" ");
        let chars=normalized.chars().collect::<Vec<_>>();
        let short=if chars.len()>60 {
            format!("{}…",chars[..60].iter().collect::<String>())
        }else{normalized};
        parts.push(format!("{}: \"{}\"",if str_field(candidate,"kind")=="quantity"{"수량"}else{"상품"},short));
    }
    let more=if candidates.len()>4{format!(" 외 {}개",candidates.len()-4)}else{String::new()};
    format!("연결되지 않은 원문: {}{more}",if parts.is_empty(){"확인할 문구 없음".into()}else{parts.join(" / ")})
}
struct Info<'a>{
    row:Option<&'a Value>,
    item:Option<&'a Value>,
    kind:&'a str,
    title:String,
    evidence:Option<&'a Value>,
    field:&'a str,
    stage:i64,
    customer:Option<String>,
    resolution:Option<&'a str>,
}
fn emit(result:&mut Vec<Value>,order:&Value,info:Info<'_>){
    let Info{row,item,kind,title,evidence,field:field_name,stage,customer,resolution}=info;
    let id=issue_id(order,row,item,kind);
    let evidence=js_evidence(evidence);
    let decision=field(order,"issueResolutions").get(&id);
    let status=resolution.unwrap_or_else(||{
        if decision.is_some_and(|d|
             str_field(d,"evidence")==evidence.as_deref().unwrap_or("")
             && str_field(d,"resolution")=="PENDING_CUSTOMER") {
            "PENDING_CUSTOMER"
        }else{"UNRESOLVED"}
    });
    let detail=if kind=="UNASSIGNED_EVIDENCE" {
        row.map(unassigned_detail).unwrap_or_else(||title.clone())
    }else if let Some(row)=row {
        format!("{} / {}",if str_field(row,"name").is_empty(){"수취인"}else{str_field(row,"name")},
            item.map(|i|internal_model(str_field(i,"name"))).unwrap_or_else(||title.clone()))
    }else{title.clone()};
    let resolution_source=decision
        .and_then(|d|d.get("resolutionSource")).filter(|v|!v.is_null()).cloned()
        .unwrap_or_else(||json!(match status {
            "AUTO_APPLIED"=>"코어","PROVISIONALLY_APPROVED"=>item
                .map(|i|str_field(field(i,"quantityApproval"),"actor"))
                .filter(|v|!v.is_empty()).unwrap_or("직원"),_=>"미확인"
        }));
    let updated_at=decision.and_then(|d|d.get("updatedAt")).filter(|v|!v.is_null())
        .or_else(||item.and_then(|i|field(i,"quantityApproval").get("at"))
            .filter(|v|!v.is_null()))
        .unwrap_or_else(||field(order,"updatedAt")).clone();
    let mut issue=json!({
        "issueId":id,"orderId":field(order,"id"),
        "groupId":format!("group:{}",str_field(order,"id")),
        "recipientId":row.map(|r|str_field(r,"id")).unwrap_or(""),
        "kind":kind,"title":title,"detail":detail,
        "blockingStage":stage,
        "severity":if ["AUTO_APPLIED","PROVISIONALLY_APPROVED","RESOLVED"].contains(&status){"INFO"}else{"ACTION"},
        "resolution":status,"resolutionSource":resolution_source,"updatedAt":updated_at
    });
    if let Some(e)=evidence {let _=set(&mut issue,"evidence",json!(e));}
    if let Some(item)=item {let _=set(&mut issue,"itemId",field(item,"id").clone());}
    if let Some(row)=row{
        let key=item.map(|i|str_field(i,"id")).unwrap_or_else(||str_field(row,"id"));
        let _=set(&mut issue,"linkKey",json!(format!("{key}:{field_name}")));
    }
    let sources=item.and_then(|i|i.get("sources")).or_else(||row.and_then(|r|r.get("sources")));
    if let Some(span)=sources.and_then(|s|rows(s).iter().find(|v|str_field(v,"field")==field_name)){
        let _=set(&mut issue,"sourceSpan",span.clone());
    }
    if let Some(customer)=customer{let _=set(&mut issue,"customer",json!(customer));}
    result.push(issue);
}
fn add<'a>(result:&mut Vec<Value>,o:&Value,row:Option<&'a Value>,
   item:Option<&'a Value>,kind:&'a str,title:impl Into<String>,field:&'a str,
   evidence:Option<&'a Value>,stage:i64,customer:Option<String>,resolution:Option<&'a str>) {
    emit(result,o,Info{row,item,kind,title:title.into(),evidence,field,stage,customer,resolution});
}
pub(super) fn order_issues(o:&Value)->Vec<Value>{
    let mut issues=Vec::new();
    if str_field(o,"clientId").is_empty()&&str_field(o,"orderType")!="RETAIL"{
        add(&mut issues,o,None,None,"CLIENT","거래처를 선택하면 단가가 적용됩니다",
            "client",o.get("clientId"),1,None,None);
    }
    if rows(field(o,"recipients")).is_empty(){
        let zero=json!(0);
        add(&mut issues,o,None,None,"RECIPIENT","수취인과 상품을 추가하세요",
            "recipient",Some(&zero),1,None,None);
    }
    for row in rows(field(o,"recipients")){
        let who=format!("{}님",if str_field(row,"name").is_empty(){"수취인"}else{str_field(row,"name")});
        if !rows(field(row,"unassignedEvidence")).is_empty(){
            add(&mut issues,o,Some(row),None,"UNASSIGNED_EVIDENCE",
                "상품 또는 수량 정보가 연결되지 않았습니다","product",
                row.get("unassignedEvidence"),1,None,None);
        }
        if str_field(row,"name").trim().is_empty(){
            add(&mut issues,o,Some(row),None,"NAME","수취인 이름을 확인하세요","name",
                row.get("name"),1,Some("받으실 분의 성함을 알려주세요.".into()),None);
        }
        let address=str_field(row,"address");
        let legacy=field(o,"receptionVersion").as_i64()!=Some(1);
        let address_ok=!address.trim().is_empty() &&
          ((legacy&&str_field(row,"addressStatus")=="CONFIRMED")||
           (str_field(row,"addressStatus")!="INCOMPLETE"&&valid_address(address)));
        if !address_ok{
            let evidence=json!([field(row,"address"),field(row,"addressStatus")]);
            let customer=format!("{who} {}",if !address.trim().is_empty(){
                "상세주소 확인 부탁드려요."
            }else{"배송지 주소 확인 부탁드려요."});
            add(&mut issues,o,Some(row),None,"ADDRESS","상세 배송주소가 부족합니다",
                "address",Some(&evidence),1,Some(customer),None);
        }
        let phone=str_field(row,"phone");
        let mobile=str_field(row,"mobile");
        let contact_ok=valid_contact(phone)||valid_contact(mobile);
        if phone.is_empty()&&mobile.is_empty()||!contact_ok{
            let evidence=json!([field(row,"phone"),field(row,"mobile")]);
            let absent=phone.is_empty()&&mobile.is_empty();
            let invalid_mobile=!mobile.is_empty()&&!valid_contact(mobile);
            let (title,field_name)=if absent{("연락처가 없습니다".to_string(),"mobile")}
                else{(contact_problem(if invalid_mobile{mobile}else{phone},invalid_mobile),
                    if invalid_mobile{"mobile"}else{"phone"})};
            add(&mut issues,o,Some(row),None,"CONTACT",title,field_name,
                Some(&evidence),1,Some(format!("{who} 연락처 확인 부탁드려요.")),None);
        }
        for field_name in ["name","address","phone","mobile"]{
            let candidates=rows(field(row,"candidates")).iter()
                .filter(|v|str_field(v,"field")==field_name).cloned().collect::<Vec<_>>();
            let unique=candidates.iter()
                .map(|v|serde_json::to_string(field(v,"value")).unwrap_or_default())
                .collect::<HashSet<_>>();
            let confirmed=rows(field(row,"confirmedFields")).iter()
                .any(|v|v.as_str()==Some(field_name));
            if unique.len()>1&&!confirmed{
                let evidence=json!(candidates);
                let title=format!("{} 후보 선택 필요",match field_name {
                    "name"=>"수취인명","address"=>"주소",_=>"연락처"
                });
                let kind=format!("CANDIDATE_{field_name}");
                add(&mut issues,o,Some(row),None,&kind,title,field_name,
                    Some(&evidence),1,None,None);
            }
        }
        if rows(field(row,"items")).is_empty(){
            let empty=json!([]);
            add(&mut issues,o,Some(row),None,"ITEM","상품명 누락","product",Some(&empty),1,None,None);
        }
        for item in rows(field(row,"items")){
            let match_kind=str_field(field(item,"match"),"kind");
            let root=match match_kind{
                "QUANTITY"=>"QUANTITY_LINK","CONFLICT"=>"ALIAS_CONFLICT",
                "CATEGORY_CONFLICT"=>"CATEGORY_CONFLICT","CATEGORY"=>"MODEL_CHOICE",_=>"MODEL"
            };
            if str_field(item,"productId").is_empty()||str_field(item,"variantId").is_empty(){
                let title=match root{
                    "QUANTITY_LINK"=>"수량을 연결할 상품이 불명확합니다.",
                    "ALIAS_CONFLICT"=>"상품 연결 정보가 충돌합니다.",
                    "CATEGORY_CONFLICT"=>"상품 종류와 모델이 상충합니다.",
                    "MODEL_CHOICE"=>"모델 선택이 필요합니다.",
                    _=>"미등록 상품입니다."
                };
                let evidence=json!([field(item,"productId"),field(item,"variantId"),field(item,"match")]);
                add(&mut issues,o,Some(row),Some(item),root,title,"product",Some(&evidence),1,None,None);
            }
            if field(item,"quantityConfirmed").as_bool()==Some(false)&&root!="QUANTITY_LINK"{
                let evidence=json!([field(item,"quantity"),field(item,"quantityConfirmed")]);
                add(&mut issues,o,Some(row),Some(item),"QUANTITY_MISSING",
                    "상품에 귀속된 수량을 확정하세요.","quantity",Some(&evidence),1,None,None);
            }
            let qty=field(item,"quantity").as_i64();
            if field(item,"quantityConfirmed").as_bool()!=Some(false)&&
                qty.is_none_or(|n|!(-super::MAX_SAFE..=super::MAX_SAFE).contains(&n)||n<1){
                add(&mut issues,o,Some(row),Some(item),"QUANTITY_INVALID","수량을 확인하세요",
                    "quantity",item.get("quantity"),1,None,None);
            }
            let price=field(item,"unitPrice").as_i64();
            if str_field(o,"orderType")!="RETAIL"&&!str_field(o,"clientId").is_empty()&&
               !str_field(item,"productId").is_empty()&&!str_field(item,"variantId").is_empty()&&
                price.is_none_or(|n|!(0..=super::MAX_SAFE).contains(&n)){
                add(&mut issues,o,Some(row),Some(item),"PRICE","판매가를 등록하세요",
                    "price",item.get("unitPrice"),1,None,None);
            }
            if !str_field(item,"productId").is_empty()&&!str_field(item,"variantId").is_empty()&&
                rows(field(item,"issues")).iter().any(|v|v.as_str().is_some_and(|s|
                    s.contains("색상")||s.contains("옵션"))){
                let evidence=json!([field(item,"variantId"),field(item,"color"),field(item,"issues")]);
                add(&mut issues,o,Some(row),Some(item),"OPTION","정확한 상품 구성을 확인하세요",
                    "product",Some(&evidence),1,
                    Some(format!("{who} {} 정확한 상품명을 확인 부탁드려요.",
                        internal_model(str_field(item,"name")))),None);
            }
            if field(field(item,"modelProposal"),"required").as_bool()==Some(true){
                let evidence=json!([field(item,"productId"),field(item,"variantId"),field(item,"modelProposal")]);
                add(&mut issues,o,Some(row),Some(item),"MODEL_CONFIRM",
                    "추천 상품의 고객 확인이 필요합니다","product",Some(&evidence),
                    1,None,Some("PENDING_CUSTOMER"));
            }
            if ["COMMON_INHERIT","CLIENT_ALIAS","COMMON_ALIAS"].contains(&match_kind)&&
                !str_field(item,"productId").is_empty()&&!str_field(item,"variantId").is_empty(){
                let title=match match_kind{
                    "COMMON_INHERIT"=>"공통 상품 자동 적용",
                    "CLIENT_ALIAS"=>"거래처 별칭 적용",_=>"공통 별칭 적용"
                };
                add(&mut issues,o,Some(row),Some(item),"APPLIED",title,"product",
                    item.get("match"),0,None,Some("AUTO_APPLIED"));
            }
        }
    }
    issues
}
pub(super) fn synchronize(order:&mut Value)->Result<(),String>{
    let issues=order_issues(order);
    let old=field(order,"issueResolutions").as_object()
        .cloned().unwrap_or_else(Map::new);
    let mut next=old.clone();
    let mut present=HashSet::new();
    for issue in issues {
        let id=str_field(&issue,"issueId").to_string();
        present.insert(id.clone());
        let previous=old.get(&id);
        let evidence=if let Some(s)=issue.get("evidence"){s.clone()}
            else{field(&issue,"title").clone()};
        let status=field(&issue,"resolution");
        let updated_at=previous.filter(|prior|
            field(prior,"resolution")==status&&field(prior,"evidence")==&evidence)
            .map(|prior|field(prior,"updatedAt")).unwrap_or_else(||field(order,"updatedAt"));
        next.insert(id,json!({
            "resolution":status,"resolutionSource":field(&issue,"resolutionSource"),
            "updatedAt":updated_at,"evidence":evidence
        }));
    }
    for (id,prior) in &old{
        if !present.contains(id)&&
            ["PENDING_CUSTOMER","UNRESOLVED","PROVISIONALLY_APPROVED","AUTO_APPLIED"]
                .contains(&str_field(prior,"resolution")){
            let mut updated=prior.clone();
            set(&mut updated,"resolution",json!("RESOLVED"))?;
            set(&mut updated,"resolutionSource",json!("직원 수정 또는 현재 원문 반영"))?;
            set(&mut updated,"updatedAt",field(order,"updatedAt").clone())?;
            next.insert(id.clone(),updated);
        }
    }
    set(order,"issueResolutions",Value::Object(next))?;
    Ok(())
}


/// Port of validation.ts approveMissingQuantity and pendingIssue.
pub(super) fn issue_action(payload:&Value)->Result<Value,String> {
    let action=required_str(payload,"action")?;
    let mut order=req(payload,"order")?.clone();
    match action {
        "approve_missing_quantity"=>{
            let rid=required_str(payload,"recipientId")?;
            let iid=required_str(payload,"itemId")?;
            let ri=rows(field(&order,"recipients")).iter()
                .position(|row|str_field(row,"id")==rid);
            let ii=ri.and_then(|ri|rows(field(&order["recipients"][ri],"items"))
                .iter().position(|i|str_field(i,"id")==iid));
            let bad=ri.zip(ii).is_none_or(|(ri,ii)|{
                let i=&order["recipients"][ri]["items"][ii];
                str_field(i,"productId").is_empty() ||
                str_field(i,"variantId").is_empty() ||
                field(i,"quantityConfirmed").as_bool()!=Some(false) ||
                str_field(field(i,"match"),"kind")=="QUANTITY" ||
                rows(field(i,"issues")).iter().any(|v|v.as_str().is_some_and(|s|
                    s.contains("여러")||s.contains("불명확")))
            });
            if bad{return Err("수량 미기재로 확인된 실제 상품만 1개 잠정 처리할 수 있습니다.".into());}
            let ri=ri.unwrap();
            let ii=ii.unwrap();
            let now=required_str(payload,"now")?;
            let actor=required_str(payload,"actor")?;
            let i=&mut order["recipients"][ri]["items"][ii];
            set(i,"quantity",json!(1))?;
            set(i,"quantityApproval",json!({"at":now,"actor":actor,"quantity":1}))?;
            set(i,"manuallyConfirmed",json!(true))?;
            Ok(json!({"order":order}))
        }
        "pending_issue"=>{
            let id=required_str(payload,"issueId")?;
            let matching=order_issues(&order).into_iter()
                .find(|issue|str_field(issue,"issueId")==id &&
                    str_field(issue,"severity")=="ACTION");
            if let Some(issue)=matching {
                let now=required_str(payload,"now")?;
                let actor=required_str(payload,"actor")?;
                if !field(&order,"issueResolutions").is_object(){
                    set(&mut order,"issueResolutions",json!({}))?;
                }
                let evidence=issue.get("evidence").and_then(Value::as_str).unwrap_or("");
                set(&mut order["issueResolutions"],id,json!({
                    "resolution":"PENDING_CUSTOMER","resolutionSource":actor,
                    "updatedAt":now,"evidence":evidence
                }))?;
            }
            Ok(json!({"order":order}))
        }
        _=>Err(format!("지원하지 않는 주문 이슈 action: {action}"))
    }
}
