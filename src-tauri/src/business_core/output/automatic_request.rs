//! Existing automaticMessage() inquiry phase, without a TypeScript formatter.
//! Input issues are the authoritative native workflow issues; the caller
//! supplies a group-scoped frozen order and current minimum workflow step.
use serde_json::{json,Value};
use std::collections::HashSet;
use super::messages::{
    render,default_color_notice,representative_notice,url_is_official,validate_templates,
};

fn s<'a>(v:&'a Value,key:&str)->&'a str{
    v.get(key).and_then(Value::as_str).unwrap_or("")
}
fn list<'a>(v:&'a Value,key:&str)->&'a [Value]{
    v.get(key).and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}
fn distinct(values:impl IntoIterator<Item=String>)->Vec<String>{
    let mut seen=HashSet::new();
    values.into_iter().filter(|v|seen.insert(v.clone())).collect()
}
fn custom_key<'a>(kind:&'a str,has_address:bool)->Option<&'static str>{
    match kind {
        "NAME"=>Some("recipientName"),
        "ADDRESS"=>Some(if has_address{"addressDetail"}else{"addressMissing"}),
        "CONTACT"=>Some("contactMissing"),
        "MODEL_CONFIRM"=>Some("modelConfirm"),
        "MODEL"|"MODEL_CHOICE"|"ALIAS_CONFLICT"|"CATEGORY_CONFLICT"|"OPTION"|"ITEM"
            =>Some("modelMissing"),
        _ if kind.contains("QUANTITY")=>Some("quantityMissing"),
        _=>None
    }
}
fn matches_issue(issue:&Value,row:&Value)->bool{
    s(issue,"recipientId")==s(row,"id")&&s(issue,"severity")=="ACTION"&&
    issue.get("blockingStage").and_then(Value::as_i64).is_some_and(|n|n<=1)
}
fn item_name<'a>(row:&'a Value,issue:&Value)->&'a str{
    list(row,"items").iter().find(|i|s(i,"id")==s(issue,"itemId"))
        .map(|i|s(i,"name")).filter(|name|!name.is_empty()).unwrap_or("상품")
}
fn unconfigured_label(row:&Value,issue:&Value)->Option<String>{
    let kind=s(issue,"kind");
    match kind{
        "ADDRESS"=>Some("배송지 주소".into()),
        "CONTACT"=>Some("연락처".into()),
        "NAME"=>Some("수취인명".into()),
        "MODEL"|"MODEL_CHOICE"|"ALIAS_CONFLICT"|"CATEGORY_CONFLICT"|
        "OPTION"|"MODEL_CONFIRM"|"ITEM"=>{
            Some(format!("{} 모델 / 옵션",item_name(row,issue)))
        },
        _ if kind.contains("QUANTITY")=>{
            Some(format!("{} 수량",item_name(row,issue)))
        },
        _=>None,
    }
}
pub(super) fn execute(payload:&Value)->Result<Value,String>{
    let settings=payload.get("settings").ok_or("메시지 설정이 없습니다.")?;
    validate_templates(settings)?;
    let order=payload.get("order").ok_or("메시지용 발주서가 없습니다.")?;
    let issues=list(payload,"issues");
    let step=payload.get("step").and_then(Value::as_i64)
        .ok_or("진행 단계를 확인하세요.")?;
    let mut lines=Vec::new();
    let mut requires_response=false;
    for row in list(order,"recipients"){
        let mut labels=Vec::new();
        let mut custom=Vec::new();
        let mut row_issues=Vec::new();
        for issue in issues.iter().filter(|issue|matches_issue(issue,row)){
            row_issues.push(issue);
            let key=custom_key(s(issue,"kind"),!s(row,"address").trim().is_empty());
            let configured=key.and_then(|k|settings.get("automaticMessageTemplates")
                .and_then(|v|v.get(k)).and_then(Value::as_str))
                .is_some_and(|v|!v.is_empty());
            if let Some(key)=key.filter(|_|configured){
                custom.push(render(settings,key,&json!({
                    "수취인":if s(row,"name").is_empty(){"수취인"}else{s(row,"name")},
                    "상품명":item_name(row,issue),
                }))?);
            }else if let Some(label)=unconfigured_label(row,issue){
                labels.push(label);
            }
        }
        let notices=list(row,"items").iter().map(|i|{
            Ok::<Vec<String>,String>([
                default_color_notice(settings,i)?,
                representative_notice(settings,i)?,
            ].into_iter().flatten().collect::<Vec<_>>())
        }).collect::<Result<Vec<_>,_>>()?
          .into_iter().flatten().collect::<Vec<_>>();
        if labels.is_empty()&&custom.is_empty()&&notices.is_empty(){continue;}
        if !labels.is_empty()||!custom.is_empty(){requires_response=true;}
        let links=list(row,"items").iter().filter(|i|
            i.get("modelProposal").and_then(|v|v.get("required"))
                .and_then(Value::as_bool)==Some(true) &&
            url_is_official(s(i,"url")))
            .map(|i|format!("{}\n{}",s(i,"name"),s(i,"url")))
            .collect::<Vec<_>>();
        let mut parts=Vec::new();
        if !labels.is_empty(){
            parts.push(render(settings,"requestRecipient",&json!({
                "번호":(lines.len()+1).to_string(),
                "수취인":if s(row,"name").is_empty(){"수취인"}else{s(row,"name")},
                "확인항목":distinct(labels).join(", "),
            }))?);
        }
        parts.extend(distinct(custom));
        parts.extend(distinct(links));
        parts.extend(notices);
        lines.push(parts.join("\n"));
    }
    let phase=if step>=2&&!requires_response{"payment"}else{"request"};
    let request_text=if lines.is_empty(){String::new()}
        else if requires_response{format!("{}\n\n{}",lines.join("\n\n"),
            render(settings,"requestClosing",&Value::Null)?)}
        else{lines.join("\n\n")};
    Ok(json!({"phase":phase,"requestText":request_text,
        "requiresCustomerResponse":requires_response}))
}
