//! Automatic message template edit validation.
 //! Direct port of src/automatic-message-templates.ts::validateAutomaticMessageTemplates.
 //! This path owns the save eligibility decision, not UI preview layout.
use serde_json::{json,Value};
use std::collections::HashSet;
use regex::Regex;
use super::{field,req,rows};

fn definition(key:&str)->Option<(&'static str,&'static [&'static str],&'static [&'static str])>{
    Some(match key{
      "recipientName"=>("수취인 이름 누락",&[],&[]),
      "addressMissing"=>("배송지 주소 누락",&["수취인"],&["수취인"]),
      "addressDetail"=>("상세주소 부족",&["수취인"],&["수취인"]),
      "contactMissing"=>("수취인 연락처 누락",&["수취인"],&["수취인"]),
      "quantityMissing"=>("주문 수량 확인",&["상품명"],&["상품명"]),
      "modelMissing"=>("상품 모델 확인",&["상품명"],&["상품명"]),
      "modelConfirm"=>("추천 상품 확인",&["상품명"],&["상품명"]),
      "requestRecipient"=>("확인 항목 묶음",&["번호","수취인","확인항목"],&["수취인","확인항목"]),
      "requestClosing"=>("확인 요청 마무리",&[],&[]),
      "colorDefault"=>("대표색상 통보",&["색상","상품명"],&["색상"]),
      "modelRepresentative"=>("대표모델 선택 통보",&["상품명"],&["상품명"]),
      "quantityOne"=>("수량 1개 잠정 안내",&["수취인","상품명"],&["수취인","상품명"]),
      "paymentGreeting"=>("입금 안내 인사말",&[],&[]),
      "paymentItem"=>("상품별 금액 표시",&["상품명","수량","금액"],&["상품명","수량","금액"]),
      "paymentFreight"=>("운임 안내",&["운임"],&["운임"]),
      "paymentVat"=>("부가세 안내",&["부가세"],&["부가세"]),
      "paymentTotal"=>("총 청구액 안내",&["합계"],&["합계"]),
      "paymentAccount"=>("입금 계좌 안내",&["은행명","계좌번호","예금주"],&["은행명","계좌번호","예금주"]),
      "optionsIntro"=>("주문 내용 확인 시작",&[],&[]),
      "optionsClosing"=>("주문 확인 마무리",&[],&[]),
      _=>return None,
    })
}
pub(super) fn validate(payload:&Value)->Result<Value,String>{
    let edits=req(payload,"edits")?.as_object()
        .ok_or("자동 메시지 편집 형식이 올바르지 않습니다.")?;
    if edits.len()>20 {
        return Err("등록할 수 없는 자동 메시지 유형이 포함됐습니다.".into());
    }
    let tokens=Regex::new(r"\{([^{}]*)\}").expect("literal");
    let mut keys=Vec::<String>::new();
    let mut seen=HashSet::new();
    for key in rows(field(payload,"orderedKeys")).iter().filter_map(Value::as_str){
        if edits.contains_key(key)&&seen.insert(key.to_string()){
            keys.push(key.to_string());
        }
    }
    for key in edits.keys(){
        if seen.insert(key.clone()){keys.push(key.clone());}
    }
    for key in keys{
        let Some((label,allowed,required))=definition(&key) else {
            return Err(format!("지원하지 않는 자동 메시지 유형입니다: {key}"));
        };
        let Some(text)=edits.get(&key).and_then(Value::as_str) else {
            return Err("자동 메시지는 1자 이상, 2000자 이하로 입력하세요.".into());
        };
        if text.trim().is_empty() || text.encode_utf16().count()>2000 {
            return Err("자동 메시지는 1자 이상, 2000자 이하로 입력하세요.".into());
        }
        for matched in tokens.captures_iter(text){
            let name=matched.get(1).map(|v|v.as_str()).unwrap_or("");
            if !allowed.contains(&name){
                return Err(format!("{label}: 지원하지 않는 변수 {{{name}}}입니다."));
            }
        }
        let without=tokens.replace_all(text,"");
        if without.contains('{')||without.contains('}'){
            return Err(format!("{label}: 변수 괄호를 확인하세요."));
        }
        for name in required {
            if !text.contains(&format!("{{{name}}}")){
                return Err(format!("{label}: {{{name}}} 변수를 삭제할 수 없습니다."));
            }
        }
    }
    Ok(json!({"valid":true}))
}

// Provisional, product-scoped notice validation matches the existing TS
// settings validator. Unicode scalar count matches JS [...text].length.
pub(super) fn validate_provisional(payload:&Value)->Result<Value,String>{
    let state=req(payload,"state")?;
    let notices=field(field(state,"settings"),"provisionalProductNotices");
    if notices.is_null() {return Ok(json!({"valid":true}));}
    let notices=notices.as_object()
        .ok_or("상품별 잠정 안내문 형식이 올바르지 않습니다.")?;
    if notices.len()>5000 {
        return Err("잠정 상품 안내문 등록 한도를 초과했습니다.".into())
    }
    let ids=rows(field(state,"products")).iter()
        .map(|p|field(p,"id").as_str().unwrap_or(""))
        .collect::<HashSet<_>>();
    for (id,value) in notices{
        if !ids.contains(id.as_str()){
            return Err("등록된 상품에만 안내문을 연결할 수 있습니다.".into())
        }
        let valid=value.as_str().is_some_and(|v|!v.trim().is_empty()&&v.chars().count()<=2000);
        if !valid{
            return Err("안내문은 1자 이상 2000자 이하로 입력하세요.".into())
        }
    }
    Ok(json!({"valid":true}))
}

#[cfg(test)]
mod tests{
    use super::*;
    #[test] fn provisional_notices_check_registered_ids_and_unicode_scalars(){
        let state=json!({"products":[{"id":"p1"}],
            "settings":{"provisionalProductNotices":{"p1":"😀".repeat(2000)}}});
        assert_eq!(validate_provisional(&json!({"state":state})).unwrap()["valid"],true);
        let invalid=json!({"products":[{"id":"p1"}],
            "settings":{"provisionalProductNotices":{"p2":"문의"}}});
        assert!(validate_provisional(&json!({"state":invalid}))
            .unwrap_err().contains("등록된 상품"));
        let too_long=json!({"products":[{"id":"p1"}],
            "settings":{"provisionalProductNotices":{"p1":"가".repeat(2001)}}});
        assert!(validate_provisional(&json!({"state":too_long}))
            .unwrap_err().contains("2000자"));
    }
    #[test] fn validates_mandatory_vars_and_broken_braces(){
        assert_eq!(validate(&json!({"edits":{"addressMissing":"{수취인}님 주소 확인"}}))
            .unwrap()["valid"],true);
        assert!(validate(&json!({"edits":{"addressMissing":"주소 확인"}}))
            .unwrap_err().contains("삭제할 수 없습니다"));
        assert!(validate(&json!({"edits":{"addressMissing":"{수취인}님 {오류}"}}))
            .unwrap_err().contains("지원하지 않는 변수"));
        assert!(validate(&json!({"edits":{"addressMissing":"{수취인}님 {미완성"}}))
            .unwrap_err().contains("변수 괄호"));
    }
    #[test] fn unicode_length_matches_javascript_utf16(){
        let long="😀".repeat(1001);
        assert!(validate(&json!({"edits":{"recipientName":long}}))
            .unwrap_err().contains("2000자"));
    }
}
