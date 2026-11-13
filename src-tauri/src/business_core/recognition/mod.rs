//! Standalone recognition engine. Integration with Tauri and price/freight lives elsewhere.
//! All spans exposed to TypeScript use UTF-16 offsets, not Rust byte positions.
mod model;
mod quantity;

use regex::Regex;
use serde_json::{json, Value};
use std::collections::HashSet;

#[derive(Clone, Debug)]
struct Evidence {
    kind: &'static str,
    value: String,
    start: usize,
    end: usize,
    line: usize,
    paragraph: usize,
    reason: &'static str,
    recipient: Option<usize>,
    item_id: Option<String>,
}

#[derive(Clone, Debug)]
struct Line<'a> {
    text: &'a str,
    start: usize,
    number: usize,
    paragraph: usize,
}

#[derive(Clone, Debug)]
struct ProductHit {
    evidence: usize,
    line: usize,
    raw: String,
    decision: Value,
    quantities: Vec<usize>,
    common: bool,
}

/// The only public entrypoint. Returns an error instead of guessing on malformed input.
pub fn execute(operation: &str, payload: Value) -> Result<Value, String> {
    if !payload.is_object() { return Err("payload must be a JSON object".into()); }
    match operation {
        "analyze_order" => {
            let raw = required_string(&payload, "raw")?;
            let state = required_state(&payload)?;
            analyze(raw, state, payload.get("client"))
        }
        "match_products" => {
            let state = required_state(&payload)?;
            let text = payload.get("text").or_else(|| payload.get("raw"))
                .and_then(Value::as_str).ok_or("match_products requires text or raw string")?;
            let client = client_id(payload.get("client"));
            let decision = model::decide(text, state, client);
            Ok(model::decision_json(&decision))
        }
        "reanalyze_order" => reanalyze(&payload),
        _ => Err(format!("unknown recognition operation: {operation}")),
    }
}

fn required_string<'a>(obj: &'a Value, key: &str) -> Result<&'a str, String> {
    obj.get(key).and_then(Value::as_str)
        .ok_or_else(|| format!("{key} must be a string"))
}
fn required_state(obj: &Value) -> Result<&Value, String> {
    let state = obj.get("state").ok_or("state is required")?;
    if !state.is_object() || !state.get("products").map_or(false, Value::is_array)
        || !state.get("aliases").map_or(false, Value::is_array) {
        return Err("state must contain products and aliases arrays".into());
    }
    Ok(state)
}
fn client_id(client: Option<&Value>) -> &str {
    client.and_then(|v| v.get("id")).and_then(Value::as_str).unwrap_or("")
}
fn utf16(raw: &str, byte_index: usize) -> usize {
    raw[..byte_index].encode_utf16().count()
}
fn e_json(raw: &str, e: &Evidence) -> Value {
    let start = utf16(raw, e.start);
    let end = utf16(raw, e.end);
    let mut result = json!({
        "id": format!("{}:{}:{}", e.kind, start, end),
        "text": &raw[e.start..e.end],
        "start": start, "end": end,
        "line": e.line, "paragraph": e.paragraph,
        "kind": e.kind, "value": e.value, "reason": e.reason,
    });
    if let Some(recipient) = e.recipient {
        result["recipientId"] = json!(format!("recognition:recipient:{recipient}"));
    }
    if let Some(id) = &e.item_id { result["itemId"] = json!(id); }
    result
}
fn add_evidence(events: &mut Vec<Evidence>, e: Evidence) -> usize {
    if let Some(pos) = events.iter().position(|p|
        p.kind == e.kind && p.start == e.start && p.end == e.end
    ) { return pos; }
    events.push(e);
    events.len() - 1
}
fn add_match(events: &mut Vec<Evidence>, line: &Line<'_>, start: usize,
    end: usize, kind: &'static str, value: String, reason: &'static str) -> usize {
    add_evidence(events, Evidence {
        kind, value, start: line.start + start, end: line.start + end,
        line: line.number, paragraph: line.paragraph, reason,
        recipient: None, item_id: None,
    })
}
fn physical_lines(raw: &str) -> Vec<Line<'_>> {
    let regex = Regex::new(r"[^\r\n]+").expect("physical lines");
    let mut paragraph = 0;
    let mut line_number = 0;
    let mut previous = 0;
    regex.find_iter(raw).filter_map(|m| {
        let gap = &raw[previous..m.start()];
        line_number += gap.chars().filter(|c| *c == '\n').count();
        if gap.chars().filter(|c| *c == '\n').count() > 1 { paragraph += 1; }
        previous = m.end();
        if m.as_str().trim().is_empty() { return None; }
        let value = Line { text: m.as_str(), start: m.start(), number: line_number,
            paragraph };
        Some(value)
    }).collect()
}
fn phone_regex() -> Regex {
    Regex::new(r"(?i)(0(?:50\d|1[016789]|2|[3-6]\d|70|80))[\s().-]*(\d{3,4})[\s().-]*(\d{4})")
        .expect("phone")
}
fn address_begin(line: &str) -> Option<usize> {
    let prefix = Regex::new(r"^\s*(?:주소|배송지(?:\s*주소)?|배송주소|받는곳|수취인주소)\s*[:：]?\s*")
        .expect("address prefix");
    if let Some(m) = prefix.find(line) { return Some(m.end()); }
    let address = Regex::new(concat!(
        r"(?:서울(?:특별시)?|부산(?:광역시)?|대구(?:광역시)?|인천(?:광역시)?|광주(?:광역시)?|",
        r"대전(?:광역시)?|울산(?:광역시)?|세종(?:특별자치시)?|경기(?:도)?|강원(?:특별자치도|도)?|",
        r"충청북도|충청남도|전라북도|전북특별자치도|전라남도|경상북도|경상남도|",
        r"충북|충남|전북|전남|경북|경남|제주(?:특별자치도|도)?|",
        r"[가-힣]{2,}(?:시|군|구|읍|면|동|리))\s+",
        r"|[가-힣A-Za-z0-9.]+(?:대로|로|길)\s*\d+(?:-\d+)?"
    )).expect("address");
    address.find(line).map(|m| m.start())
}
fn is_person(text: &str) -> bool {
    let re = Regex::new(r"^[가-힣]{2,5}(?:님)?$").expect("person");
    let forbidden = Regex::new(
        r"(?:아파트|빌라|센터|상가|학교|교회|성당|병원|학원|월드|도서관|회관|지원청|주세요|감사해요|보내세요)$",
    ).expect("institution");
    re.is_match(text) && !forbidden.is_match(text)
        && !["반도","민판","무타공","비타공","주소","배송지","배송주소","연락처","품목",
            "모델명","상품명","가방","바퀴","주문","발송"].contains(&text.trim_end_matches('님'))
}
fn is_institution(text: &str) -> bool {
    Regex::new(r"^[가-힣A-Za-z0-9 ()]{2,30}(?:학교|교회|성당|병원|학원|월드|도서관|회관)$")
        .expect("institution").is_match(text)
}
fn is_money_or_header(text: &str) -> bool {
    let normalized = text.trim();
    let payment = Regex::new(
        r"^(?:[\d,]+\s*원(?:\s*입니다.*)?|배송료|운임까지.*|합계(?:금액)?(?:\s|:).*|계좌번호.*|발주(?:일자|일).*)$",
    ).expect("payment");
    payment.is_match(normalized) || normalized.contains("공급받는자")
        || normalized.contains("발주처") || normalized.contains("수주처")
        || normalized.contains("품목 | 제품명") || normalized.contains("NO | 품명")
}
fn product_signal(text: &str, decision: &Value, state: &Value) -> bool {
    let kind = decision.pointer("/match/kind").and_then(Value::as_str).unwrap_or("UNKNOWN");
    if kind != "UNKNOWN" { return true; }
    let t = text.trim();
    if Regex::new(r"(?i)(?:BD[\s-]*)?[A-Z]{1,6}[-\s]?\d{1,4}(?:[-A-Z0-9]+)*|\b\d{3}(?:-1)?(?:\b|$)")
        .expect("model code").is_match(t) { return true; }
    if t.contains("보면대") || t.contains("악보대") || t.contains("스탠드")
        || t.contains("뮤직트레이") || t.contains("스테레오바")
        || t.contains("홀더") || t.contains("카트") {
        // Do not treat addresses, notes, or organization names as products.
        return !state.get("products").and_then(Value::as_array).map_or(false, |xs| xs.is_empty())
            || model::category(t).is_some() || t.contains("카트") || t.contains("홀더");
    }
    false
}
fn source_json(raw: &str, e: &Evidence, recipient_id: &str, target_id: &str) -> Value {
    json!({
        "start": utf16(raw,e.start), "end": utf16(raw,e.end),
        "field": e.kind, "targetId": target_id,
        "recipientId":recipient_id, "text": &raw[e.start..e.end],
    })
}
fn address_info(value: &str) -> (String, String, Value) {
    let road = Regex::new(r"[로길]\s*\d+(?:-\d+)?").expect("road").is_match(value);
    let lot = Regex::new(r"[동리읍면]\s+(?:산\s*)?\d+(?:-\d+)?").expect("lot").is_match(value);
    let kind = if road { "ROAD" } else if lot { "LOT" } else { "UNKNOWN" };
    let status = if (road || lot) && !value.contains('#') && !value.contains('@') {
        "COMPLETE"
    } else { "INCOMPLETE" };
    let province = Regex::new(r"^(?:서울특별시|서울|부산광역시|부산|대구광역시|대구|인천광역시|인천|광주광역시|광주|대전광역시|대전|울산광역시|울산|세종특별자치시|세종|경기도|경기|강원특별자치도|강원도|강원|충청북도|충청남도|전북특별자치도|전라북도|전라남도|경상북도|경상남도|제주특별자치도|제주도|제주|충북|충남|전북|전남|경북|경남)")
        .expect("province").find(value).map(|m| m.as_str().to_owned());
    let mut parts = json!({});
    if let Some(p) = province { parts["province"] = json!(p); }
    if let Some(m) = Regex::new(r"([가-힣A-Za-z0-9.]+(?:대로|로|길))\s+(\d+(?:-\d+)?)")
        .expect("road component").captures(value) {
        parts["road"] = json!(&m[1]);
        parts["building"] = json!(&m[2]);
        if let Some(full) = m.get(0) {
            let detail = value[full.end()..].trim();
            if !detail.is_empty() { parts["detail"] = json!(detail); }
        }
    }
    (kind.into(), status.into(), parts)
}
fn blank_recipient(id: &str, name: &str, anchor: Option<&Evidence>, raw: &str) -> Value {
    let mut value = json!({
        "id":id, "name":name, "address":"", "phone":"", "mobile":"", "note":"",
        "items":[], "sources":[], "candidates":[], "confirmedFields":[],
    });
    if let Some(a) = anchor {
        value["evidence"] = json!({"anchorId": format!("{}:{}:{}",a.kind,utf16(raw,a.start),utf16(raw,a.end)),
            "start":utf16(raw,a.start),"end":utf16(raw,a.end)});
    }
    value
}
fn owner_index(anchors: &[usize], events: &[Evidence], offset: usize) -> usize {
    anchors.iter().enumerate().rev().find(|(_, i)| events[**i].start <= offset)
        .map(|(idx,_)|idx).unwrap_or(0)
}
fn analyze(raw: &str, state: &Value, client: Option<&Value>) -> Result<Value, String> {
    let client_id = client_id(client);
    let lines = physical_lines(raw);
    let mut events: Vec<Evidence> = Vec::new();
    let mut product_hits: Vec<ProductHit> = Vec::new();
    let phone = phone_regex();
    let person_label = Regex::new(
        r"(?:수취인(?:명)?|수하인(?:명)?|수령자|받는\s*(?:분|사람)|성함|이름)\s*[:：]?\s*([가-힣]{2,5})",
    ).expect("name label");
    let inline_person = Regex::new(r"(?:^|[\s|/])([가-힣]{2,5})(?:님)?\s+(?:0(?:50\d|1[016789]|2|[3-6]\d|70|80))")
        .expect("inline name");
    let quantity_person = Regex::new(r"(?i)(?:\d+|한|두|세|네)\s*(?:개|대|ea|pcs)(?:\s|ㅣ|\|)+([가-힣]{2,5})(?:님)?")
        .expect("quantity name");
    let note_label = Regex::new(r"^\s*(?:배송\s*)?(?:메모|메시지|메세지|요청사항)\s*[:：]?\s*(.*)$")
        .expect("note");
    let mut sender_section = false;
    for line in &lines {
        let text = line.text.trim();
        if Regex::new(r"^(?:보내는\s*(?:분|사람|곳)|송하인(?:명)?)\s*[:：]")
            .expect("sender prefix").is_match(text) {
            sender_section = true;
        }
        if sender_section { continue; }
        if is_money_or_header(text) { continue; }
        if let Some(c) = note_label.captures(line.text) {
            if let Some(v) = c.get(1) {
                if !v.as_str().trim().is_empty() {
                    add_match(&mut events, line, v.start(), v.end(), "note",
                        v.as_str().trim().to_owned(), "배송 요청사항 표제어");
                }
            }
            continue;
        }

        let address = address_begin(line.text);
        // Names inside the delivery address, including a church/school, remain address text.
        if let Some(start) = address {
            let value = line.text[start..].trim();
            if !value.is_empty() {
                let end = start + line.text[start..].trim_end().len();
                add_match(&mut events, line, start, end, "address",
                    value.to_owned(), "배송주소 원문 구간");
            }
        }

        if let Some(c) = person_label.captures(line.text) {
            if let Some(name) = c.get(1) {
                if is_person(name.as_str()) {
                    add_match(&mut events, line, name.start(), name.end(), "name",
                        name.as_str().to_owned(), "명시적 수취인 이름");
                }
            }
        }
        if let Some(c) = inline_person.captures(line.text) {
            if let Some(name) = c.get(1) {
                if is_person(name.as_str()) && address.map_or(true, |a| name.end() <= a) {
                    add_match(&mut events, line, name.start(), name.end(), "name",
                        name.as_str().to_owned(), "이름과 연락처가 같은 행");
                }
            }
        }
        if let Some(c) = quantity_person.captures(line.text) {
            if let Some(name) = c.get(1) {
                if is_person(name.as_str()) && address.map_or(true, |a| name.end() <= a) {
                    add_match(&mut events, line, name.start(), name.end(), "name",
                        name.as_str().to_owned(), "수량 뒤에 적힌 수취인 이름");
                }
            }
        }
        // A parenthesized contact preceding a delivery address (case 7).
        if let Some(address_start) = address {
            let prefix = &line.text[..address_start];
            let enclosed = Regex::new(r"\(([가-힣]{2,5})\)").expect("enclosed name");
            for c in enclosed.captures_iter(prefix) {
                if let Some(name) = c.get(1) {
                    if is_person(name.as_str()) {
                        add_match(&mut events,line,name.start(),name.end(),"name",
                            name.as_str().to_owned(),"주소 앞 괄호의 수취인");
                    }
                }
            }
        }
        for c in phone.captures_iter(line.text) {
            let full = c.get(0).expect("phone match");
            // Reject a phone-like substring embedded in a longer digit run.
            if (full.start() > 0 && line.text[..full.start()].chars().next_back()
                .map_or(false, |v| v.is_ascii_digit()))
                || line.text[full.end()..].chars().next().map_or(false, |v|v.is_ascii_digit()) {
                continue;
            }
            let value = format!("{}-{}-{}", &c[1], &c[2], &c[3]);
            let kind = if c[1].starts_with("01") { "mobile" } else { "phone" };
            add_match(&mut events, line, full.start(),full.end(),kind,value,
                "연락처 원문 구간");
        }
        let has_name = events.iter().any(|e| e.kind == "name" && e.line == line.number);
        if !has_name && address.is_none() {
            if let Some(c) = Regex::new(r"^([가-힣]{2,5})\s+(?:목사|선생님)$")
                .expect("recipient title").captures(text) {
                if let Some(name) = c.get(1) {
                    if is_person(name.as_str()) {
                        if let Some(at) = line.text.find(name.as_str()) {
                            add_match(&mut events,line,at,at+name.len(),"name",
                                name.as_str().to_owned(),"직함 앞 독립 수취인 이름");
                        }
                    }
                }
            }
            let standalone = text.trim_end_matches('님');
            if is_person(standalone) || is_institution(text) {
                if let Some(at) = line.text.find(text) {
                    add_match(&mut events, line, at, at + text.len(), "name",
                        standalone.to_owned(), "독립 수취인 또는 기관명");
                }
            }
            if text.starts_with("김") || text.starts_with("박") || text.starts_with("이") {
                // Name followed by a short note, e.g. '김가상 예수아님'.
                let first = text.split_whitespace().next().unwrap_or("");
                if is_person(first) && text.split_whitespace().count() == 2 {
                    if let Some(at) = line.text.find(first) {
                        add_match(&mut events,line,at,at+first.len(),"name",
                            first.to_owned(),"수취인명과 부연 문구");
                    }
                }
            }
        }
        if address.is_none() && !has_name {
            // "진해구 안청남로 40" is already picked up by address_begin.
            // A bare building continuation is left attached to the previous address later.
        }

        let product_part = address.map_or(line.text, |begin| &line.text[..begin]);
        let trimmed = product_part.trim();
        if trimmed.is_empty() || trimmed.contains("배송비") || trimmed.contains("택배비")
            || trimmed.starts_with("전화") || trimmed.starts_with("연락처") {
            continue;
        }
        let decision = model::decision_json(&model::decide(trimmed,state,client_id));
        if !product_signal(trimmed, &decision, state) { continue; }
        // Require model/category evidence, not a value made solely from a date or contact.
        if trimmed.contains("발주일") || trimmed.contains("발송일") { continue; }
        let skip_until = if trimmed.contains('|') {
            // Ignore an address/recipient in the remarks column when matching the SKU.
            let parts: Vec<_> = trimmed.split('|').collect();
            if parts.len() >= 5 { parts[..4].join(" | ") } else { trimmed.to_owned() }
        } else { trimmed.to_owned() };
        let matched = model::decision_json(&model::decide(&skip_until,state,client_id));
        let quantity_values = quantity::for_product(&skip_until, trimmed.contains('|'),
            !trimmed.contains('|') && model::products(state).iter()
                .any(|p| model::model_names(p).iter().any(|name|
                    model::find_term(&skip_until,name,true).is_some())));
        let mut quantity_indexes = Vec::new();
        let offset = line.text.find(trimmed).unwrap_or(0);
        for q in quantity_values {
            quantity_indexes.push(add_match(&mut events, line, offset+q.start,offset+q.end,
                "quantity",q.value.to_string(),"상품 행에 명시된 수량"));
        }
        let term_span = matched.get("evidence").and_then(Value::as_object)
            .and_then(|o| Some((o.get("start")?.as_u64()? as usize,o.get("end")?.as_u64()? as usize)));
        let (p_start,p_end) = term_span.unwrap_or((0,skip_until.len()));
        // model spans are byte offsets inside this Rust module.
        let p_start = p_start.min(skip_until.len());
        let p_end = p_end.min(skip_until.len()).max(p_start);
        let p_start = if skip_until.is_char_boundary(p_start) { p_start } else { 0 };
        let p_end = if skip_until.is_char_boundary(p_end) { p_end } else { skip_until.len() };
        let product_evidence = add_match(&mut events,line,offset+p_start,offset+p_end,
            "product",trimmed.to_owned(),"상품명/모델명/별칭 인식 근거");
        product_hits.push(ProductHit {
            evidence:product_evidence,line:line.number,raw:trimmed.to_owned(),
            decision:matched,quantities:quantity_indexes,
            common:Regex::new(r"공통|모두|전부|전원|각\s*수취인|같은\s*상품")
                .expect("common item").is_match(trimmed),
        });
    }
    // A generic quantity line is evidence but cannot itself prove which SKU was ordered.
    for line in &lines {
        if events.iter().any(|e| e.kind == "quantity" && e.line == line.number) { continue; }
        if is_money_or_header(line.text) { continue; }
        if product_hits.iter().any(|h| h.line == line.number) { continue; }
        for q in quantity::extract(line.text) {
            add_match(&mut events,line,q.start,q.end,"quantity",q.value.to_string(),
                "독립 수량 원문; 상품 연결은 별도 판정");
        }
    }

    let mut anchors: Vec<usize> = events.iter().enumerate()
        .filter_map(|(i,e)| (e.kind == "name").then_some(i)).collect();
    anchors.sort_by_key(|i| events[*i].start);
    anchors.dedup_by_key(|i| events[*i].line);
    if anchors.is_empty() {
        anchors = events.iter().enumerate()
            .filter_map(|(i,e)| (e.kind=="address").then_some(i)).collect();
    }
    // If a document has only one unnamed destination, keep exactly one row.
    if anchors.is_empty() && raw.trim().is_empty() {
        return Ok(json!({"recipients":[],"candidates":[],"unassigned":[]}));
    }
    let mut recipients: Vec<Value> = anchors.iter().enumerate().map(|(i,a)| {
        let e = &events[*a];
        blank_recipient(&format!("recognition:recipient:{i}"),
            if e.kind=="name" {&e.value} else {""},Some(e),raw)
    }).collect();
    if recipients.is_empty() {
        recipients.push(blank_recipient("recognition:recipient:0","",None,raw));
    }
    for index in 0..events.len() {
        if events[index].kind == "product" || events[index].kind == "quantity" { continue; }
        let row_index = owner_index(&anchors,&events,events[index].start);
        let rid = recipients[row_index]["id"].as_str().unwrap_or("").to_owned();
        let e = &events[index];
        let kind = e.kind;
        let v = e.value.clone();
        let previous = recipients[row_index][kind].as_str().unwrap_or("").to_owned();
        if previous.is_empty() {
            recipients[row_index][kind] = json!(v);
        } else if kind=="address" && !previous.contains(&v) {
            recipients[row_index]["address"] = json!(format!("{previous} {v}"));
        } else if (kind=="phone" || kind=="mobile") && previous != v {
            let other = if kind=="phone" { "mobile" } else { "phone" };
            if recipients[row_index][other].as_str().unwrap_or("").is_empty() {
                recipients[row_index][other] = json!(v);
            }
        }
        let src = source_json(raw,e,&rid,&rid);
        recipients[row_index]["sources"].as_array_mut().expect("sources").push(src);
        recipients[row_index]["candidates"].as_array_mut().expect("candidates")
            .push(json!({"id":format!("{}:{}:{}",kind,utf16(raw,e.start),utf16(raw,e.end)),
                "field":kind,"value":e.value,"label":e.value,
                "start":utf16(raw,e.start),"end":utf16(raw,e.end)}));
        events[index].recipient = Some(row_index);
    }
    for row in &mut recipients {
        if let Some(address) = row["address"].as_str().filter(|s| !s.is_empty()) {
            let (kind,status,parts) = address_info(address);
            row["addressKind"] = json!(kind);
            row["addressStatus"] = json!(status);
            row["addressParts"] = parts;
        }
    }
    let has_leading = anchors.first().map_or(false, |a| product_hits.iter().any(|h|
        !h.common && events[h.evidence].start < events[*a].start));
    for hit in &product_hits {
        let anchor_index = owner_index(&anchors,&events,events[hit.evidence].start);
        let owner = if has_leading && !anchors.is_empty()
            && events[hit.evidence].start < events[anchors[0]].start { 0 } else { anchor_index };
        let attach_to: Vec<usize> = if hit.common {
            (0..recipients.len()).filter(|idx| recipients[*idx]["items"]
                .as_array().map_or(true,|xs|xs.is_empty())).collect()
        } else { vec![owner] };
        for idx in attach_to {
            let id = format!("recognition:item:{}:{}", utf16(raw,events[hit.evidence].start),idx);
            let rid = recipients[idx]["id"].as_str().unwrap_or("").to_owned();
            let unique = hit.quantities.len()==1;
            let quantity_value = if unique {
                hit.quantities.first().and_then(|i|events[*i].value.parse::<i64>().ok())
            } else {None};
            let chosen = hit.decision.get("productId").and_then(Value::as_str)
                .filter(|s| !s.is_empty());
            let name = hit.decision.get("name").and_then(Value::as_str)
                .filter(|s|!s.is_empty()).unwrap_or(&hit.raw);
            let reason = hit.decision.get("recognitionReason").cloned().unwrap_or(Value::Null);
            let mut issues: Vec<String> = Vec::new();
            if chosen.is_none() {
                issues.push("제품명이 확인되지 않습니다.".into());
            }
            if !unique {
                issues.push(if hit.quantities.is_empty() {
                    "수량 미기재 / 거래처 확인 필요".to_owned()
                } else {
                    "한 줄에 여러 상품과 수량 확인 필요".to_owned()
                });
            }
            let term = if hit.common {json!({
                "kind":"COMMON_INHERIT",
                "term":hit.raw,
                "productIds":chosen.into_iter().collect::<Vec<_>>()
            })} else {hit.decision["match"].clone()};
            let mut item = json!({
                "id":id,"productId":chosen,"variantId":hit.decision["variantId"],
                "raw":hit.raw,"name":name,
                "color":hit.decision["color"],"quantity":quantity_value,
                "quantityConfirmed":unique,"unitPrice":null,
                "origin":hit.decision.get("origin").and_then(Value::as_str).unwrap_or("FACTORY"),
                "defaulted":false,"recognitionReason":reason,"issues":issues,
                "url":"","match":term,
                "productCandidates":hit.decision["productCandidates"],"sources":[],
            });
            let mut sources = vec![source_json(raw,&events[hit.evidence],&rid,&id)];
            if unique {
                sources.push(source_json(raw,&events[hit.quantities[0]],&rid,&id));
                events[hit.quantities[0]].item_id=Some(id.clone());
                events[hit.quantities[0]].recipient=Some(idx);
            }
            item["sources"] = json!(sources);
            recipients[idx]["items"].as_array_mut().expect("items").push(item);
            if events[hit.evidence].recipient.is_none() {
                events[hit.evidence].recipient=Some(idx);
                events[hit.evidence].item_id=Some(id.clone());
            }
        }
    }
    // A detached quantity is attachable only when exactly one item and one quantity
    // are unresolved within the same recipient. Otherwise it stays visible as evidence.
    for idx in 0..recipients.len() {
        let standalone: Vec<usize> = events.iter().enumerate().filter_map(|(i,e)|
            (e.kind=="quantity" && e.item_id.is_none()
                && owner_index(&anchors,&events,e.start)==idx
                && !product_hits.iter().any(|h| h.line==e.line)).then_some(i)
        ).collect();
        let pending: Vec<usize> = recipients[idx]["items"].as_array().expect("items")
            .iter().enumerate().filter_map(|(i,it)|it["quantity"].is_null().then_some(i)).collect();
        if standalone.len()==1 && pending.len()==1 {
            let q = standalone[0];
            let item_idx = pending[0];
            let rid = recipients[idx]["id"].as_str().unwrap_or("").to_owned();
            let id = recipients[idx]["items"][item_idx]["id"].as_str().unwrap_or("").to_owned();
            if let Ok(value) = events[q].value.parse::<i64>() {
                recipients[idx]["items"][item_idx]["quantity"]=json!(value);
                recipients[idx]["items"][item_idx]["quantityConfirmed"]=json!(true);
                if let Some(issues) = recipients[idx]["items"][item_idx]["issues"].as_array_mut() {
                    issues.retain(|s|!s.as_str().unwrap_or("").contains("수량"));
                }
                recipients[idx]["items"][item_idx]["sources"].as_array_mut().expect("item sources")
                    .push(source_json(raw,&events[q],&rid,&id));
                events[q].recipient=Some(idx);
                events[q].item_id=Some(id);
            }
        }
    }
    // Attach evidence to the outer rows, but do not fabricate product/quantity ownership.
    let mut unassigned = Vec::new();
    for e in &events {
        if e.recipient.is_none() { unassigned.push(e_json(raw,e)["id"].clone()); }
    }
    for e in &events {
        if (e.kind=="product" || e.kind=="quantity") && e.recipient.is_none() {
            let idx=owner_index(&anchors,&events,e.start);
            recipients[idx]["unassignedEvidence"].as_array_mut().map(|xs|xs.push(e_json(raw,e)));
            if recipients[idx].get("unassignedEvidence").is_none() {
                recipients[idx]["unassignedEvidence"]=json!([e_json(raw,e)]);
            }
        }
    }
    let candidates: Vec<Value> = events.iter().map(|e| {
        let mut candidate=e_json(raw,e);
        if let Some(idx) = e.recipient {
            candidate["recipientId"]=recipients[idx]["id"].clone();
        }
        candidate
    }).collect();
    Ok(json!({"recipients":recipients,"candidates":candidates,"unassigned":unassigned}))
}

fn reanalyze(payload: &Value) -> Result<Value, String> {
    let old = payload.get("order").ok_or("reanalyze_order requires order")?;
    if !old.is_object() { return Err("order must be an object".into()); }
    let state = required_state(payload)?;
    let mut next = old.clone();
    if old.get("manualClassification").map_or(false, |x|!x.is_null()) {
        return Ok(next);
    }
    let raw = old.get("analysisRaw").and_then(Value::as_str)
        .or_else(||old.get("raw").and_then(Value::as_str))
        .ok_or("order needs raw or analysisRaw")?;
    let client = state.get("clients").and_then(Value::as_array)
        .and_then(|xs|xs.iter().find(|c|
            c.get("id").and_then(Value::as_str)==old.get("clientId").and_then(Value::as_str)))
        .or_else(||old.get("clientSnapshot"));
    let analysis = analyze(raw,state,client)?;
    let mut incoming = analysis["recipients"].as_array().cloned().unwrap_or_default();
    let prior = old.get("recipients").and_then(Value::as_array)
        .ok_or("order.recipients must be an array")?;
    let mut used=HashSet::<usize>::new();
    for row in &mut incoming {
        // Identity must be unique. Never silently transfer confirmations between
        // two recipients who happen to have the same name.
        let matching: Vec<usize> = prior.iter().enumerate().filter_map(|(index,r)|{
            let names = r["name"].as_str().filter(|x|!x.is_empty())==
                row["name"].as_str().filter(|x|!x.is_empty());
            let address = r["address"].as_str().filter(|x|!x.is_empty())==
                row["address"].as_str().filter(|x|!x.is_empty());
            (names && address && !used.contains(&index)).then_some(index)
        }).collect();
        if matching.len()!=1 { continue; }
        let index=matching[0];
        used.insert(index);
        let old_row=&prior[index];
        row["id"]=old_row["id"].clone();
        for key in ["shippingCharges","freightCode","vatDefault","vatOverride","dispatchOrigin"] {
            if let Some(v)=old_row.get(key) {row[key]=v.clone();}
        }
        let confirmed=old_row.get("confirmedFields").and_then(Value::as_array)
            .cloned().unwrap_or_default();
        row["confirmedFields"]=json!(confirmed);
        for field in confirmed.iter().filter_map(Value::as_str) {
            if ["name","address","phone","mobile","note"].contains(&field) {
                if let Some(value)=old_row.get(field) { row[field]=value.clone(); }
                if field=="address" {
                    if let Some(v)=old_row.get("addressStatus"){row["addressStatus"]=v.clone();}
                    if let Some(v)=old_row.get("addressParts"){row["addressParts"]=v.clone();}
                }
            }
        }
        if let (Some(next_items),Some(old_items)) =
            (row["items"].as_array_mut(),old_row["items"].as_array()) {
            let mut consumed=HashSet::new();
            for item in next_items.iter_mut() {
                let matched:Vec<usize>=old_items.iter().enumerate().filter_map(|(i,p)|
                    (!consumed.contains(&i) && p["raw"]==item["raw"]).then_some(i)).collect();
                if matched.len()!=1 {continue;}
                let i=matched[0];
                consumed.insert(i);
                let previous=&old_items[i];
                let old_quantity_sources:Vec<_>=previous["sources"].as_array().into_iter()
                    .flatten().filter(|s|s["field"]=="quantity").map(|s|s["text"].clone()).collect();
                let new_quantity_sources:Vec<_>=item["sources"].as_array().into_iter()
                    .flatten().filter(|s|s["field"]=="quantity").map(|s|s["text"].clone()).collect();
                let changed=old_quantity_sources!=new_quantity_sources;
                let detected_quantity=item["quantity"].clone();
                let detected_confirmation=item["quantityConfirmed"].clone();
                let detected_issues=item["issues"].clone();
                let new_sources=item["sources"].clone();
                let new_id=previous["id"].clone();
                if previous["manuallyConfirmed"]==true {
                    *item=previous.clone();
                }
                item["id"]=new_id.clone();
                item["sources"]=new_sources;
                if changed {
                    item["quantity"]=detected_quantity;
                    item["quantityConfirmed"]=detected_confirmation;
                    if let Some(issues)=item["issues"].as_array_mut(){
                        issues.retain(|v|!v.as_str().unwrap_or("").contains("수량"));
                        if let Some(new_issues)=detected_issues.as_array() {
                            issues.extend(new_issues.iter().filter(|v|v.as_str()
                                .unwrap_or("").contains("수량")).cloned());
                        }
                    }
                    if let Some(object)=item.as_object_mut(){object.remove("quantityApproval");}
                }
                if let Some(sources)=item["sources"].as_array_mut() {
                    for source in sources {source["targetId"]=new_id.clone();}
                }
            }
        }
        if let Some(sources)=row["sources"].as_array_mut() {
            for source in sources {source["targetId"]=old_row["id"].clone();
                source["recipientId"]=old_row["id"].clone();}
        }
    }
    // Candidate ownership has to refer to the same stable IDs as the rows.
    let mut candidates=analysis["candidates"].as_array().cloned().unwrap_or_default();
    for c in &mut candidates {
        let old_recipient_id=c.get("recipientId").cloned();
        for row in &incoming {
            let anchor_id=row.pointer("/evidence/anchorId");
            let _ = anchor_id; // anchor is retained for integration, not used to guess identity.
            if let (Some(candidate_id),Some(evidence_id)) =
                (old_recipient_id.as_ref(),row.get("id")) {
                if candidate_id==evidence_id {break;}
            }
        }
    }
    next["recipients"]=json!(incoming);
    next["analysisEvidence"]=json!(candidates);
    Ok(next)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn state() -> Value {
        json!({"products":[
            {"id":"p709","code":"709","name":"709 / 타공 상판","category":"보면대",
             "origin":"FACTORY","active":true,"variants":[{"id":"v709","color":"Black"}]},
            {"id":"p709-1","code":"709-1","name":"709-1 / 비타공 상판","category":"보면대",
             "origin":"FACTORY","active":true,"variants":[{"id":"v709-1","color":"Black"}]},
            {"id":"pgt","code":"GT-1","name":"GT-1 / 기타 스탠드","category":"기타",
             "origin":"FACTORY","active":true,"variants":[{"id":"vgt","color":"Black"}]}
        ],"aliases":[],"clients":[]})
    }
    #[test]
    fn contract_rejects_incomplete_state() {
        assert!(execute("analyze_order",json!({"raw":"709 1개","state":{}})).is_err());
        assert!(execute("invalid",json!({})).is_err());
    }
    #[test]
    fn no_quantity_is_approved_without_evidence() {
        let out=execute("analyze_order",json!({"raw":"709 민판\n김가상\n010-1234-5678\n경기도 의정부시 시민로 100","state":state()})).unwrap();
        let item=&out["recipients"][0]["items"][0];
        assert_eq!(item["quantity"],Value::Null);
        assert_eq!(item["quantityConfirmed"],false);
        assert_ne!(item["productId"],"p709");
    }
    #[test]
    fn separate_recipients_and_utf16_spans() {
        let raw="김가상\n010-1234-5678\n경기도 의정부시 시민로 100\n709 2개\n박가상\n010-2345-6789\n서울특별시 마포구 월드컵로 20\nGT-1 1개";
        let out=execute("analyze_order",json!({"raw":raw,"state":state()})).unwrap();
        assert_eq!(out["recipients"].as_array().unwrap().len(),2);
        assert_eq!(out["recipients"][0]["items"][0]["quantity"],2);
        assert_eq!(out["recipients"][1]["items"][0]["quantity"],1);
        let contact=out["candidates"].as_array().unwrap().iter()
            .find(|v|v["kind"]=="mobile").unwrap();
        let start=contact["start"].as_u64().unwrap() as usize;
        let end=contact["end"].as_u64().unwrap() as usize;
        let encoded:Vec<u16>=raw.encode_utf16().collect();
        assert_eq!(String::from_utf16(&encoded[start..end]).unwrap(),"010-1234-5678");
    }
    #[test]
    fn manual_confirmations_survive_identical_order() {
        let analysis=execute("analyze_order",json!({"raw":"709 2개\n김가상\n서울특별시 마포구 월드컵로 20","state":state()})).unwrap();
        let mut order=json!({"raw":"709 2개\n김가상\n서울특별시 마포구 월드컵로 20",
            "clientId":"c","recipients":analysis["recipients"],"status":"RECEIVED"});
        order["recipients"][0]["items"][0]["manuallyConfirmed"]=json!(true);
        order["recipients"][0]["items"][0]["productId"]=json!("staff-picked");
        let out=execute("reanalyze_order",json!({"order":order,"state":state()})).unwrap();
        assert_eq!(out["recipients"][0]["items"][0]["productId"],"staff-picked");
    }
}
