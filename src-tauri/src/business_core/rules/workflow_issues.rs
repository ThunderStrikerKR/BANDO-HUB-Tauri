//! Workflow validation projections translated from workflow.ts workflowIssues
//! and stageIssues. No UI, SQLite, recognition, or message generation.
use serde_json::{json,Value};
use std::collections::HashSet;
use super::{field,find_by_id,flag,has_value,rows,set,str_field};
use super::workflow as w;

fn historical_product<'a>(state:&'a Value,pid:&str,vid:&str)->Option<&'a Value>{
    if pid.is_empty()||vid.is_empty(){return None;}
    let products=field(state,"products");
    if let Some(p)=find_by_id(products,pid){
        let variants=rows(field(p,"variants"));
        return (variants.len()==1&&str_field(&variants[0],"id")==vid).then_some(p);
    }
    let mapping=format!("{pid}|{vid}");
    let mapped_id=str_field(field(state,"productMappings"),&mapping);
    let p=find_by_id(products,mapped_id)?;
    let variants=rows(field(p,"variants"));
    (str_field(p,"sourceProductId")==pid &&
        variants.len()==1 && str_field(&variants[0],"id")==vid).then_some(p)
}
fn sale_problem(p:Option<&Value>)->&str{
    let Some(p)=p else{return "상품 연결 확인 필요";};
    if has_value(field(p,"deletedAt"))||has_value(field(p,"supersededBy")) ||
        field(p,"active").as_bool()==Some(false){return "판매중지";}
    match str_field(p,"saleStatus"){
        ""|"판매중"|"SELLING"|"판매 표시"=>"",other=>other
    }
}
fn sender_phone(raw:&str)->String{
    // Sender phone rules in src/explicit-sender.ts permit whitespace and
    // punctuation inside all three blocks of a telephone number.
    let chars=raw.chars().collect::<Vec<_>>();
    let is_sep=|ch:char|ch.is_whitespace()||['(',')','.','-'].contains(&ch);
    for start in 0..chars.len(){
        if chars[start]!='0'||(start>0&&chars[start-1].is_ascii_digit()){continue;}
        for prefix_len in [4,3,2]{
            if start+prefix_len>chars.len(){continue;}
            let prefix=chars[start..start+prefix_len].iter().collect::<String>();
            let valid=match prefix_len{
                4=>prefix.starts_with("050")&&prefix.chars().nth(3)
                    .is_some_and(|ch|ch.is_ascii_digit()),
                3=>prefix.starts_with("01")&&matches!(prefix.chars().nth(2),
                      Some('0'|'1'|'6'|'7'|'8'|'9'))
                    ||prefix=="070"||prefix=="080"
                    ||prefix.starts_with('0')&&matches!(prefix.chars().nth(1),
                      Some('3'|'4'|'5'|'6'))&&prefix.chars().nth(2)
                          .is_some_and(|ch|ch.is_ascii_digit()),
                2=>prefix=="02",_=>false
            };
            if !valid{continue;}
            let mut first=start+prefix_len;
            while first<chars.len()&&is_sep(chars[first]){first+=1;}
            for middle_length in [3,4]{
                let mid_end=first+middle_length;
                if mid_end>chars.len()||!chars[first..mid_end].iter().all(|c|c.is_ascii_digit()){
                    continue;
                }
                let mut last=mid_end;
                while last<chars.len()&&is_sep(chars[last]){last+=1;}
                let end=last+4;
                if end>chars.len()||!chars[last..end].iter().all(|c|c.is_ascii_digit())
                    ||end<chars.len()&&chars[end].is_ascii_digit(){continue;}
                return chars[start..end].iter().collect();
            }
        }
    }
    String::new()
}
fn sender_field<'a>(order:&'a Value,state:&'a Value,key:&str)->String{
    let snapshot=field(order,"senderSnapshot");
    if snapshot.is_object(){return str_field(snapshot,key).to_string();}
    if ["DEALER","RETAIL"].contains(&str_field(order,"orderType")){
        let settings=field(state,"settings");
        return if key=="name"{
            let name=str_field(settings,"senderName").trim();
            if name.is_empty(){"반도스탠드".into()}else{name.into()}
        }else{str_field(settings,match key {
            "address"=>"senderAddress","phone"=>"senderPhone",
            "mobile"=>"senderMobile",_=>key
        }).into()};
    }
    let base=field(order,"clientSnapshot");
    let base=if base.is_object(){base}else{
        find_by_id(field(state,"clients"),str_field(order,"clientId")).unwrap_or(base)
    };
    let raw=if let Some(s)=field(order,"analysisRaw").as_str(){s}
        else{str_field(order,"raw")};
    let sender=raw.lines().find_map(|line|{
        let stripped=line.trim_start();
        for label in ["보내는 분","보내는분","보내는 사람","보내는사람",
            "송하인명","송하인"]{
            if let Some(rest)=stripped.strip_prefix(label){
                let rest=rest.trim_start();
                if let Some(v)=rest.strip_prefix(':').or_else(||rest.strip_prefix('：')){
                    return Some(v.trim().to_string());
                }
            }
        }
        None
    });
    if let Some(sender)=sender {
        if key=="name"{return sender;}
        if key=="address"{
            let mut capture=false;
            let mut address=String::new();
            for line in raw.lines(){
                for marker in ["보내는곳","송하인주소","주소"] {
                    let trimmed=line.trim_start();
                    if let Some(rest)=trimmed.strip_prefix(marker) {
                        if let Some(v)=rest.trim_start().strip_prefix(':')
                            .or_else(||rest.trim_start().strip_prefix('：')){
                            capture=true;
                            if !address.is_empty(){address.push(' ');}
                            address.push_str(v.trim());
                        }
                    }
                }
                if capture&&!line.contains("보내는곳")&&!line.contains("송하인주소")&&
                    !line.trim_start().starts_with("주소"){
                    if !address.is_empty(){address.push(' ');}
                    address.push_str(line.trim());
                }
            }
            return address;
        }
        if key=="mobile"{return String::new();}
        if key=="phone"{return sender_phone(raw);}
    }
    str_field(base,key).to_string()
}
fn operational(order:&Value,row:Option<&Value>,group_id:&str,
    kind:&str,title:String,stage:i64,field_name:&str)->Value{
    let base_id=format!("issue:{}:{}:recipient:{kind}",str_field(order,"id"),
        row.map(|r|str_field(r,"id")).unwrap_or("order"));
    let mut issue=json!({
        "issueId":if row.is_some(){base_id}else{format!("{base_id}:{group_id}")},
        "orderId":field(order,"id"),"groupId":group_id,
        "recipientId":row.map(|r|str_field(r,"id")).unwrap_or(""),
        "kind":kind,"title":title,
        "detail":if let Some(r)=row {
            format!("{} / {}",if str_field(r,"name").is_empty(){"수취인"}else{str_field(r,"name")},title)
        }else{title},
        "blockingStage":stage,"severity":"ACTION","resolution":"UNRESOLVED",
        "resolutionSource":"업무 검증","updatedAt":field(order,"updatedAt")
    });
    if let Some(r)=row{
        let _=set(&mut issue,"linkKey",
            json!(format!("{}:{field_name}",str_field(r,"id"))));
    }
    issue
}
fn active_shipments<'a>(state:&'a Value,group_id:&str)->Result<(usize,Vec<&'a Value>),String>{
    let groups=rows(field(field(state,"workflow"),"groups"));
    let gi=groups.iter().position(|g|str_field(g,"id")==group_id)
        .ok_or_else(||"현재 주문 묶음을 찾지 못했습니다.".to_string())?;
    let shipments=if has_value(field(&groups[gi],"deletedAt")){Vec::new()}
        else{rows(field(field(state,"workflow"),"shipments")).iter()
            .filter(|s|str_field(s,"groupId")==group_id&&!flag(s,"legacyArchived")
            &&!find_by_id(field(state,"orders"),str_field(s,"orderId"))
                .is_some_and(|o|has_value(field(o,"deletedAt"))))
            .collect()};
    if shipments.is_empty(){return Err("묶음의 배송 건이 없습니다.".into());}
    Ok((gi,shipments))
}
fn context<'a>(state:&'a Value,ship:&Value)->Result<(&'a Value,&'a Value),String>{
    let order=find_by_id(field(state,"orders"),str_field(ship,"orderId"))
        .ok_or("배송 건의 발주서 / 수취인 / 거래처 연결을 확인하세요.")?;
    let recipient=find_by_id(field(order,"recipients"),str_field(ship,"recipientId"))
        .ok_or("배송 건의 발주서 / 수취인 / 거래처 연결을 확인하세요.")?;
    Ok((order,recipient))
}
pub(super) fn workflow_issues(state:&Value,group_id:&str)->Result<Vec<Value>,String>{
    let (gi,shipments)=active_shipments(state,group_id)?;
    let group=&state["workflow"]["groups"][gi];
    let (order,_) = context(state,shipments[0])?;
    let recipient_ids=shipments.iter().map(|s|str_field(s,"recipientId"))
        .collect::<HashSet<_>>();
    let mut issues=super::issues::order_issues(order).into_iter()
        .filter(|i|!has_value(field(order,"confirmedAt"))
            ||str_field(i,"recipientId").is_empty()
            ||recipient_ids.contains(str_field(i,"recipientId")))
        .map(|mut issue|{
            let _=set(&mut issue,"groupId",json!(group_id));issue
        }).collect::<Vec<_>>();
    // Historical reference validation runs for ALL original recipients,
    // including those moved to another operational group.
    for row in rows(field(order,"recipients")){
        for item in rows(field(row,"items")){
            let pid=str_field(item,"productId");
            if pid.is_empty(){continue;}
            let problem=sale_problem(historical_product(state,pid,str_field(item,"variantId")));
            if !problem.is_empty(){
                issues.push(operational(order,Some(row),group_id,"SALE_STATUS",
                    format!("{} / {} — 판매 상태 확인 필요",str_field(item,"name"),problem),
                    1,"product"));
            }
        }
    }
    let company=["DEALER","RETAIL"].contains(&str_field(order,"orderType"));
    if sender_field(order,state,"name").trim().is_empty(){
        issues.push(operational(order,None,group_id,"SENDER_NAME",
            if company{"설정의 반도스탠드 상호명을 확인하세요"}else{"송하인 거래처명을 확인하세요"}.into(),1,"client"));
    }
    if sender_field(order,state,"address").trim().is_empty(){
        issues.push(operational(order,None,group_id,"SENDER_ADDRESS",
            if company{"설정의 반도스탠드 주소를 등록하세요"}else{"송하인 거래처 주소를 확인하세요"}.into(),1,"client"));
    }
    let phone=sender_field(order,state,"phone");
    let mobile=sender_field(order,state,"mobile");
    if (if !phone.is_empty(){phone}else{mobile}).trim().is_empty(){
        issues.push(operational(order,None,group_id,"SENDER_CONTACT",
            if company{"설정의 반도스탠드 연락처를 등록하세요"}else{"송하인 거래처 연락처를 확인하세요"}.into(),1,"client"));
    }
    for ship in &shipments{
        let (_o,row)=context(state,ship)?;
        for item in rows(field(row,"items")){
            let pid=str_field(item,"productId");
            let vid=str_field(item,"variantId");
            if pid.is_empty()||vid.is_empty()||has_value(field(order,"confirmedAt")){continue;}
            let valid=rows(field(state,"products")).iter().any(|p|
                str_field(p,"id")==pid&&!has_value(field(p,"deletedAt"))&&
                field(p,"active").as_bool()!=Some(false)&&
                !has_value(field(p,"supersededBy"))&&
                rows(field(p,"variants")).iter().any(|v|str_field(v,"id")==vid));
            if !valid&&!issues.iter().any(|i|
                str_field(i,"itemId")==str_field(item,"id")&&str_field(i,"kind")=="MODEL"){
                let mut issue=operational(order,Some(row),group_id,"MODEL",
                    "등록된 상품과 옵션을 확인하세요".into(),1,"product");
                set(&mut issue,"itemId",field(item,"id").clone())?;
                issues.push(issue);
            }
        }
        if rows(field(row,"items")).iter().any(|item|
            !["STORE","FACTORY"].contains(&str_field(item,"origin"))){
            issues.push(operational(order,Some(row),group_id,"ORIGIN",
                "발송지를 확인하세요".into(),1,"product"));
        }
        if w::fee_total(ship,row,order).is_none() &&
            !issues.iter().any(|i|str_field(i,"recipientId")==str_field(row,"id")&&
                has_value(field(i,"itemId"))&&str_field(i,"severity")=="ACTION"&&
                ["MODEL","MODEL_CHOICE","ALIAS_CONFLICT","QUANTITY_LINK",
                    "QUANTITY_INVALID"].contains(&str_field(i,"kind"))){
            issues.push(operational(order,Some(row),group_id,"FREIGHT",
                "배송 운임을 확인하세요".into(),2,"freight"));
        }
    }
    if str_field(order,"orderType")=="RETAIL"{
        issues.retain(|i|!["PRICE","FREIGHT","SENDER_NAME","SENDER_ADDRESS",
            "SENDER_CONTACT"].contains(&str_field(i,"kind")));
        return Ok(issues);
    }
    let client=w::party(state,order).ok_or("배송 건의 발주서 / 수취인 / 거래처 연결을 확인하세요.")?;
    let account=w::account_for(state,group,order,client);
    if account.is_none_or(|a|["bank","number","holder"].iter().any(|key|
        str_field(a,key).trim().is_empty())){
        issues.push(operational(order,None,group_id,"ACCOUNT",
            "입금 계좌를 등록 / 선택하세요".into(),3,"account"));
    }
    if flag(group,"needsNotice"){
        issues.push(operational(order,None,group_id,"NOTICE",
            "변경된 금액 / 계좌 재안내 필요".into(),3,"account"));
    }
    Ok(issues)
}
fn won(value:Option<i64>)->String{
    let Some(value)=value else{return "확인 필요".into()};
    let chars=value.to_string();
    let parts=chars.chars().rev().enumerate().map(|(i,ch)|
        if i>0&&i%3==0{format!(",{ch}")}else{ch.to_string()})
        .collect::<String>().chars().rev().collect::<String>();
    format!("{parts}원")
}
pub(super) fn stage_issues(state:&Value,group_id:&str,next:i64)->Result<Vec<String>,String>{
    let (_,ships)=active_shipments(state,group_id)?;
    let (first_order,_) = context(state,ships[0])?;
    // orderParty in TypeScript synthesizes the house client for a retail
    // order even if it has no dealer ID and no client snapshot.
    let retail_company=json!({"payment":"POSTPAID"});
    let client=w::party(state,first_order).or_else(||{
        (str_field(first_order,"orderType")=="RETAIL").then_some(&retail_company)
    }).ok_or("배송 건의 발주서 / 수취인 / 거래처 연결을 확인하세요.")?;
    let wf_issues=workflow_issues(state,group_id)?;
    let mut messages=Vec::new();
    for issue in wf_issues {
        if str_field(&issue,"severity")!="ACTION"||
            field(&issue,"blockingStage").as_i64().unwrap_or(i64::MAX)>next {continue;}
        let ship=ships.iter().copied().find(|s|
            str_field(s,"recipientId")==str_field(&issue,"recipientId"))
            .unwrap_or(ships[0]);
        let (_,row)=context(state,ship)?;
        messages.push(format!("{}: {}",if str_field(row,"name").is_empty(){"수취인"}
            else{str_field(row,"name")},str_field(&issue,"title")));
    }
    for ship in ships {
        let (order,row)=context(state,ship)?;
        let name=if str_field(row,"name").is_empty(){"수취인"}else{str_field(row,"name")};
        let prefix=format!("{name}: ");
        if str_field(order,"orderType")!="RETAIL"{
            if next>=2&&field(&w::shipment_totals(state,str_field(ship,"id"))?,"total").is_null()
                &&messages.is_empty(){
                messages.push(format!("{prefix}청구액 미확정"));
            }
            if next>=3&&field(ship,"step").as_i64().unwrap_or(0)<2&&
                w::shipment_freight_code(order,row)!="020"{
                messages.push(format!("{prefix}운임 적용 필요"));
            }
            if next>=4{
                if field(ship,"step").as_i64().unwrap_or(0)<3{
                    messages.push(format!("{prefix}계좌 안내 완료 필요"));
                }
                if str_field(client,"payment")=="PREPAID"&&!flag(ship,"legacyApproval"){
                    let due=w::payment_due(state,ship,order,client)?;
                    if due!=Some(0){
                        messages.push(format!("{prefix}입금 부족 {}",won(due)));
                    }
                }
            }
        }
        for item in rows(field(row,"items")){
            let pid=str_field(item,"productId");
            if pid.is_empty(){continue;}
            let problem=sale_problem(historical_product(state,pid,str_field(item,"variantId")));
            if !problem.is_empty(){
                messages.push(format!("{name}: {} / {problem} — 판매 상태 확인 필요",
                    str_field(item,"name")));
            }
        }
    }
    let mut seen=HashSet::new();
    Ok(messages.into_iter().filter(|m|seen.insert(m.clone())).collect())
}
