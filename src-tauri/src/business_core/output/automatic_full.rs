//! Full auto-message projection from saved/preview State, without the TS
//! business-formatting functions. The React caller owns only draft editing.
use serde_json::{json,Value};
use std::collections::HashSet;
use super::messages::{payment,render,url_is_official};
use super::automatic_request;
use super::super::rules;

fn string<'a>(v:&'a Value,key:&str)->&'a str{
    v.get(key).and_then(Value::as_str).unwrap_or("")
}
fn rows<'a>(v:&'a Value,key:&str)->&'a [Value]{
    v.get(key).and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}
fn by_id<'a>(list:&'a [Value],id:&str)->Option<&'a Value>{
    list.iter().find(|v|string(v,"id")==id)
}
fn not_removed(v:&Value)->bool{
    v.get("deletedAt").is_none_or(Value::is_null)
}
fn is_true(v:&Value,key:&str)->bool{v.get(key).and_then(Value::as_bool)==Some(true)}
fn opt_i64(v:&Value,key:&str)->Option<i64>{v.get(key).and_then(Value::as_i64)}
fn distinct(values:impl IntoIterator<Item=String>)->Vec<String>{
    let mut seen=HashSet::new();
    values.into_iter().filter(|s|seen.insert(s.to_string())).collect()
}
fn resolved_client<'a>(state:&'a Value,order:&'a Value)->Option<&'a Value>{
    if (order.get("confirmedAt").is_some_and(|x|!x.is_null()) ||
        is_true(order,"pricesLocked")) &&
        order.get("clientSnapshot").is_some_and(Value::is_object) {
        return order.get("clientSnapshot");
    }
    by_id(rows(state,"clients"),string(order,"clientId"))
        .or_else(||order.get("clientSnapshot").filter(|c|c.is_object()))
}
fn account_for<'a>(state:&'a Value,view:&Value,client:&Value)->Option<&'a Value>{
    let settings=&state["settings"];
    let accounts=rows(&settings,"accounts");
    if string(view,"accountMode")=="MANUAL"{
        return by_id(accounts,string(view,"accountId"));
    }
    if string(view,"orderType")!="RETAIL"{
        let preferred=client.get("preferredAccountId")
            .and_then(Value::as_str)
            .or_else(||view.get("clientSnapshot")
                .and_then(|s|s.get("preferredAccountId"))
                .and_then(Value::as_str)).unwrap_or("");
        if let Some(a)=by_id(accounts,preferred){return Some(a);}
    }
    let items=rows(view,"recipients").iter()
        .flat_map(|r|rows(r,"items")).collect::<Vec<_>>();
    let mall=!items.is_empty()&&items.iter().all(|i|{
        let catalog=i.get("catalog").and_then(Value::as_str).unwrap_or("");
        if !catalog.is_empty(){return catalog=="BANDOMALL";}
        by_id(rows(state,"products"),string(i,"productId"))
            .is_some_and(|p|string(p,"catalog")=="BANDOMALL")
    });
    let brand=&settings["brandAccounts"];
    let chosen=if mall{string(brand,"BANDOMALL")}
        else{
            let branded=string(brand,"BANDOSTAND");
            if branded.is_empty(){string(settings,"defaultAccountId")}else{branded}
        };
    by_id(accounts,chosen)
}
fn group_view(state:&Value,group_id:&str)->Result<(Value,Vec<(Value,Value)>,i64),String>{
    let workflow=&state["workflow"];
    let group=by_id(rows(workflow,"groups"),group_id)
        .ok_or("현재 주문 묶음을 찾지 못했습니다.")?;
    if !not_removed(group){return Err("묶음의 배송 건이 없습니다.".into());}
    let ships=rows(workflow,"shipments").iter().filter(|s|
        string(s,"groupId")==group_id&&!is_true(s,"legacyArchived")&&
        !by_id(rows(state,"orders"),string(s,"orderId"))
            .is_some_and(|o|!not_removed(o))).collect::<Vec<_>>();
    if ships.is_empty(){return Err("묶음의 배송 건이 없습니다.".into());}
    let first=by_id(rows(state,"orders"),string(ships[0],"orderId"))
        .ok_or("배송 건의 발주서 / 수취인 / 거래처 연결을 확인하세요.")?;
    let allowed=ships.iter().map(|s|string(s,"recipientId")).collect::<HashSet<_>>();
    let recipients=rows(first,"recipients").iter().filter(|r|
        allowed.contains(string(r,"id"))).cloned().collect::<Vec<_>>();
    let mut contexts=Vec::with_capacity(recipients.len());
    for recipient in &recipients{
        let ship=ships.iter().find(|s|string(s,"recipientId")==string(recipient,"id"))
            .ok_or("배송 건의 발주서 / 수취인 / 거래처 연결을 확인하세요.")?;
        let amount=rules::execute("calculate_shipment_totals",json!({
            "state":state,"shipmentId":ship["id"]
        }))?;
        contexts.push(((*ship).clone(),amount));
    }
    let shipping=contexts.iter()
        .map(|(_,a)|opt_i64(a,"shipping"))
        .collect::<Option<Vec<_>>>()
        .and_then(|v|v.into_iter().try_fold(0_i64,|sum,n|
            sum.checked_add(n).filter(|x|(0..=9_007_199_254_740_991).contains(x))));
    let step=ships.iter().filter_map(|s|opt_i64(s,"step")).min().unwrap_or(0);
    let mut view=first.clone();
    view["recipients"]=json!(recipients);
    view["shippingFee"]=json!(shipping);
    view["pricesLocked"]=json!(false);
    view["vatAmount"]=Value::Null;
    view["accountMode"]=group.get("accountMode")
        .filter(|v|!v.is_null())
        .cloned().unwrap_or_else(||first.get("accountMode").cloned().unwrap_or(Value::Null));
    if string(group,"accountMode")=="MANUAL"{
        view["accountId"]=group.get("accountId").cloned().unwrap_or(Value::Null);
    }
    Ok((view,contexts,step))
}
fn provisional_notice(state:&Value,item:&Value)->String{
    let pid=string(item,"productId");
    let vid=string(item,"variantId");
    if pid.is_empty()||vid.is_empty(){return String::new();}
    let evidence=&item["selectionEvidence"];
    if string(evidence,"productId")!=pid||string(evidence,"variantId")!=vid{
        return String::new();
    }
    let Some(p)=by_id(rows(state,"products"),pid)else{return String::new()};
    let lead=string(p,"name").split('/').next().unwrap_or("").trim();
    if lead.is_empty(){return String::new();}
    let variant=regex::Regex::new(r"(?i)^BD[\s-]+").expect("brand prefix");
    let bare=variant.replace(lead,"").to_string();
    let names=if bare==lead{vec![lead.to_string()]}
        else{vec![lead.to_string(),bare]};
    let expression=string(evidence,"expression");
    for name in names {
        let mut models=vec![name.trim().to_string()];
        let shortened=regex::Regex::new(r"(?i)^BD[\s-]*")
            .expect("prefix").replace(name.trim(),"").to_string();
        if !models.contains(&shortened){models.push(shortened);}
        for text in models.into_iter().filter(|t|!t.is_empty()){
            let pattern=text.split_whitespace().map(regex::escape)
                .collect::<Vec<_>>().join(r"\s*");
            let Ok(re)=regex::RegexBuilder::new(&pattern).case_insensitive(true).build()
                else{continue};
            for m in re.find_iter(expression){
                let before=expression[..m.start()].chars().next_back();
                let after=expression[m.end()..].chars().next();
                if before.is_none_or(|ch|!ch.is_ascii_alphanumeric()) &&
                    after.is_none_or(|ch|!ch.is_ascii_alphanumeric()&&ch!='-'){
                    return String::new();
                }
            }
        }
    }
    string(&state["settings"]["provisionalProductNotices"],pid).trim().to_string()
}
fn price_issues(state:&Value,view:&Value,client:&Value,account:Option<&Value>,
    amounts:&[(Value,Value)])->Result<Vec<String>,String>{
    let mut issues=Vec::new();
    if string(client,"id").is_empty(){issues.push("거래처 선택 필요".into());}
    let order_issues=rules::execute("order_issues",json!({"order":view}))?;
    for issue in rows(&order_issues,"issues").iter().filter(|i|
        string(i,"severity")=="ACTION"&&
        opt_i64(i,"blockingStage").is_some_and(|n|n<=1)){
        let label=if !string(issue,"itemId").is_empty(){
            rows(view,"recipients").iter().flat_map(|r|rows(r,"items"))
                .find(|item|string(item,"id")==string(issue,"itemId"))
                .map(|item|string(item,"name")).filter(|s|!s.is_empty())
                .unwrap_or("상품").to_owned()
        }else{
            let index=rows(view,"recipients").iter().position(|r|
                string(r,"id")==string(issue,"recipientId"));
            format!("수취인 {}",index.map(|n|n+1).unwrap_or(0))
        };
        issues.push(format!("{label}: {}",string(issue,"title")));
    }
    let items=rows(view,"recipients").iter().flat_map(|r|rows(r,"items"))
        .collect::<Vec<_>>();
    if items.iter().any(|i|string(i,"productId").is_empty() ||
        string(i,"variantId").is_empty()){
        issues.push("제품명이 확인되지 않습니다.".into());
    }
    if !string(client,"id").is_empty() &&
        items.iter().any(|i|i.get("unitPrice").is_none_or(Value::is_null)){
        issues.push("판매가 확인 필요".into());
    }
    // Exact original domain.messages uses totals(groupOrder, client).shipping
    // before a separately computed per-shipment sufficiency filter.
    let result=rules::execute("calculate_price",json!({"order":view,"client":client}))?;
    if result.get("shipping").is_none_or(Value::is_null){
        issues.push("운임 확인 필요".into());
    }
    if account.is_none_or(|a|["bank","number","holder"].iter().any(|k|
        string(a,k).trim().is_empty())){
        issues.push("입금 계좌 등록 필요".into());
    }
    let all_shipping=amounts.iter().all(|(_,a)|a.get("shipping").is_some_and(|v|!v.is_null()));
    issues=distinct(issues);
    if all_shipping{issues.retain(|issue|issue!="운임 확인 필요");}
    if amounts.iter().any(|(_,a)|a.get("shipping").is_none_or(Value::is_null)){
        issues.push("배송 건별 운임 확인 필요".into());
    }
    Ok(distinct(issues))
}
fn payment_input(state:&Value,view:&Value,amounts:&[(Value,Value)],
    account:Option<&Value>,include_links:bool)->Result<Value,String>{
    let client=resolved_client(state,view).cloned().unwrap_or_else(||json!({
        "id":"","shippingFeeExcluded":false
    }));
    let mut recipients=Vec::new();
    for (index,row) in rows(view,"recipients").iter().enumerate(){
        let (_,amount)=amounts.get(index).ok_or("배송 건 연결을 확인하세요.")?;
        let items=rows(row,"items").iter().map(|item|{
            let mut item=item.clone();
            let amount=match (opt_i64(&item,"unitPrice"),opt_i64(&item,"quantity")){
                (Some(price),Some(quantity))=>price.checked_mul(quantity)
                    .filter(|v|(-9_007_199_254_740_991..=9_007_199_254_740_991).contains(v)),
                _=>None
            };
            item["amount"]=json!(amount);
            let product=by_id(rows(state,"products"),string(&item,"productId"));
            item["colorNotRequired"]=json!(product.is_some_and(|p|
                string(p,"colorStatus")=="NOT_REQUIRED"));
            item["provisionalNotice"]=json!(provisional_notice(state,&item));
            item
        }).collect::<Vec<_>>();
        let freight=row.get("freightCode").and_then(Value::as_str)
            .unwrap_or_else(||string(view,"freightCode"));
        let vat=row.get("vatOverride").and_then(Value::as_bool)
            .or_else(||row.get("vatDefault").and_then(Value::as_bool))
            .unwrap_or_else(||is_true(view,"applyVat"));
        recipients.push(json!({
            "name":string(row,"name"),"items":items,
            "freightCode":freight,"applyVat":vat,
            "shipping":amount.get("shipping"),"vat":amount.get("vat")
        }));
    }
    let totals=amounts.iter().map(|(_,a)|opt_i64(a,"total"))
        .collect::<Option<Vec<_>>>()
        .and_then(|xs|xs.into_iter().try_fold(0_i64,|s,n|s.checked_add(n)
            .filter(|v|(0..=9_007_199_254_740_991).contains(v))));
    Ok(json!({
        "mode":"payment","settings":state["settings"],
        "recipients":recipients,"total":totals,
        "clientSelected":!string(&client,"id").is_empty(),
        "account":account.unwrap_or(&Value::Null),
        "includeLinks":include_links
    }))
}
fn payment_signature(view:&Value,payment_text:&str,account:Option<&Value>,
    account_wire:&[Value])->Result<String,String>{
    let items=rows(view,"recipients").iter().map(|row|
        rows(row,"items").iter().map(|i|json!([
            i.get("productId"),i.get("variantId"),i.get("quantity"),i.get("unitPrice")
        ])).collect::<Vec<_>>()).collect::<Vec<_>>();
    let text=serde_json::to_string(payment_text).map_err(|e|e.to_string())?;
    let item_text=serde_json::to_string(&items).map_err(|e|e.to_string())?;
    let account_text=if let Some(account)=account{
        let wire=account_wire.iter().find(|record|
            string(record,"id")==string(account,"id")).and_then(|r|r.get("json"))
            .and_then(Value::as_str)
            .and_then(|raw|serde_json::from_str::<Value>(raw).ok()
                .filter(|parsed|parsed==account).map(|_|raw.to_string()));
        Some(wire.unwrap_or_else(||serde_json::to_string(account).unwrap_or_default()))
    }else{None};
    Ok(if let Some(raw)=account_text{
        format!(r#"{{"text":{text},"account":{raw},"items":{item_text}}}"#)
    }else{
        format!(r#"{{"text":{text},"items":{item_text}}}"#)
    })
}
/** The immutable workflow notice stores the FULL payment text, including the
 * greeting. The editable automatic-message preview deliberately removes that
 * greeting, so never persist its preview "text" as an audit notice.
 * Source oracle: workflow.ts::groupMessages(state, gid).payment. */
pub(super) fn payment_notice(payload:&Value)->Result<Value,String>{
    let state=payload.get("state").ok_or("메시지 생성 상태가 없습니다.")?;
    let gid=string(payload,"groupId");
    if gid.is_empty(){return Err("묶음을 선택하세요.".into());}
    let (view,amounts,_)=group_view(state,gid)?;
    let client=resolved_client(state,&view).cloned().unwrap_or_else(||json!({
        "id":"","shippingFeeExcluded":false
    }));
    let account=account_for(state,&view,&client);
    let rendered=payment(&payment_input(state,&view,&amounts,account,false)?,
        &state["settings"])?;
    Ok(json!({"payment":rendered["payment"]}))
}
/** Keep the original copy-only greeting helper in Rust too: request drafts
 * remain staff-editable, so this operation accepts the final edited text.
 */
pub(super) fn decorate_copy(payload:&Value)->Result<Value,String>{
    let original=payload.get("text").and_then(Value::as_str)
        .ok_or("복사할 메시지 본문이 없습니다.")?;
    let include_greeting=is_true(payload,"includeGreeting");
    let decorated=if include_greeting &&
        !original.trim_start().starts_with("안녕하세요 반도스탠드입니다."){
        format!("안녕하세요 반도스탠드입니다.\n\n{original}")
    }else{original.to_string()};
    Ok(json!({"text":decorated}))
}
pub(super) fn execute(payload:&Value)->Result<Value,String>{
    let state=payload.get("state").ok_or("메시지 생성 상태가 없습니다.")?;
    let gid=string(payload,"groupId");
    if gid.is_empty(){return Err("묶음을 선택하세요.".into());}
    let include_links=is_true(payload,"includeLinks");
    let (view,amounts,step)=group_view(state,gid)?;
    let client=resolved_client(state,&view).cloned().unwrap_or_else(||json!({
        "id":"","shippingFeeExcluded":false
    }));
    let account=account_for(state,&view,&client);
    let wf=rules::execute("workflow_issues",json!({
        "state":state,"groupId":gid
    }))?;
    let request=automatic_request::execute(&json!({
        "settings":state["settings"],"order":view,"issues":wf["issues"],"step":step
    }))?;
    let payment_with_links=payment(&payment_input(state,&view,&amounts,account,true)?,
        &state["settings"])?;
    let rendered=if include_links{payment_with_links.clone()}
        else{payment(&payment_input(state,&view,&amounts,account,false)?,
            &state["settings"])?};
    let issues=price_issues(state,&view,&client,account,&amounts)?;
    let greeting=render(&state["settings"],"paymentGreeting",&Value::Null)?;
    let pay=string(&rendered,"payment");
    let payment_text=if pay.starts_with(&greeting){pay[greeting.len()..].trim_start()}
        else{pay};
    let text=if string(&request,"phase")=="payment"{
        payment_text.to_string()
    }else{string(&request,"requestText").to_string()};
    let valid_links=distinct(rows(&view,"recipients").iter()
        .flat_map(|r|rows(r,"items")).filter(|i|url_is_official(string(i,"url")))
        .map(|i|format!("{}\n{}",string(i,"name"),string(i,"url"))));
    let signature=payment_signature(&view,string(&payment_with_links,"payment"),
        account,rows(payload,"accountWire"))?;
    if string(payload,"mode")=="payment_copy_status"{
        let copied=rows(&state["workflow"],"events").iter().any(|e|
            string(e,"groupId")==gid&&string(e,"action")=="메시지 복사"&&
            string(&e["after"],"type")=="PAYMENT"&&
            string(&e["after"],"signature")==signature);
        return Ok(json!({"copied":copied}));
    }
    Ok(json!({
        "phase":string(&request,"phase"),"text":text,
        "paymentIssues":issues,"signature":signature,
        "validRequestLinks":valid_links
    }))
}
