//! Kakao window title → dealer identity rules.
//! Oracle: src/title-clients.ts; window docking remains a separate native service.
use serde_json::{json,Value};
use unicode_normalization::UnicodeNormalization;

fn s<'a>(v:&'a Value,key:&str)->&'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}
fn list<'a>(v:&'a Value,key:&str)->&'a [Value] {
    v.get(key).and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}
fn rows(v:&Value)->&[Value] {
    v.as_array().map(Vec::as_slice).unwrap_or(&[])
}
fn truthy(v:Option<&Value>)->bool {
    match v {
        None|Some(Value::Null)|Some(Value::Bool(false))=>false,
        Some(Value::String(s)) if s.is_empty()=>false,
        Some(Value::Number(n)) if n.as_i64()==Some(0)=>false,
        _=>true,
    }
}
fn key(value:&str)->String {
    // JS: normalize("NFKC").trim().toLocaleLowerCase().replace(/\s+/g," ")
    value.nfkc().flat_map(char::to_lowercase).collect::<String>()
        .trim().split_whitespace().collect::<Vec<_>>().join(" ")
}
fn eligible_client(client:&Value,id:&str,allow_inactive:bool)->bool {
    s(client,"id")==id && !truthy(client.get("deletedAt"))
        && (allow_inactive || client.get("active")!=Some(&Value::Bool(false)))
}
fn remembered(state:&Value,windows:&Value)->Option<String> {
    let chats=rows(windows).iter()
        .filter(|w|s(w,"kind")=="CHAT").collect::<Vec<_>>();
    if chats.len()!=1{return None}
    let k=key(s(chats[0],"title"));
    let entry=state.get("settings")?.get("kakaoTitleMappings")?.get(&k)?;
    if truthy(entry.get("ambiguous")) {return None}
    let id=s(entry,"clientId");
    if list(state,"clients").iter().any(|c|eligible_client(c,id,false)){
        Some(id.to_owned())
    }else{None}
}
fn remember(payload:&Value)->Result<Value,String> {
    let state=payload.get("state").ok_or("현재 거래처 데이터가 없습니다.")?;
    let windows=payload.get("windows").ok_or("카카오톡 창 목록이 없습니다.")?;
    let handle=s(payload,"handle");
    let client_id=s(payload,"clientId");
    let chat=rows(windows).iter().find(|w|
        s(w,"kind")=="CHAT"&&s(w,"handle")==handle);
    if chat.is_none() ||
        !list(state,"clients").iter().any(|c|eligible_client(c,client_id,true)) {
        return Err("현재 대화창과 거래처를 선택하세요.".into());
    }
    let chat=chat.unwrap();
    let k=key(s(chat,"title"));
    let ambiguous=rows(windows).iter()
        .filter(|w|s(w,"kind")=="CHAT"&&key(s(w,"title"))==k).count()>1;
    let actor=payload.get("actor").and_then(Value::as_str).unwrap_or("");
    let now=payload.get("now").and_then(Value::as_str)
        .filter(|s|!s.is_empty()).ok_or("매핑 저장 시각이 없습니다.")?;
    let mut next=state.clone();
    let settings=next.get_mut("settings").and_then(Value::as_object_mut)
        .ok_or("거래처 설정이 없습니다.")?;
    let entries=settings.entry("kakaoTitleMappings").or_insert_with(||json!({}));
    if !entries.is_object(){*entries=json!({});}
    entries[k]=json!({"clientId":client_id,"updatedAt":now,
        "actor":actor,"ambiguous":ambiguous});
    Ok(json!({"state":next}))
}
pub(super) fn execute(operation:&str,payload:&Value)->Result<Value,String>{
    match operation {
        "remembered_title_client"=>{
            let state=payload.get("state").ok_or("현재 데이터가 없습니다.")?;
            let windows=payload.get("windows").unwrap_or(&Value::Null);
            Ok(json!({"clientId":remembered(state,windows)}))
        }
        "remember_title_client"=>remember(payload),
        _=>Err(format!("지원하지 않는 카카오 거래처 연결 업무: {operation}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unique_active_client_only_and_duplicate_window_requires_employee() {
        let state=json!({"clients":[{"id":"c1","name":"악기사","active":true}],
            "settings":{"kakaoTitleMappings":{"악기사":{"clientId":"c1","ambiguous":false}}}});
        let single=json!([{"kind":"CHAT","title":"악기사","handle":"1"}]);
        assert_eq!(remembered(&state,&single),Some("c1".into()));
        let multiple=json!([{"kind":"CHAT","title":"악기사","handle":"1"},
            {"kind":"CHAT","title":"악기사","handle":"2"}]);
        assert_eq!(remembered(&state,&multiple),None);
        let result=remember(&json!({"state":state,"windows":multiple,
            "handle":"1","clientId":"c1","actor":"직원",
            "now":"2026-11-15T00:00:00Z"})).unwrap();
        assert_eq!(result["state"]["settings"]["kakaoTitleMappings"]["악기사"]["ambiguous"],true);
    }
}
