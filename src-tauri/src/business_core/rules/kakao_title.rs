//! KakaoTalk window-title/client association, ported from src/title-clients.ts.
//! Pure deterministic Rust projection and mutation. No clock or SQLite writes.
use serde_json::{json,Value};
use unicode_normalization::UnicodeNormalization;
use super::{field,req,required_str,rows,str_field};

fn title_key(raw:&str)->String {
    raw.nfkc().collect::<String>().trim().to_lowercase()
        .split_whitespace().collect::<Vec<_>>().join(" ")
}
fn chat<'a>(windows:&'a Value,handle:&str)->Option<&'a Value>{
    rows(windows).iter().find(|w|str_field(w,"kind")=="CHAT" && str_field(w,"handle")==handle)
}
fn valid_client(state:&Value,client_id:&str,require_active:bool)->bool {
    rows(field(state,"clients")).iter().any(|c|
        str_field(c,"id")==client_id && field(c,"deletedAt").is_null() &&
        (!require_active || field(c,"active").as_bool()!=Some(false)))
}
fn remembered(state:&Value,windows:&Value)->Value {
    let chats=rows(windows).iter().filter(|w|str_field(w,"kind")=="CHAT")
        .collect::<Vec<_>>();
    if chats.len()!=1 {return Value::Null;}
    let key=title_key(str_field(chats[0],"title"));
    let entry=field(field(field(state,"settings"),"kakaoTitleMappings"),&key);
    if entry.is_null() || field(entry,"ambiguous").as_bool()==Some(true) {
        return Value::Null;
    }
    let client_id=str_field(entry,"clientId");
    if client_id.is_empty() || !valid_client(state,client_id,true) {
        return Value::Null;
    }
    json!(client_id)
}
fn remember(payload:&Value)->Result<Value,String>{
    let original=req(payload,"state")?;
    let windows=req(payload,"windows")?;
    let handle=required_str(payload,"handle")?;
    let client_id=required_str(payload,"clientId")?;
    let actor=required_str(payload,"actor")?;
    let now=required_str(payload,"now")?;
    let w=chat(windows,handle);
    if w.is_none() || !valid_client(original,client_id,false) {
        return Err("현재 대화창과 거래처를 선택하세요.".into());
    }
    let key=title_key(str_field(w.unwrap(),"title"));
    let duplicate=rows(windows).iter().filter(|w|
        str_field(w,"kind")=="CHAT" && title_key(str_field(w,"title"))==key).count()>1;
    let mut state=original.clone();
    let settings=state.get_mut("settings").and_then(Value::as_object_mut)
        .ok_or("설정 데이터가 없습니다.")?;
    if !settings.get("kakaoTitleMappings").is_some_and(Value::is_object){
        settings.insert("kakaoTitleMappings".into(),json!({}));
    }
    let mapping=settings.get_mut("kakaoTitleMappings")
        .and_then(Value::as_object_mut).ok_or("카카오톡 매핑 데이터가 올바르지 않습니다.")?;
    mapping.insert(key,json!({"clientId":client_id,"updatedAt":now,
        "actor":actor,"ambiguous":duplicate}));
    Ok(json!({"state":state}))
}
pub(super) fn execute(operation:&str,payload:&Value)->Result<Value,String>{
    match operation{
        "remember_kakao_title_client"=>remember(payload),
        "remembered_kakao_title_client"=>Ok(json!({"clientId":remembered(
            req(payload,"state")?,req(payload,"windows")?)})),
        _=>Err(format!("지원하지 않는 카카오톡 거래처 명령: {operation}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn normalization_and_duplicate_protection(){
        assert_eq!(title_key("  ＡＢ  가상  "), "ab 가상");
        let state=json!({"settings":{"kakaoTitleMappings":{"ab 가상":{
            "clientId":"c1","ambiguous":false}}},"clients":[{"id":"c1","name":"가상"}]});
        assert_eq!(remembered(&state,&json!([{"kind":"CHAT","title":"ＡＢ 가상","handle":"1"}])),json!("c1"));
        assert_eq!(remembered(&state,&json!([
            {"kind":"CHAT","title":"ＡＢ 가상","handle":"1"},
            {"kind":"CHAT","title":"ＡＢ 가상","handle":"2"}])),Value::Null);
    }
    #[test]
    fn recording_is_explicit_and_detects_identical_titles(){
        let state=json!({"settings":{},"clients":[{"id":"c1","name":"가상"}]});
        let windows=json!([
            {"kind":"CHAT","title":"별 악 사","handle":"1"},
            {"kind":"CHAT","title":"별  악 사","handle":"2"}]);
        let saved=remember(&json!({"state":state,"windows":windows,
            "handle":"1","clientId":"c1","actor":"담당",
            "now":"2026-11-15T00:00:00Z"})).unwrap();
        assert_eq!(saved["state"]["settings"]["kakaoTitleMappings"]["별 악 사"]["ambiguous"],true);
    }
}
