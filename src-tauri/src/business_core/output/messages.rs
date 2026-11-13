//! User-editable message templates and output assembly. Prices, taxes and
//! shipping values are supplied by the rules engine, never recalculated here.
use serde_json::{json, Value};
use std::collections::HashSet;

fn s<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}
fn list<'a>(v: &'a Value, key: &str) -> &'a [Value] {
    v.get(key).and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}
fn money(value: &Value) -> String {
    let Some(n) = value.as_i64() else { return "확인 필요".into() };
    let digits = n.unsigned_abs().to_string();
    let chunks: Vec<&str> = digits
        .as_bytes().rchunks(3).rev()
        .map(|part| std::str::from_utf8(part).unwrap_or(""))
        .collect();
    format!("{}{}원", if n < 0 { "-" } else { "" }, chunks.join(","))
}
fn template_default(key: &str) -> Option<(&'static str, &'static [&'static str])> {
    match key {
        "recipientName" => Some(("받으실 분의 성함을 알려주세요.", &[])),
        "addressMissing" => Some(("{수취인}님 배송지 주소 확인 부탁드려요.", &["수취인"])),
        "addressDetail" => Some(("{수취인}님 상세주소 확인 부탁드려요.", &["수취인"])),
        "contactMissing" => Some(("{수취인}님 연락처 확인 부탁드려요.", &["수취인"])),
        "quantityMissing" => Some(("{상품명} 수량을 확인 부탁드립니다.", &["상품명"])),
        "modelMissing" => Some(("{상품명}: 정확한 모델명을 확인해 주세요.", &["상품명"])),
        "modelConfirm" => Some(("{상품명} 상품으로 보내드리면 될까요?", &["상품명"])),
        "requestRecipient" => Some(("{번호}. {수취인}님: {확인항목}", &["수취인", "확인항목"])),
        "requestClosing" => Some(("위 내용 확인 부탁드립니다.", &[])),
        "colorDefault" => Some(("{색상}으로 보내드릴게요.", &["색상"])),
        "modelRepresentative" => Some(("{상품명} 모델로 보내드릴게요.", &["상품명"])),
        "quantityOne" => Some(("{수취인}님 {상품명} 상품은 수량을 1개로 보내드리겠습니다.", &["수취인", "상품명"])),
        "paymentGreeting" => Some(("안녕하세요.", &[])),
        "paymentItem" => Some(("{상품명} * {수량}개 : {금액}", &["상품명", "수량", "금액"])),
        "paymentFreight" => Some(("운임 : {운임}", &["운임"])),
        "paymentVat" => Some(("부가세 : {부가세}", &["부가세"])),
        "paymentTotal" => Some(("합계 : {합계} 입니다.", &["합계"])),
        "paymentAccount" => Some(("{은행명} {계좌번호} {예금주} 입니다.", &["은행명", "계좌번호", "예금주"])),
        "optionsIntro" => Some(("주문하신 내역 확인 부탁드립니다.", &[])),
        "optionsClosing" => Some(("주문 내용 확인 후 회신 부탁드립니다.", &[])),
        _ => None,
    }
}
// Customer-facing validation errors use the original TypeScript template labels.
fn template_label(key: &str) -> &str {
    match key {
        "recipientName" => "수취인 이름 누락",
        "addressMissing" => "배송지 주소 누락",
        "addressDetail" => "상세주소 부족",
        "contactMissing" => "수취인 연락처 누락",
        "quantityMissing" => "주문 수량 확인",
        "modelMissing" => "상품 모델 확인",
        "modelConfirm" => "추천 상품 확인",
        "requestRecipient" => "확인 항목 묶음",
        "requestClosing" => "확인 요청 마무리",
        "colorDefault" => "대표색상 통보",
        "modelRepresentative" => "대표모델 선택 통보",
        "quantityOne" => "수량 1개 잠정 안내",
        "paymentGreeting" => "입금 안내 인사말",
        "paymentItem" => "상품별 금액 표시",
        "paymentFreight" => "운임 안내",
        "paymentVat" => "부가세 안내",
        "paymentTotal" => "총 청구액 안내",
        "paymentAccount" => "입금 계좌 안내",
        "optionsIntro" => "주문 내용 확인 시작",
        "optionsClosing" => "주문 확인 마무리",
        _ => key,
    }
}
fn allowed_variables(key: &str) -> &'static [&'static str] {
    match key {
        "addressMissing" | "addressDetail" | "contactMissing" => &["수취인"],
        "quantityMissing" | "modelMissing" | "modelConfirm" | "modelRepresentative" => &["상품명"],
        "requestRecipient" => &["번호", "수취인", "확인항목"],
        "colorDefault" => &["색상", "상품명"],
        "quantityOne" => &["수취인", "상품명"],
        "paymentItem" => &["상품명", "수량", "금액"],
        "paymentFreight" => &["운임"],
        "paymentVat" => &["부가세"],
        "paymentTotal" => &["합계"],
        "paymentAccount" => &["은행명", "계좌번호", "예금주"],
        _ => &[],
    }
}
pub(super) fn validate_templates(settings: &Value) -> Result<(), String> {
    let edits = settings.get("automaticMessageTemplates").and_then(Value::as_object);
    let Some(edits) = edits else { return Ok(()) };
    if edits.len() > 20 {
        return Err("등록할 수 없는 자동 메시지 유형이 포함됐습니다.".into());
    }
    let re = regex::Regex::new(r"\{([^{}]*)\}").unwrap();
    for (key, value) in edits {
        let (_, required) = template_default(key)
            .ok_or_else(|| format!("지원하지 않는 자동 메시지 유형입니다: {}", key))?;
        let body = value.as_str().ok_or("자동 메시지는 1자 이상, 2000자 이하로 입력하세요.")?;
        if body.trim().is_empty() || body.encode_utf16().count() > 2000 {
            return Err("자동 메시지는 1자 이상, 2000자 이하로 입력하세요.".into());
        }
        for token in re.captures_iter(body) {
            if !allowed_variables(key).contains(&token.get(1).unwrap().as_str()) {
                return Err(format!("{}: 지원하지 않는 변수 {{{}}}입니다.", template_label(key), &token[1]));
            }
        }
        let without = re.replace_all(body, "");
        if without.contains('{') || without.contains('}') {
            return Err(format!("{}: 변수 괄호를 확인하세요.", template_label(key)));
        }
        for required_variable in required {
            if !body.contains(&format!("{{{}}}", required_variable)) {
                return Err(format!("{}: {{{}}} 변수를 삭제할 수 없습니다.", template_label(key), required_variable));
            }
        }
    }
    Ok(())
}
fn render(settings: &Value, key: &str, values: &Value) -> Result<String, String> {
    let (default, _) = template_default(key)
        .ok_or_else(|| format!("지원하지 않는 자동 메시지 유형입니다: {}", key))?;
    let body = settings.get("automaticMessageTemplates")
        .and_then(|v| v.get(key)).and_then(Value::as_str).unwrap_or(default);
    let re = regex::Regex::new(r"\{([^{}]+)\}").unwrap();
    Ok(re.replace_all(body, |captures: &regex::Captures<'_>| {
        values.get(&captures[1]).and_then(Value::as_str).unwrap_or("").to_owned()
    }).into_owned())
}
fn color_label(color: &str) -> &str {
    match color.trim().to_lowercase().as_str() {
        "black" | "검정" => "블랙",
        "gray" | "grey" | "회색" => "그레이",
        "brown" => "브라운",
        "white" | "흰색" => "화이트",
        "red" => "레드",
        "blue" => "블루",
        "gold" => "골드",
        "rose gold" => "로즈골드",
        "cosmo black" => "코스모블랙",
        "clear" => "클리어",
        "frost" | "frosted" => "프로스트",
        "silver" => "실버",
        "색상 미표기" => "",
        _ => color,
    }
}
fn customer_model(name: &str) -> String {
    let name = regex::Regex::new(r"^\[가상\]\s*").unwrap().replace(name, "");
    let raw = name.trim_start();
    let bytes = raw.as_bytes();
    let starts_bd = bytes.len() >= 2 && bytes[0].eq_ignore_ascii_case(&b'B') && bytes[1].eq_ignore_ascii_case(&b'D')
        && (bytes.len() == 2 || bytes[2].is_ascii_whitespace() || bytes[2].is_ascii_digit());
    if starts_bd {
        let rest = raw[2..].trim_start();
        return format!("BD {}", rest);
    }
    if raw.chars().next().is_some_and(|c| c.is_ascii_digit()) {
        return format!("BD {}", raw);
    }
    raw.to_owned()
}
fn url_is_official(url: &str) -> bool {
    let Ok(parsed) = url::Url::parse(url) else { return false };
    parsed.scheme() == "https"
        && matches!(parsed.host_str(), Some("bandostand.com" | "www.bandostand.com" | "bandomall.co.kr" | "www.bandomall.co.kr"))
        && parsed.path().starts_with("/product/")
}
fn default_color_notice(settings: &Value, item: &Value) -> Result<Option<String>, String> {
    let color = color_label(s(&item["appliedDefaultColor"], "color")).trim();
    if color.is_empty() { return Ok(None); }
    Ok(Some(render(settings, "colorDefault", &json!({"색상":color, "상품명":customer_model(s(item,"name"))}))?))
}
fn representative_notice(settings: &Value, item: &Value) -> Result<Option<String>, String> {
    let selection = &item["appliedRepresentativeModel"];
    if s(selection, "productId").is_empty() || s(selection, "productId") != s(item, "productId") {
        return Ok(None);
    }
    let name = s(selection, "productName").trim();
    if name.is_empty() { return Ok(None); }
    Ok(Some(render(settings, "modelRepresentative", &json!({"상품명":name}))?))
}
fn once(items: impl IntoIterator<Item=String>) -> Vec<String> {
    let mut seen = HashSet::new();
    items.into_iter().filter(|item| seen.insert(item.to_owned())).collect()
}
fn payment(payload: &Value, settings: &Value) -> Result<Value, String> {
    let recipients = payload.get("recipients").and_then(Value::as_array)
        .ok_or("입금 안내용 배송 건 정보가 없습니다.")?;
    if recipients.is_empty() { return Err("입금 안내용 배송 건 정보가 없습니다.".into()); }
    // The rules engine is responsible for every input amount, including mixed VAT.
    let total = payload.get("total").ok_or("계산된 청구 합계가 없습니다.")?;
    let mut parts = vec![render(settings, "paymentGreeting", &Value::Null)?, String::new()];
    let mut vat_flags = Vec::new();
    let mut provisional = Vec::new();
    let mut official_links = Vec::new();
    let mut quantity_messages = Vec::new();
    for recipient in recipients {
        let name = s(recipient, "name").trim();
        if !name.is_empty() { parts.push(format!("{}님", name)); }
        for item in list(recipient, "items") {
            let original = s(item, "name");
            let mut name_label = customer_model(original);
            if !item.get("colorNotRequired").and_then(Value::as_bool).unwrap_or(false) {
                let color = color_label(s(item, "color")).trim();
                if !color.is_empty() { name_label.push_str(&format!(" ({})", color)); }
            }
            let quantity = item.get("quantity").and_then(Value::as_i64)
                .map(|n| n.to_string()).unwrap_or("?".into());
            let amount = if item.get("amount").is_some_and(Value::is_number) {
                money(&item["amount"])
            } else if payload.get("clientSelected").and_then(Value::as_bool) == Some(false) {
                "거래처 선택 후 단가 적용".into()
            } else { "판매가 확인 필요".into() };
            parts.push(render(settings, "paymentItem", &json!({
                "상품명":name_label, "수량":quantity, "금액":amount
            }))?);
            if let Some(notice) = default_color_notice(settings, item)? { parts.push(notice); }
            let quantity_one = item.get("quantityApproval").and_then(|q| q.get("quantity"))
                .and_then(Value::as_i64) == Some(1)
                && item.get("quantity").and_then(Value::as_i64) == Some(1)
                && item.get("quantityConfirmed").and_then(Value::as_bool) == Some(false);
            if quantity_one {
                quantity_messages.push(render(settings, "quantityOne", &json!({
                    "수취인":if name.is_empty() { "수취인" } else { name },
                    "상품명":customer_model(original)
                }))?);
            }
            if let Some(notice) = representative_notice(settings, item)? {
                provisional.push(notice);
            }
            // Only recognition's explicitly validated provisional notice is shown.
            let validated_notice = s(item, "provisionalNotice").trim();
            if !validated_notice.is_empty() { provisional.push(validated_notice.into()); }
            if payload.get("includeLinks").and_then(Value::as_bool) == Some(true) && url_is_official(s(item,"url")) {
                official_links.push(format!("{}\n{}", original, s(item, "url")));
            }
        }
        let freight_code = s(recipient, "freightCode");
        if freight_code != "010" && freight_code != "020" {
            return Err("운임구분은 010(선불) 또는 020(착불)이어야 합니다.".into());
        }
        if freight_code == "010" && recipient.get("shipping").is_none() {
            return Err("계산된 배송 운임이 없습니다.".into());
        }
        let freight = if freight_code == "020" { "착불".into() } else { money(&recipient["shipping"]) };
        parts.push(render(settings, "paymentFreight", &json!({"운임":freight}))?);
        let vat = recipient.get("applyVat").and_then(Value::as_bool)
            .ok_or("부가세 적용 기준이 없습니다.")?;
        vat_flags.push(vat);
        if vat {
            parts.push(render(settings, "paymentVat", &json!({"부가세":money(&recipient["vat"])}))?);
        }
        parts.extend(quantity_messages.drain(..));
        parts.push(String::new());
    }
    let mixed = vat_flags.contains(&true) && vat_flags.contains(&false);
    let vat_label = if mixed { " (부가세 포함/별도)" }
        else if vat_flags.contains(&true) { " (부가세 포함)" }
        else { " (부가세 별도)" };
    let total_string = if total.is_null() { "금액 확인 필요".into() } else { money(total) };
    parts.push(format!("{}{}", render(settings, "paymentTotal", &json!({"합계":total_string}))?, vat_label));
    let account = &payload["account"];
    let account_text = if !s(account, "bank").is_empty() && !s(account, "number").is_empty() && !s(account, "holder").is_empty() {
        render(settings, "paymentAccount", &json!({
            "은행명":s(account,"bank"),"계좌번호":s(account,"number"),"예금주":s(account,"holder")
        }))?
    } else { "[입금 계좌 등록 필요]".into() };
    parts.push(String::new());
    parts.push(account_text);
    if !provisional.is_empty() {
        parts.push(String::new());
        parts.extend(provisional);
    }
    if !official_links.is_empty() {
        parts.push(String::new());
        parts.extend(once(official_links));
    }
    Ok(json!({"payment":parts.join("\n"),"mixedVat":mixed}))
}
pub(super) fn execute(payload: &Value) -> Result<Value, String> {
    let settings = payload.get("settings").unwrap_or(&Value::Null);
    validate_templates(settings)?;
    match s(payload, "mode") {
        "template" => {
            let key = s(payload, "templateId");
            let values = payload.get("values").unwrap_or(&Value::Null);
            Ok(json!({"text":render(settings, key, values)?}))
        }
        "validate_templates" => Ok(json!({"valid":true})),
        "payment" => payment(payload, settings),
        "options" => {
            let questions = list(payload, "questions").iter().filter_map(Value::as_str)
                .enumerate().map(|(index,s)|format!("{}. {}",index+1,s)).collect::<Vec<_>>();
            let mut chunks = questions;
            for item in list(payload, "items") {
                if let Some(notice) = default_color_notice(settings, item)? { chunks.push(notice); }
                if let Some(notice) = representative_notice(settings, item)? { chunks.push(notice); }
            }
            let first = if chunks.is_empty() { render(settings,"optionsIntro",&Value::Null)? } else { chunks.join("\n") };
            let closing = if settings.get("automaticMessageTemplates").and_then(|v|v.get("optionsClosing")).is_some() {
                format!("\n\n{}",render(settings,"optionsClosing",&Value::Null)?)
            } else { String::new() };
            let links = if payload.get("includeLinks").and_then(Value::as_bool) == Some(true) {
                once(list(payload,"items").iter().filter(|v|url_is_official(s(v,"url")))
                    .map(|item|format!("{}\n{}",s(item,"name"),s(item,"url"))))
            } else { Vec::new() };
            Ok(json!({"options":format!("{}{}{}",first,closing,if links.is_empty(){String::new()}else{format!("\n\n{}",links.join("\n"))})}))
        }
        _ => Err("지원하지 않는 메시지 생성 모드입니다.".into()),
    }
}
