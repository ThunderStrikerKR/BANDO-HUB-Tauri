//! Factory-reply XLSX business row validation, shipment matching and audit.
//! Source oracles: src/factory-reply-workbook.ts and src/factory-replies.ts.
//! ExcelJS remains an XLSX cell reader; this Rust module owns all decisions.
//! Pure computations do not write SQLite. The caller commits a fresh,
//! revision-checked state once through the existing Tauri persistence layer.
use serde_json::{json, Value};
use std::collections::{HashMap,HashSet};
use unicode_normalization::UnicodeNormalization;

fn field<'a>(v:&'a Value, k:&str)->&'a Value { v.get(k).unwrap_or(&Value::Null) }
fn s<'a>(v:&'a Value,k:&str)->&'a str { field(v,k).as_str().unwrap_or("") }
fn rows<'a>(v:&'a Value,k:&str)->&'a [Value] {
    field(v,k).as_array().map(Vec::as_slice).unwrap_or(&[])
}
fn valid_tracking(text:&str)->bool {
    (8..=30).contains(&text.len()) && text.bytes().all(|b|b.is_ascii_digit())
}
fn normalized(text:&str)->String {
    text.nfkc().filter(|c|!c.is_whitespace() && !"(),.-[]".contains(*c))
        .flat_map(char::to_lowercase).collect()
}
fn parse_freight(input:&str)->Option<i64>{
    if input.is_empty(){return None}
    let groups=input.split(',').collect::<Vec<_>>();
    let valid=if groups.len()==1 {
        groups[0].bytes().all(|c|c.is_ascii_digit())
    }else{
        (1..=3).contains(&groups[0].len())
            && groups[0].bytes().all(|c|c.is_ascii_digit())
            && groups.iter().skip(1).all(|g|g.len()==3 && g.bytes().all(|c|c.is_ascii_digit()))
    };
    if !valid {return None}
    input.replace(',',"").parse::<i64>().ok()
        .filter(|n|(0..=9_007_199_254_740_991).contains(n))
}
fn row_matches(row:&Value,queue:&Value)->bool{
    let recipient=field(field(queue,"snapshot"),"recipient");
    let name=s(row,"name");
    let address=s(row,"address");
    if normalized(name)!=normalized(s(recipient,"name"))
        || normalized(address)!=normalized(s(recipient,"address")){return false}
    rows(row,"contacts").iter().filter_map(Value::as_str).any(|contact|{
        ["phone","mobile"].iter().any(|key|{
            let saved=s(recipient,key);
            !saved.is_empty() && normalized(saved)==normalized(contact)
        })
    })
}
fn actual(ship:&Value,recipient:&Value)->Value {
    match field(ship,"actualFreight").as_object().and_then(|m|m.get("FACTORY")){
        Some(value)=>value.clone(),
        None=>field(recipient,"actualFreight").clone(),
    }
}
fn actor(state:&Value)->String {
    let name=s(field(state,"settings"),"operatorName");
    if name.is_empty(){"직원".into()}else{name.to_string()}
}
fn add_event(state:&mut Value,event:Value)->Result<(),String>{
    state["workflow"]["events"].as_array_mut()
        .ok_or("공장 회신 감사 이력 목록이 없습니다.")?.push(event);
    Ok(())
}
fn audit_id(payload:&Value,key:&str,index:usize)->String {
    rows(payload,key).get(index).and_then(Value::as_str)
        .unwrap_or("preview-only").to_string()
}
fn connect(input:&Value,source:&Value,approve:bool,context:&Value)->Result<Value,String>{
    let reply_id=s(source,"id");
    if rows(input,"factoryReplies").iter().any(|r|s(r,"id")==reply_id){
        return Ok(input.clone())
    }
    let mut next=input.clone();
    let mut reply=source.clone();
    let count=rows(&reply,"rows").len();
    let mut claimed=HashSet::<String>::new();
    for index in 0..count {
        let current=reply["rows"][index].clone();
        if !s(&current,"issue").is_empty(){continue}
        let valid=!s(&current,"name").is_empty() && !s(&current,"address").is_empty()
            && !rows(&current,"contacts").is_empty()
            && valid_tracking(s(&current,"tracking"))
            && field(&current,"actual").as_i64().is_some_and(|n|
                (0..=9_007_199_254_740_991).contains(&n));
        if !valid{
            reply["rows"][index]["issue"]=json!("필수 배송정보 / Q열 운송장 / 실제 운임 확인 필요");
            continue
        }
        let candidates=rows(field(&next,"workflow"),"queue").iter()
            .filter(|q|s(q,"origin")=="FACTORY" && s(q,"status")=="EXPORTED"
                && !field(q,"snapshot").is_null() && row_matches(&current,q))
            .collect::<Vec<_>>();
        let mut ids=Vec::<String>::new();
        for q in &candidates {
            let id=s(q,"shipmentId").to_string();
            if !ids.contains(&id){ids.push(id)}
        }
        if ids.len()!=1{
            reply["rows"][index]["issue"]=json!(if ids.is_empty(){
                "일치하는 공장 발송 배송 건이 없습니다."
            }else{
                "배송 건이 여러 개입니다. 직원 확인 필요"
            });
            continue
        }
        let shipment_id=ids[0].clone();
        let ship=rows(field(&next,"workflow"),"shipments").iter()
            .find(|v|s(v,"id")==shipment_id)
            .ok_or("공장 회신과 연결된 배송 건을 찾지 못했습니다.")?.clone();
        let queue=candidates.iter().find(|q|s(q,"shipmentId")==shipment_id)
            .ok_or("회신 목록의 배송 건이 없습니다.")?;
        let recipient=field(field(queue,"snapshot"),"recipient");
        reply["rows"][index]["shipmentId"]=json!(shipment_id);
        reply["rows"][index]["orderId"]=field(&ship,"orderId").clone();
        if !claimed.insert(shipment_id.clone()){
            reply["rows"][index]["issue"]=json!("한 파일에 동일 배송 건 중복 행");
            continue
        }
        if rows(field(&next,"workflow"),"shipments").iter().any(|v|
            s(v,"id")!=shipment_id && s(field(v,"tracking"),"FACTORY")==s(&current,"tracking")){
            reply["rows"][index]["issue"]=json!("운송장번호가 다른 배송 건에 이미 연결되어 있습니다.");
            continue
        }
        let prev_tracking=s(field(&ship,"tracking"),"FACTORY");
        let prev_actual=actual(&ship,recipient);
        let wanted=field(&current,"actual");
        if !prev_tracking.is_empty() && prev_tracking==s(&current,"tracking")
            && !prev_actual.is_null() && &prev_actual==wanted{
            reply["rows"][index]["applied"]=json!(true);
            continue
        }
        if !approve && ((!prev_tracking.is_empty() && prev_tracking!=s(&current,"tracking"))
            || (!prev_actual.is_null() && &prev_actual!=wanted)){
            reply["rows"][index]["issue"]=json!("기존 송장 / 실제 운임과 충돌합니다. 직원 확인 필요");
            continue
        }
        // recordActualFreight() only accepts an existing origin of the original
        // order. Keep its independent audit event before the reply event.
        let order=rows(&next,"orders").iter()
            .find(|o|s(o,"id")==s(&ship,"orderId"))
            .ok_or("실제 출고지와 배송 건을 확인하세요.")?;
        let found=rows(order,"recipients").iter().any(|r|
            s(r,"id")==s(&ship,"recipientId")
                && rows(r,"items").iter().any(|i|s(i,"origin")=="FACTORY"));
        if !found{return Err("실제 출고지와 배송 건을 확인하세요.".into())}
        if prev_actual!=*wanted{
            let at=s(context,"freightAt");
            let freight_actor=actor(&next);
            add_event(&mut next,json!({
                "id":audit_id(context,"freightEventIds",index),
                "at":at,"actor":freight_actor,"action":"실제 출고 운임 입력",
                "shipmentIds":[shipment_id],"before":prev_actual,
                "after":{"origin":"FACTORY","amount":wanted}
            }))?;
        }
        let shipment=next["workflow"]["shipments"].as_array_mut()
            .ok_or("공장 회신 배송 건이 없습니다.")?.iter_mut()
            .find(|v|s(v,"id")==shipment_id)
            .ok_or("회신할 배송 건이 없습니다.")?;
        if !field(shipment,"actualFreight").is_object(){
            shipment["actualFreight"]=json!({});
        }
        shipment["actualFreight"]["FACTORY"]=wanted.clone();
        if !field(shipment,"tracking").is_object(){
            shipment["tracking"]=json!({});
        }
        shipment["tracking"]["FACTORY"]=field(&current,"tracking").clone();
        let reply_action=if !prev_tracking.is_empty() && prev_tracking!=s(&current,"tracking") {
            "공장 송장 / 운임 정정"
        }else{"공장 회신 반영"};
        add_event(&mut next,json!({
            "id":audit_id(context,"replyEventIds",index),
            "at":field(&reply,"at"),
            "actor":if s(&reply,"actor").is_empty(){"공장 회신 Excel"}else{s(&reply,"actor")},
            "action":reply_action,"shipmentIds":[shipment_id],
            "before":{"tracking":if prev_tracking.is_empty(){Value::Null}else{json!(prev_tracking)},
                      "actual":prev_actual},
            "after":{"tracking":field(&current,"tracking"),"actual":wanted,"fileId":reply_id}
        }))?;
        reply["rows"][index]["applied"]=json!(true);
    }
    let rows=rows(&reply,"rows");
    let applied=rows.iter().filter(|r|field(r,"applied")==true).count();
    let held=rows.len()-applied;
    reply["status"]=json!(if !s(&reply,"error").is_empty() || held>0{
        if applied>0{"PARTIAL"}else{"REVIEW"}
    }else{"APPLIED"});
    if !field(&next,"factoryReplies").is_array(){next["factoryReplies"]=json!([])}
    next["factoryReplies"].as_array_mut().ok_or("공장 회신 이력 오류")?.push(reply);
    Ok(next)
}
fn preview(state:&Value,reply:&Value)->Result<Value,String>{
    if rows(state,"factoryReplies").iter().any(|r|s(r,"id")==s(reply,"id")){
        return Err("이미 등록된 동일 회신 파일입니다. 회신 이력에서 확인하세요.".into())
    }
    let next=connect(state,reply,false,&Value::Null)?;
    let matched=rows(&next,"factoryReplies").last()
        .ok_or("공장 회신 미리보기를 생성할 수 없습니다.")?;
    let applied=rows(matched,"rows").iter().filter(|r|field(r,"applied")==true).count();
    let held=rows(matched,"rows").len()-applied;
    Ok(json!({
        "revision":field(state,"revision").as_i64().unwrap_or(0),
        "reply":reply,
        "rows":field(matched,"rows"),
        "applied":applied,"held":held,"status":field(matched,"status")
    }))
}
fn analyze(payload:&Value)->Result<Value,String>{
    let state=field(payload,"state");
    let count=field(payload,"sourceRowCount").as_i64()
        .ok_or("공장 회신 Excel 행 수가 없습니다.")?;
    if count>1000{return Err("공장 회신은 한 번에 최대 1,000행을 처리합니다.".into())}
    let mut parsed=Vec::new();
    for source in rows(payload,"sourceRows"){
        let n=field(source,"row").as_i64().ok_or("공장 회신 Excel 행 번호 오류")?;
        if n<2 {return Err("공장 회신 Excel 행 번호 오류".into())}
        if field(source,"reservedJ")==true{
            return Err(format!("{n}행: 표준 양식의 J열은 공백이어야 합니다."))
        }
        if field(source,"extraAfterQ")==true{
            return Err(format!("{n}행: Q열 뒤의 추가 데이터는 허용하지 않습니다."))
        }
        let name=s(source,"name");
        let address=s(source,"address");
        let phone=s(source,"phone");
        let mobile=s(source,"mobile");
        let raw_freight=s(source,"rawFreight");
        let raw_tracking=s(source,"tracking");
        if [name,address,phone,mobile,raw_freight,raw_tracking].iter().all(|t|t.is_empty()){continue}
        if field(source,"trackingNumeric")==true{
            return Err(format!("{n}행: 운송장번호가 숫자로 저장되었습니다. 앞자리 0을 보호하려면 텍스트 셀로 입력하세요."))
        }
        let tracking=raw_tracking.chars()
            .filter(|c|*c!='-'&&!c.is_whitespace()).collect::<String>();
        let freight=parse_freight(raw_freight);
        let contacts=[phone,mobile].into_iter().filter(|v|!v.is_empty())
            .collect::<Vec<_>>();
        let issue=if name.is_empty()||address.is_empty()||contacts.is_empty(){
            Some("수하인 이름, 주소 또는 연락처 누락")
        }else if !valid_tracking(&tracking){
            Some("Q열 운송장번호가 없거나 올바르지 않습니다.")
        }else if freight.is_none(){
            Some("G열 실제 택배운임은 0 이상의 정수로 입력하세요.")
        }else{None};
        let mut row=json!({"row":n,"name":name,"address":address,
            "contacts":contacts,"tracking":tracking,"actual":freight});
        if let Some(issue)=issue{row["issue"]=json!(issue)}
        parsed.push(row);
    }
    if parsed.is_empty(){return Err("회신 파일에 처리할 배송 행이 없습니다.".into())}
    if parsed.iter().all(|r|s(r,"tracking").is_empty()){
        return Err("로젠 회신 양식 불일치: Q열 운송장번호 데이터가 없습니다.".into())
    }
    let mut counts=HashMap::new();
    for row in &parsed {
        let tracking=s(row,"tracking");
        if !tracking.is_empty(){*counts.entry(tracking.to_string()).or_insert(0usize)+=1;}
    }
    for row in &mut parsed {
        let tracking=s(row,"tracking");
        if !tracking.is_empty() && counts.get(tracking).copied().unwrap_or(0)>1{
            row["issue"]=json!("같은 회신 파일에 운송장번호가 중복됩니다.");
        }
    }
    let reply=json!({
        "id":field(payload,"id"),
        "filename":field(payload,"filename"),
        "businessDate":field(payload,"businessDate"),
        "at":field(payload,"at"),
        "actor":field(payload,"actor"),
        "status":"REVIEW","rows":parsed
    });
    preview(state,&reply)
}
fn apply(payload:&Value)->Result<Value,String>{
    let state=payload.get("state").ok_or("공장 회신 저장 상태 누락")?;
    let reviewed=payload.get("preview").ok_or("공장 회신 미리보기 누락")?;
    if field(state,"revision").as_i64().unwrap_or(0)!=field(reviewed,"revision").as_i64().unwrap_or(0){
        return Err("미리보기 이후 DB가 수정되었습니다. 공장 회신 파일을 다시 검토하세요.".into())
    }
    let reply=field(reviewed,"reply");
    let current=preview(state,reply)?;
    for key in ["rows","applied","held","status"] {
        if field(&current,key)!=field(reviewed,key){
            return Err("공장 회신 연결 결과가 달라졌습니다. 최신 데이터를 다시 검토하세요.".into())
        }
    }
    let next=connect(state,reply,false,payload)?;
    Ok(json!({"next":next,"applied":field(&current,"applied"),"held":field(&current,"held")}))
}
pub(super) fn execute(operation:&str,payload:&Value)->Result<Value,String>{
    match operation {
        "analyze_factory_reply"=>analyze(payload),
        "preview_factory_reply"=>preview(
            payload.get("state").ok_or("공장 회신 상태 누락")?,
            payload.get("reply").ok_or("공장 회신 원본 누락")?
        ),
        "apply_factory_reply"=>apply(payload),
        _=>Err(format!("지원하지 않는 공장 회신 업무: {operation}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture()->Value{
        let recipient=json!({"id":"r1","name":"김수취","address":"서울 종로구 10",
            "phone":"010-1234-5678","mobile":"","actualFreight":null,
            "items":[{"id":"item","origin":"FACTORY"}]});
        json!({"revision":3,"factoryReplies":[],"settings":{"operatorName":"직원"},
            "orders":[{"id":"o1","recipients":[recipient.clone()]}],
            "workflow":{"shipments":[{"id":"s1","orderId":"o1","recipientId":"r1",
                "tracking":{},"actualFreight":{}}],
                "queue":[{"shipmentId":"s1","origin":"FACTORY","status":"EXPORTED",
                    "snapshot":{"recipient":recipient}}],
                "events":[]}})
    }
    fn input(state:Value,tracking:&str,freight:&str)->Value{
        json!({"state":state,"sourceRowCount":1,"sourceRows":[{
            "row":2,"name":"김수취","address":"서울 종로구 10",
            "phone":"010-1234-5678","mobile":"",
            "rawFreight":freight,"tracking":tracking,
            "trackingNumeric":false,"reservedJ":false,"extraAfterQ":false
        }],"id":"factory-reply-test","filename":"reply.xlsx",
            "businessDate":"2026-11-13","at":"2026-11-13T10:00:00Z",
            "actor":"직원"})
    }
    #[test] fn valid_reply_matches_and_audits(){
        let s=fixture();
        let preview=analyze(&input(s.clone(),"001234567890","4,000")).unwrap();
        assert_eq!(preview["applied"],1);
        let result=apply(&json!({"state":s,"preview":preview,"freightAt":"2026-11-13T10:00:00Z",
            "freightEventIds":["f1"],"replyEventIds":["r1"]})).unwrap();
        assert_eq!(result["next"]["workflow"]["shipments"][0]["tracking"]["FACTORY"],
            "001234567890");
        assert_eq!(result["next"]["workflow"]["shipments"][0]["actualFreight"]["FACTORY"],4000);
        assert_eq!(result["next"]["workflow"]["events"].as_array().unwrap().len(),2);
    }
    #[test] fn mismatched_address_and_duplicate_number_never_apply(){
        let s=fixture();
        let mut req=input(s.clone(),"001234567890","4000");
        req["sourceRows"][0]["address"]=json!("서울 다른 구 22");
        assert_eq!(analyze(&req).unwrap()["held"],1);
        let mut duplicate=input(s,"001234567890","4000");
        let another=duplicate["sourceRows"][0].clone();
        duplicate["sourceRows"].as_array_mut().unwrap().push(another);
        duplicate["sourceRowCount"]=json!(2);
        assert_eq!(analyze(&duplicate).unwrap()["held"],2);
    }
    #[test] fn conflict_and_numeric_tracking_are_refused(){
        let mut s=fixture();
        s["workflow"]["shipments"][0]["tracking"]["FACTORY"]=json!("009988776655");
        assert_eq!(analyze(&input(s,"001234567890","4000")).unwrap()["held"],1);
        let mut req=input(fixture(),"001234567890","4000");
        req["sourceRows"][0]["trackingNumeric"]=json!(true);
        assert!(analyze(&req).unwrap_err().contains("숫자"));
    }
    #[test] fn stale_or_tampered_preview_cannot_commit(){
        let s=fixture();
        let preview=analyze(&input(s.clone(),"001234567890","4000")).unwrap();
        let mut altered=preview.clone();
        altered["rows"][0]["tracking"]=json!("009999999999");
        assert!(apply(&json!({"state":s.clone(),"preview":altered})).unwrap_err().contains("연결 결과"));
        let mut current=s;
        current["revision"]=json!(4);
        assert!(apply(&json!({"state":current,"preview":preview})).unwrap_err().contains("DB"));
    }
}
