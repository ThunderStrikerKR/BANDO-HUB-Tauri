//! Standalone recognition engine. Integration with Tauri and price/freight lives elsewhere.
//! All spans exposed to TypeScript use UTF-16 offsets, not Rust byte positions.
mod model;
mod quantity;
mod ts_semantics;

use regex::Regex;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

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
    source_start: usize,
    line: usize,
    raw: String,
    decision: Value,
    quantities: Vec<usize>,
    common: bool,
    each: bool,
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
            let mut result=model::decision_json(&decision);
            if let Some(span)=result.get_mut("evidence") {
                if let (Some(start),Some(end))=(span["start"].as_u64(),span["end"].as_u64()) {
                    let start=start as usize;
                    let end=end as usize;
                    if text.is_char_boundary(start) && text.is_char_boundary(end) {
                        *span=json!({"start":utf16(text,start),"end":utf16(text,end)});
                    }
                }
            }
            Ok(result)
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
fn is_person(text: &str) -> bool { ts_semantics::person(text) }
fn is_institution(text: &str) -> bool {
    Regex::new(r"^[가-힣A-Za-z0-9 ()]{2,30}(?:학교|교회|성당|병원|학원|월드|도서관|회관)$")
        .expect("institution").is_match(text)
}
fn is_money_or_header(text: &str) -> bool { ts_semantics::ignored_document_line(text) }
fn product_signal(text: &str, decision: &Value, _state: &Value) -> bool {
    // From parser.ts:479-570: only registered identity, aliases, quantity,
    // a genuine unknown model, or a product category can form a product row.
    let t=text.trim();
    if ts_semantics::ignored_document_line(t) { return false; }
    if t.contains("배송비") || t.contains("택배비") || t.contains("운임")
        || t.starts_with("번호") || t.starts_with("TEL")
        || t.starts_with("연락처") || t.starts_with("휴대") { return false; }
    let kind=decision.pointer("/match/kind").and_then(Value::as_str).unwrap_or("UNKNOWN");
    if kind!="UNKNOWN" { return true; }
    // In the TS recognizer an unknown three-digit model is an item candidate,
    // but an unlabelled money or phone line is not.
    let model=Regex::new(r"(?i)(?:BD\s*)?\d{3}[A-Za-z0-9-]*")
        .expect("unknown model");
    if model.is_match(t) { return true; }
    if model::category(t).is_some() { return true; }
    let product_category=Regex::new(
        r"(?i)보면대|악보대|스탠드|뮤직트레이|스테레오바|홀더|카트|의자|가방|발판|거치대|SSB"
    ).expect("product category");
    product_category.is_match(t)
        && (quantity::extract(t).len()>0 || t.contains("BANDO") || t.contains("반도"))
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
    for (field, pattern) in [
        ("city", r"(?:^|\s)([가-힣]+(?:시|군))(?:\s|$)"),
        ("district", r"(?:^|\s)([가-힣]+구)(?:\s|$)"),
        ("town", r"(?:^|\s)([가-힣0-9]+(?:읍|면|동|리))(?:\s|$)"),
    ] {
        if let Some(c)=Regex::new(pattern).expect("administrative component").captures(value) {
            if let Some(m)=c.get(1){parts[field]=json!(m.as_str());}
        }
    }
    let road=Regex::new(r"([가-힣A-Za-z0-9.]+(?:대로|로|길))\s+(\d+(?:-\d+)?)")
        .expect("road component").captures(value);
    if let Some(m)=road {
        parts["road"] = json!(&m[1]);
        parts["building"] = json!(&m[2]);
        if let Some(full)=m.get(0){
            let detail=value[full.end()..].trim();
            if !detail.is_empty(){parts["detail"]=json!(detail);}
        }
    } else if let Some(m)=Regex::new(r"[동리읍면]\s+(?:산\s*)?(\d+(?:-\d+)?)")
        .expect("lot number").captures(value) {
        parts["building"]=json!(&m[1]);
        if let Some(full)=m.get(0){
            let detail=value[full.end()..].trim();
            if !detail.is_empty(){parts["detail"]=json!(detail);}
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
/// Original TypeScript resolvePrice for the recognition Item shape.
/// The separate pricing migration remains authoritative for business rules.
fn legacy_recognition_price(v: &Value,client: Option<&Value>) -> Value {
    let Some(client)=client.filter(|c|
        c.get("id").and_then(Value::as_str).map_or(false,|id|!id.is_empty()))
    else {return Value::Null;};
    let tier=client.get("tier").and_then(Value::as_str).unwrap_or("");
    let price=if tier=="special" {
        let overrides=client.get("overrides");
        let variant_id=v.get("id").and_then(Value::as_str).unwrap_or("");
        let override_price=overrides.and_then(|o|o.get(variant_id))
            .filter(|x|!x.is_null());
        let prior=v.get("legacyIds").and_then(Value::as_array)
            .into_iter().flatten().find_map(|id|
                overrides.and_then(|o|o.get(id.as_str().unwrap_or("")))
                    .filter(|x|!x.is_null()));
        override_price.or(prior).or_else(||v.get("wholesale"))
    } else {v.get(tier)};
    let chosen=price.cloned().unwrap_or(Value::Null);
    if chosen.as_f64()==Some(0.0) {Value::Null} else {chosen}
}
/// Port of src/domain.ts::itemFromProduct and parser.ts single-sale-unit rule.
/// No inferred sale option or color without registered evidence.
fn apply_registered_item(
    item: &mut Value,state: &Value,client: Option<&Value>,explicit: &str
) {
    let Some(pid)=item.get("productId").and_then(Value::as_str) else {return;};
    let Some(p)=model::products(state).into_iter()
        .find(|p|p.get("id").and_then(Value::as_str)==Some(pid)) else{return;};
    let variants=p.get("variants").and_then(Value::as_array);
    let selectable=variants.map_or(false,|xs|xs.len()==1)
        && p.get("requiresOption").and_then(Value::as_bool)!=Some(true);
    let default_color=p.get("defaultColor").and_then(Value::as_str).unwrap_or("");
    let selected_color=if explicit.is_empty(){default_color}else{explicit};
    let color=model::norm_color(selected_color);
    let chosen=if selectable {
        variants.and_then(|vs|vs.iter().find(|v|
            model::norm_color(v.get("color").and_then(Value::as_str).unwrap_or(""))==color))
    } else {None};
    let mut name=p.get("name").and_then(Value::as_str)
        .or_else(||p.get("code").and_then(Value::as_str)).unwrap_or("")
        .trim_start_matches("반도스탠드").trim().to_owned();
    if variants.map_or(false,|v|v.len()>1) {
        if let Some(option)=chosen.and_then(|v|v.get("option")).and_then(Value::as_str)
            .filter(|s|!s.trim().is_empty()){
            name.push_str(" / ");
            name.push_str(option.trim());
        }
    }
    if variants.map_or(false,|xs|xs.iter().any(|v|
        v.get("source").and_then(Value::as_str)==Some("DEMO")))
        && !name.starts_with("[가상] ") {
        name=format!("[가상] {name}");
    }
    item["name"]=json!(name);
    item["color"]=json!(color);
    item["variantId"]=chosen.and_then(|v|v.get("id"))
        .cloned().unwrap_or(Value::Null);
    item["defaulted"]=json!(explicit.is_empty());
    item["url"]=json!(chosen.and_then(|v|v.get("url"))
        .and_then(Value::as_str).unwrap_or(""));
    item["origin"]=p.get("origin").cloned()
        .unwrap_or(json!("FACTORY"));
    if let Some(catalog)=p.get("catalog"){item["catalog"]=catalog.clone();}
    item["unitPrice"]=chosen.map_or(Value::Null,|v|legacy_recognition_price(v,client));
    let mut issues:Vec<String>=item.get("issues").and_then(Value::as_array)
        .into_iter().flatten().filter_map(Value::as_str)
        .map(str::to_owned).collect();
    let invalid_color=p.get("colorStatus").and_then(Value::as_str)==Some("MISSING")
        || (p.get("saleUnit").and_then(Value::as_bool)!=Some(true)
            && ["색상 미표기",""].contains(&default_color));
    let missing_configuration=chosen.map_or(false,|v| {
        ["가방","바퀴"].iter().any(|token| {
            let pattern=regex::Regex::new(&format!(
                r"{token}\s*(?:미포함|포함|미장착|장착|없음|있음)"
            )).expect("configuration label");
            variants.into_iter().flatten().any(|other|
                pattern.is_match(other.get("option").and_then(Value::as_str).unwrap_or("")))
            && !pattern.is_match(v.get("option").and_then(Value::as_str).unwrap_or(""))
        })
    });
    let issue=if chosen.is_some() {
        if explicit.is_empty() && invalid_color {
            Some("기본 색상 확인 필요")
        } else if missing_configuration {
            Some("가방 또는 바퀴 포함 / 미포함 정보 확인 필요")
        } else {None}
    } else if p.get("requiresOption").and_then(Value::as_bool)==Some(true) {
        Some("상품 구성 미확정 / 판매 구성을 확인하세요")
    } else {
        Some("등록된 독립 상품을 다시 선택하세요")
    };
    if let Some(issue)=issue {
        if !issues.iter().any(|s|s==issue){issues.push(issue.to_owned());}
    }
    item["issues"]=json!(issues);
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
    // Direct translation of order-evidence.ts:140-170: parenthesized
    // delivery requests and note continuation remain separate evidence.
    let note_label = Regex::new(
        r"^\s*\(?(?:배송\s*)?(?:메세지|메시지|요청(?:사항)?|메모)(?:\s*[:：]\s*|\s+)(.*)$"
    ).expect("note");
    let mut note_continuation: Option<usize>=None;
    let mut sender_section = false;
    for line in &lines {
        let text = line.text.trim();
        if Regex::new(r"^(?:보내는\s*(?:분|사람|곳)|송하인(?:명)?)\s*[:：]")
            .expect("sender prefix").is_match(text) {
            sender_section = true;
        }
        if sender_section { continue; }
        if is_money_or_header(text) { continue; }
        // The TS recognizer extends a memo through subsequent non-field
        // lines in the same paragraph, stopping at any contact/address/item.
        if let Some(i)=note_continuation {
            let field=person_label.is_match(line.text)
                || inline_person.is_match(line.text)
                || address_begin(line.text).is_some()
                || phone.is_match(line.text)
                || is_person(text) || is_institution(text)
                || (quantity::extract(line.text).len()>0
                    && model::category(line.text).is_some());
            if !field && line.paragraph==events[i].paragraph {
                events[i].end=line.start+line.text.len();
                if !events[i].value.is_empty(){events[i].value.push('\n');}
                events[i].value.push_str(text);
                continue;
            }
            note_continuation=None;
        }
        if let Some(c) = note_label.captures(line.text) {
            if let Some(v) = c.get(1) {
                let value=if text.starts_with('(') {
                    v.as_str().trim_end_matches(')').trim().to_owned()
                } else {v.as_str().trim().to_owned()};
                let i=add_match(&mut events, line, v.start(), v.end(), "note",
                    value,"배송 요청사항 표제어");
                note_continuation=Some(i);
            }
            continue;
        }

        // order-evidence.ts:170-188: an indented building/floor line
        // is continuation of the preceding address, never a new item.
        if line.text.starts_with("  ") && address_begin(line.text).is_none()
            && !phone.is_match(line.text)
            && !is_person(text)
            && Regex::new(r"\d+\s*(?:층|호)").expect("address detail").is_match(text) {
            if let Some(previous)=events.iter().rev()
                .find(|e|e.kind=="address" && e.paragraph==line.paragraph) {
                if previous.start<line.start
                    && !events.iter().any(|e|e.start>previous.end
                        && e.start<line.start
                        && (e.kind=="name"||e.kind=="phone"||e.kind=="mobile"||e.kind=="product")) {
                    let at=line.text.find(text).unwrap_or(0);
                    add_match(&mut events,line,at,at+text.len(),"address",
                        text.to_owned(),"들여쓰기된 상세주소 연속 행");
                    continue;
                }
            }
        }

        let address = address_begin(line.text);
        // parser.ts::parseLegacy masks complete phone numbers *before*
        // interpreting a mixed address/phone row. A phone is a distinct
        // contact field, not part of the recipient's delivery address.
        if let Some(start) = address {
            let original=&line.text[start..];
            let mut without_phones=original.to_owned();
            let spans:Vec<_>=phone.find_iter(original)
                .map(|m|(m.start(),m.end())).collect();
            for (from,to) in spans.into_iter().rev() {
                without_phones.replace_range(from..to,&" ".repeat(to-from));
            }
            let value=without_phones.trim();
            if !value.is_empty() {
                let end=start+without_phones.trim_end().len();
                add_match(&mut events,line,start,end,"address",
                    value.to_owned(),"배송주소 원문 구간");
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
        // Port of order-evidence.ts:190-221: only an independent, trailing
        // name after a quantity, never shipping-request text in the sentence.
        let name_region = address.map_or(line.text, |at| &line.text[..at]);
        let name_region = name_region.trim_end_matches(|c: char| c.is_whitespace() || c=='ㅣ' || c=='|');
        if let Some((start,end)) = ts_semantics::trailing_product_name(name_region) {
            add_match(&mut events,line,start,end,"name",
                name_region[start..end].to_owned(),"상품 수량 뒤의 독립 수취인명");
        }
        // A column-separated (but address-sharing) row uses the same name
        // boundary, after the explicit separator and before the address.
        if let Some(at)=address {
            if let Some(c)=Regex::new(
                r"(?i)(?:\d+)\s*(?:개|대|ea|pcs)\s*[ㅣ|]\s*([가-힣]{2,5})\s*$"
            ).expect("same-line name").captures(&line.text[..at].trim_end()) {
                if let Some(m)=c.get(1) {
                    if is_person(m.as_str()) {
                        add_match(&mut events,line,m.start(),m.end(),"name",
                            m.as_str().to_owned(),"상품과 주소 사이의 독립 이름");
                    }
                }
            }
        }
        // A transcribed table can carry the recipient in its remarks column.
        if line.text.contains('|') {
            let table_recipient=Regex::new(r"\|\s*([가-힣]{2,5})\s*/")
                .expect("table recipient");
            if let Some(c)=table_recipient.captures(line.text) {
                if let Some(name)=c.get(1) {
                    if is_person(name.as_str()) && address.map_or(true,|a|name.end()<=a) {
                        add_match(&mut events,line,name.start(),name.end(),"name",
                            name.as_str().to_owned(),"표 비고란의 수취인");
                    }
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
        let contact_spans: Vec<(usize,usize)> = phone.find_iter(line.text)
            .map(|m|(m.start(),m.end())).collect();
        if address.is_none() && ts_semantics::only_contact_or_identity(line.text,&contact_spans) {
            continue;
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

        // parser.ts::logicalLines gives the address the whole line unless
        // a recognized/quantity-qualified SKU precedes the address.
        // Never infer a product from an address's five-digit postal code.
        if let Some(begin)=address {
            if !ts_semantics::model_before_address(&line.text[..begin],state) {continue;}
        }
        let product_part = address.map_or(line.text, |begin| &line.text[..begin]);
        let trimmed = product_part.trim();
        if trimmed.is_empty() || is_money_or_header(trimmed)
            || (trimmed.contains('|') && trimmed.split('|').any(|column|
                matches!(column.trim(),"배송비"|"택배비"|"운임"))) {
            continue;
        }
        // Exact TS parser.ts contact branch: a phone/identity row must not
        // create a product even when its digits match a generic model regex.
        let trim_phones: Vec<(usize,usize)> = phone.find_iter(trimmed)
            .map(|m|(m.start(),m.end())).collect();
        let decision = model::decision_json(&model::decide(trimmed,state,client_id));
        // parser.ts::parseLegacy: a full contact may share the same physical
        // line with a valid product and quantity; filter contact-only rows,
        // not valid joint records such as "709 민판 한개 이가상 010-...".
        if ts_semantics::only_contact_or_identity(trimmed,&trim_phones)
            && quantity::extract(trimmed).is_empty()
            && decision.pointer("/match/kind").and_then(Value::as_str)==Some("UNKNOWN") {
            continue;
        }
        if !product_signal(trimmed, &decision, state) { continue; }
        // Require model/category evidence, not a value made solely from a date or contact.
        if trimmed.contains("발주일") || trimmed.contains("발송일") { continue; }
        let skip_until = ts_semantics::table_product_prefix(trimmed);
        // Never synthesize a new string and then treat its indexes as offsets
        // into raw: UTF-8/UTF-16 source-evidence contract must be lossless.
        let matched = model::decision_json(&model::decide(skip_until,state,client_id));
        let quantity_values = if trimmed.contains('|') {
            let model_end=matched.get("evidence").and_then(Value::as_object)
                .and_then(|o|o.get("end")).and_then(Value::as_u64)
                .map(|v|v as usize);
            ts_semantics::table_quantity(trimmed,model_end).map_or_else(Vec::new,
                |(value,start,end)|vec![quantity::Quantity{value,start,end}])
        } else {
            quantity::for_product(skip_until,false,
                model::products(state).iter().any(|p|model::model_names(p).iter()
                    .any(|name|model::find_term(skip_until,name,true).is_some())))
        };
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
            evidence:product_evidence,source_start:line.start+offset,
            line:line.number,raw:trimmed.to_owned(),
            decision:matched,quantities:quantity_indexes,
            common:Regex::new(r"공통|모두|전부|전원|각\s*수취인|같은\s*상품")
                .expect("common item").is_match(trimmed),
            // order-evidence.ts:358-368: a common total is not a
            // per-recipient quantity without explicit 'each' evidence.
            each:Regex::new(r"(?i)(?:각각?|수취인마다|한\s*분당).*(?:\d+|한|두|세)\s*(?:개|대)|씩")
                .expect("each-recipient quantity").is_match(trimmed),
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
        let owner = if has_leading && !anchors.is_empty() {
            anchors.iter().position(|a| events[*a].start > events[hit.evidence].start)
                .unwrap_or(anchors.len()-1)
        } else { anchor_index };
        let attach_to: Vec<usize> = if hit.common {
            (0..recipients.len()).filter(|idx| recipients[*idx]["items"]
                .as_array().map_or(true,|xs|xs.is_empty())).collect()
        } else { vec![owner] };
        for idx in attach_to {
            let id = format!("recognition:item:{}:{}", utf16(raw,events[hit.evidence].start),idx);
            let rid = recipients[idx]["id"].as_str().unwrap_or("").to_owned();
            // Direct port of order-evidence.ts:534-560:
            // - non-common goods keep their own line quantity
            // - common goods use a local detached quantity or an
            //   explicitly per-recipient ('각각'/'씩') source quantity
            // - a common document total must never be multiplied
            let selected_qty = if hit.common {
                events.iter().enumerate().find_map(|(qi,e)|
                    (e.kind=="quantity" && e.item_id.is_none()
                        && !hit.quantities.contains(&qi)
                        && !product_hits.iter().any(|p|p.line==e.line)
                        && owner_index(&anchors,&events,e.start)==idx).then_some(qi)
                ).or_else(||(hit.each && hit.quantities.len()==1)
                    .then(||hit.quantities[0]))
            } else if hit.quantities.len()==1 {
                Some(hit.quantities[0])
            } else {None};
            let unique = selected_qty.is_some();
            let quantity_value = selected_qty
                .and_then(|i|events[i].value.parse::<i64>().ok());
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
            let mut products=hit.decision["productCandidates"].clone();
            if let Some(candidates)=products.as_array_mut() {
                let base=utf16(raw,hit.source_start);
                for candidate in candidates {
                    if let (Some(start),Some(end))=(candidate["start"].as_u64(),candidate["end"].as_u64()) {
                        candidate["start"]=json!(base+start as usize);
                        candidate["end"]=json!(base+end as usize);
                    }
                }
            }
            let mut item = json!({
                "id":id,"productId":chosen,"variantId":hit.decision["variantId"],
                "raw":hit.raw,"name":name,
                "color":hit.decision["color"],"quantity":quantity_value,
                "quantityConfirmed":unique,"unitPrice":null,
                "origin":hit.decision.get("origin").and_then(Value::as_str).unwrap_or("FACTORY"),
                "defaulted":false,"recognitionReason":reason,"issues":issues,
                "url":"","match":term,
                "productCandidates":products,"sources":[],
            });
            apply_registered_item(&mut item,state,client,
                hit.decision.get("color").and_then(Value::as_str).unwrap_or(""));
            let mut sources = vec![source_json(raw,&events[hit.evidence],&rid,&id)];
            if let Some(qi)=selected_qty {
                sources.push(source_json(raw,&events[qi],&rid,&id));
                events[qi].item_id=Some(id.clone());
                events[qi].recipient=Some(idx);
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
    // parser.ts::reanalyzeWithAliases only skips automatic parsing when
    // manualClassification is truthy, not merely present (false is valid).
    let manually_classified=match old.get("manualClassification") {
        None|Some(Value::Null)|Some(Value::Bool(false))=>false,
        Some(Value::Number(n))=>n.as_f64().map_or(false,|n|n!=0.0),
        Some(Value::String(s))=>!s.is_empty(),
        _=>true,
    };
    if manually_classified {return Ok(next);}
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
    let mut recipient_rewrites=HashMap::<String,String>::new();
    let mut item_rewrites=HashMap::<String,String>::new();
    // order-evidence.ts::matchingRecipient receives the complete original
    // parsed rows, not partially updated rows from the reanalysis loop.
    let identity_rows=incoming.clone();
    for row in &mut incoming {
        let Some(index)=ts_semantics::matching_recipient(
            row,prior,&used,&identity_rows
        ) else {continue;};
        used.insert(index);
        let old_row=&prior[index];
        if let (Some(from),Some(to))=(row["id"].as_str(),old_row["id"].as_str()) {
            recipient_rewrites.insert(from.to_owned(),to.to_owned());
        }
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
                if let (Some(from),Some(to))=(item["id"].as_str(),new_id.as_str()) {
                    item_rewrites.insert(from.to_owned(),to.to_owned());
                }
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
                    for source in sources {
                        source["targetId"]=new_id.clone();
                        source["recipientId"]=old_row["id"].clone();
                    }
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
        if let Some(from)=c["recipientId"].as_str() {
            if let Some(to)=recipient_rewrites.get(from){c["recipientId"]=json!(to);}
        }
        if let Some(from)=c["itemId"].as_str() {
            if let Some(to)=item_rewrites.get(from){c["itemId"]=json!(to);}
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
