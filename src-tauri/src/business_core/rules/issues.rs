//! Existing TypeScript validation.ts::orderIssues decision reconciliation.
//! Evidence strings deliberately represent JSON.stringify(value), because
//! staff resolutions are valid only while the original evidence is unchanged.
use std::collections::HashSet;
use serde_json::{json, Value};
use super::{field, flag, rows, safe, set, str_field};

struct Issue {
    id:String,
    evidence:String,
    status:Option<&'static str>,
    approval_actor:Option<String>,
}
fn issue_id(order:&Value, row:Option<&Value>, item:Option<&Value>, kind:&str)->String {
    format!("issue:{}:{}:{}:{kind}",str_field(order,"id"),
        row.map(|r|str_field(r,"id")).unwrap_or("order"),
        item.map(|i|str_field(i,"id")).unwrap_or("recipient"))
}
fn add(issues:&mut Vec<Issue>,order:&Value,row:Option<&Value>,
    item:Option<&Value>,kind:&str,evidence:&Value,
    status:Option<&'static str>,approval_actor:Option<String>) {
    issues.push(Issue {
        id:issue_id(order,row,item,kind),
        evidence:serde_json::to_string(evidence).unwrap_or_else(|_|"null".to_string()),
        status,approval_actor
    });
}
fn valid_contact(phone:&str)->bool {
    let digits:String=phone.chars().filter(|c|!c.is_whitespace() &&
        !['(',')','.','-'].contains(c)).collect();
    digits.starts_with('0') && digits.chars().all(|c|c.is_ascii_digit()) &&
        ((9..=11).contains(&digits.len()) || (digits.starts_with("050")&&digits.len()==12)) &&
        (!digits.starts_with("010") || digits.len()==11)
}
fn valid_address(value:&str)->bool {
    let s=value.trim();
    if s.is_empty() || s.contains('#') || s.contains('@') {return false;}
    // The TS expression is:
    // /(?:대로|로|길)\s*\d+|[동리읍면]\s+(?:산\s*)?\d+|사서함\s*\d+/
    for marker in ["대로","로","길","사서함"] {
        if s.match_indices(marker).any(|(i,_)|s[i+marker.len()..]
            .trim_start().chars().next().is_some_and(|c|c.is_ascii_digit())) {
            return true;
        }
    }
    for (i,c) in s.char_indices() {
        if !['동','리','읍','면'].contains(&c) {continue;}
        let suffix=&s[i+c.len_utf8()..];
        if !suffix.chars().next().is_some_and(char::is_whitespace) {continue;}
        let mut suffix=suffix.trim_start();
        if let Some(rest)=suffix.strip_prefix('산') {suffix=rest.trim_start();}
        if suffix.chars().next().is_some_and(|c|c.is_ascii_digit()) {return true;}
    }
    false
}
pub(super) fn synchronize(order:&mut Value)->Result<(),String>{
    let mut issues=Vec::new();
    let order_view=order.clone();
    let o=&order_view;
    if str_field(o,"clientId").is_empty() && str_field(o,"orderType")!="RETAIL" {
        add(&mut issues,o,None,None,"CLIENT",field(o,"clientId"),None,None);
    }
    let recipients=rows(field(o,"recipients"));
    if recipients.is_empty(){
        add(&mut issues,o,None,None,"RECIPIENT",&json!(0),None,None);
    }
    for row in recipients {
        if !rows(field(row,"unassignedEvidence")).is_empty() {
            add(&mut issues,o,Some(row),None,"UNASSIGNED_EVIDENCE",
                field(row,"unassignedEvidence"),None,None);
        }
        if str_field(row,"name").trim().is_empty(){
            add(&mut issues,o,Some(row),None,"NAME",field(row,"name"),None,None);
        }
        let allow_legacy=field(o,"receptionVersion").as_i64()!=Some(1);
        let address=str_field(row,"address");
        let address_ok=!address.trim().is_empty() &&
            ((allow_legacy && str_field(row,"addressStatus")=="CONFIRMED") ||
             (str_field(row,"addressStatus")!="INCOMPLETE"&&valid_address(address)));
        if !address_ok {
            add(&mut issues,o,Some(row),None,"ADDRESS",
                &json!([field(row,"address"),field(row,"addressStatus")]),None,None);
        }
        let phone=str_field(row,"phone");
        let mobile=str_field(row,"mobile");
        if phone.is_empty() && mobile.is_empty() || 
            (!valid_contact(phone) && !valid_contact(mobile)) {
            add(&mut issues,o,Some(row),None,"CONTACT",
                &json!([field(row,"phone"),field(row,"mobile")]),None,None);
        }
        for key in ["name","address","phone","mobile"]{
            let relevant=rows(field(row,"candidates")).iter().filter(|candidate|
                str_field(candidate,"field")==key).cloned().collect::<Vec<_>>();
            let unique=relevant.iter().map(|c|serde_json::to_string(field(c,"value")).unwrap_or_default())
                .collect::<HashSet<_>>();
            let confirmed=rows(field(row,"confirmedFields")).iter()
                .any(|value|value.as_str()==Some(key));
            if unique.len()>1&&!confirmed {
                add(&mut issues,o,Some(row),None,&format!("CANDIDATE_{key}"),
                    &json!(relevant),None,None);
            }
        }
        let items=rows(field(row,"items"));
        if items.is_empty(){
            add(&mut issues,o,Some(row),None,"ITEM",&json!([]),None,None);
        }
        for item in items{
            let match_kind=str_field(field(item,"match"),"kind");
            let root=match match_kind {
                "QUANTITY"=>"QUANTITY_LINK","CONFLICT"=>"ALIAS_CONFLICT",
                "CATEGORY_CONFLICT"=>"CATEGORY_CONFLICT",
                "CATEGORY"=>"MODEL_CHOICE",_=>"MODEL"
            };
            if str_field(item,"productId").is_empty() || 
                str_field(item,"variantId").is_empty(){
                add(&mut issues,o,Some(row),Some(item),root,
                    &json!([field(item,"productId"),field(item,"variantId"),field(item,"match")]),
                    None,None);
            }
            if field(item,"quantityConfirmed").as_bool()==Some(false) &&
                root!="QUANTITY_LINK" {
                add(&mut issues,o,Some(row),Some(item),"QUANTITY_MISSING",
                    &json!([field(item,"quantity"),field(item,"quantityConfirmed")]),
                    None,None);
            }
            if field(item,"quantityConfirmed").as_bool()!=Some(false) &&
                safe(field(item,"quantity")).is_none_or(|n|n<1) {
                add(&mut issues,o,Some(row),Some(item),"QUANTITY_INVALID",
                    field(item,"quantity"),None,None);
            }
            if str_field(o,"orderType")!="RETAIL" &&
                !str_field(o,"clientId").is_empty() &&
                !str_field(item,"productId").is_empty() &&
                !str_field(item,"variantId").is_empty() &&
                safe(field(item,"unitPrice")).is_none() {
                add(&mut issues,o,Some(row),Some(item),"PRICE",
                    field(item,"unitPrice"),None,None);
            }
            if !str_field(item,"productId").is_empty() &&
                !str_field(item,"variantId").is_empty() &&
                rows(field(item,"issues")).iter().any(|i|i.as_str().is_some_and(|s|
                    s.contains("색상") || s.contains("옵션"))) {
                add(&mut issues,o,Some(row),Some(item),"OPTION",
                    &json!([field(item,"variantId"),field(item,"color"),field(item,"issues")]),
                    None,None);
            }
            if flag(field(item,"modelProposal"),"required") {
                add(&mut issues,o,Some(row),Some(item),"MODEL_CONFIRM",
                    &json!([field(item,"productId"),field(item,"variantId"),field(item,"modelProposal")]),
                    Some("PENDING_CUSTOMER"),None);
            }
            if ["COMMON_INHERIT","CLIENT_ALIAS","COMMON_ALIAS"].contains(&match_kind) &&
                !str_field(item,"productId").is_empty() &&
                !str_field(item,"variantId").is_empty() {
                add(&mut issues,o,Some(row),Some(item),"APPLIED",
                    field(item,"match"),Some("AUTO_APPLIED"),None);
            }
        }
    }
    let existing=field(o,"issueResolutions");
    let mut next=existing.as_object().cloned().unwrap_or_default();
    let mut present=HashSet::new();
    for issue in issues {
        present.insert(issue.id.clone());
        let old=next.get(&issue.id);
        let status=issue.status.unwrap_or_else(||{
            if old.is_some_and(|prior|
                str_field(prior,"evidence")==issue.evidence &&
                str_field(prior,"resolution")=="PENDING_CUSTOMER") {
                "PENDING_CUSTOMER"
            } else {"UNRESOLVED"}
        });
        let resolution_source=old
            .map(|p|str_field(p,"resolutionSource"))
            .filter(|s|!s.is_empty())
            .unwrap_or(if status=="AUTO_APPLIED"{"코어"}
                else if status=="PROVISIONALLY_APPROVED"{"직원"}else{"미확인"});
        let updated_at=old.filter(|previous|
            str_field(previous,"resolution")==status &&
            str_field(previous,"evidence")==issue.evidence)
            .map(|p|field(p,"updatedAt")).unwrap_or_else(||field(o,"updatedAt")).clone();
        next.insert(issue.id,json!({"resolution":status,
            "resolutionSource":resolution_source,"updatedAt":updated_at,
            "evidence":issue.evidence}));
    }
    for (id,prior) in existing.as_object().into_iter().flat_map(|o|o.iter()) {
        if !present.contains(id) &&
            ["PENDING_CUSTOMER","UNRESOLVED","PROVISIONALLY_APPROVED","AUTO_APPLIED"]
                .contains(&str_field(prior,"resolution")) {
            let mut updated=prior.clone();
            set(&mut updated,"resolution",json!("RESOLVED"))?;
            set(&mut updated,"resolutionSource",json!("직원 수정 또는 현재 원문 반영"))?;
            set(&mut updated,"updatedAt",field(o,"updatedAt").clone())?;
            next.insert(id.clone(),updated);
        }
    }
    set(order,"issueResolutions",Value::Object(next))?;
    Ok(())
}
