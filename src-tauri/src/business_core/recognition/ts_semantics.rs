//! Ported from src/parser.ts (person, parseLegacy) and
//! src/order-evidence.ts (analyzeEvidence). Keep the original order of guards.
use regex::Regex;

/// From parser.ts:275-284 and order-evidence.ts:185-222.
pub(super) fn person(value: &str) -> bool {
    let text = value.trim_end_matches('님');
    if !Regex::new(r"^[가-힣]{2,5}$").expect("person syntax").is_match(text) {
        return false;
    }
    if Regex::new(concat!(
        r"^(?:주소|배송지|배송주소|받는곳|보내는곳|연락처|전화번호|사무실|행정실|",
        r"반도|반도스탠드|민판|무타공|비타공|한개|두개|세개|납품장소|",
        r"택배|배송비|운임|발송|배송|출고|주문|모델명|상품명|품목|수량)$"
    )).expect("excluded role").is_match(text) { return false; }
    !Regex::new(concat!(
        r"(?:아파트|빌라|센터|상가|학교|교회|성당|병원|학원|월드|도서관|",
        r"회관|지원청|주세요|감사해요|보내세요)$"
    )).expect("institution").is_match(text)
}

/// From order-evidence.ts:46-70 and parser.ts:290-315.
/// Finance and document-only lines never become product records.
pub(super) fn ignored_document_line(text: &str) -> bool {
    let t = text.trim();
    if t.is_empty() { return true; }
    if Regex::new(concat!(
        r"^(?:\d{1,3}(?:,\d{3})+(?:원)?(?:\s*(?:[+]\s*부가세|입니다.*))?|",
        r"[\d,]+\s*원(?:\s*입니다.*)?|",
        r"(?:합계|합계금액|총액|계좌번호|입금\s*계좌)\s*[:：]?.*|",
        r"[가-힣]{2,10}은행\s*[:：]?\s*[\d-]+|",
        r"배송료|배송비|택배비|운임까지.*|",
        r"발주(?:일자|일)(?:[:：\s].*)?|",
        r"수주처(?:[:：\s].*)?|발주처(?:[:：\s].*)?|",
        r"공급받는자(?:[:：\s].*)?|",
        r"품목\s*\|\s*제품명.*|NO\s*\|\s*품명.*|",
        r"납품장소|",
        r"\*+.*연락처.*\d+.*개.*|",
        r"\*+.*발송부탁.*)$"
    )).expect("document nonproduct").is_match(t) { return true; }
    if Regex::new(r"^(?:안녕하세요|안녕하십니까|감사합니다|수고하세요|좋은\s*하루)")
        .expect("greeting").is_match(t)
        && !Regex::new(r"\d{3}|(?:서울|경기|인천|경북|경남|전남|전북|강원|제주)")
            .expect("greeting details").is_match(t) { return true; }
    false
}

/// From parser.ts:321-432 and order-evidence.ts:253-291.
pub(super) fn only_contact_or_identity(text: &str, phone_spans: &[(usize,usize)]) -> bool {
    if phone_spans.is_empty() {
        return Regex::new(concat!(
            r"^(?:번호|휴대폰|핸드폰|전화(?:번호)?|연락처|TEL|휴대전화)\s*[:：]?\s*",
            r"\d[\d\s().-]*$"
        )).expect("contact label").is_match(text.trim());
    }
    let mut masked = text.to_owned();
    for &(start,end) in phone_spans.iter().rev() {
        if start <= end && end <= masked.len()
            && masked.is_char_boundary(start) && masked.is_char_boundary(end) {
            masked.replace_range(start..end, &" ".repeat(end-start));
        }
    }
    let remainder = Regex::new(
        r"(?i)(?:번호|휴대폰|핸드폰|전화(?:번호)?|휴대전화|연락처|TEL|수취인명|받는\s*사람|수령자|성함|이름)\s*[:：]?"
    ).expect("identity label").replace_all(&masked," ");
    let remainder = remainder.trim();
    if remainder.is_empty() || person(remainder) { return true; }
    if Regex::new(r"^[가-힣]{2,5}\s*(?:님)?$").expect("inline name").is_match(remainder) {
        return true;
    }
    let has_product = Regex::new(
        r"(?i)(?:보면대|악보대|스탠드|거치대|트레이|홀더|의자|가방|\bBD[\s-]*[A-Z0-9]+|[A-Z]{2,5}[-\s]?\d+|\d{3}(?:-\d+)?\s*(?:개|대|EA|PCS))"
    ).expect("remaining product").is_match(remainder);
    !has_product
}

/// From order-evidence.ts:185-221. An end-of-line person is
/// independent of the model/quantity; shipping requests are not people.
pub(super) fn trailing_product_name(text: &str) -> Option<(usize,usize)> {
    let re = Regex::new(
        r"(?i)(?:\d+)\s*(?:개|대|세트|ea|pcs)\s+([가-힣]{2,5})(?:님)?\s*$"
    ).expect("trailing recipient");
    let m = re.captures(text)?.get(1)?;
    if !person(m.as_str()) { return None; }
    if Regex::new(
        r"(?:보면대|스탠드|마이크|교회|학교|성당|병원|학원|도서관|회관|센터|배송|출고|발송|요청|선불|착불|확인|주세요|감사|택배|부탁)"
    ).expect("nonperson tail").is_match(m.as_str()) { return None; }
    Some((m.start(),m.end()))
}

/// Original-table bytes retain their positions. Never rebuild with join.
pub(super) fn table_product_prefix(text: &str) -> &str {
    if !text.contains('|') { return text; }
    let bars: Vec<usize> = text.match_indices('|').map(|(i,_)|i).collect();
    if bars.len() >= 4 { &text[..bars[3]] } else { text }
}

/// From order-evidence.ts's product-quantity association, table fields.
pub(super) fn table_quantity(text: &str, model_end: Option<usize>) -> Option<(i64,usize,usize)> {
    let start = model_end.unwrap_or(0);
    if start > text.len() || !text.is_char_boundary(start) { return None; }
    let field = Regex::new(r"\|\s*([1-9]\d*)\s*(?:\||$)")
        .expect("table quantity");
    let m = field.captures(&text[start..])?.get(1)?;
    Some((m.as_str().parse().ok()?,start+m.start(),start+m.end()))
}

/// Direct port of parser.ts:102-149 (logicalLines): when a line contains
/// a delivery address, its prefix is an order item only if a real registered
/// model is present, or an unknown three-digit SKU also has an explicit
/// quantity. Do not turn five-digit postal codes into fake SKUs.
pub(super) fn model_before_address(prefix: &str, state: &serde_json::Value) -> bool {
    let known=super::model::products(state).iter().any(|p|
        super::model::model_names(p).iter()
            .any(|name|super::model::find_term(prefix,name,true).is_some()));
    if known { return true; }
    let model=Regex::new(r"(?i)(?:BD\s*)?\d{3}[A-Za-z0-9-]*")
        .expect("legacy unknown model");
    let unknown=model.find_iter(prefix).any(|m|{
        let before=prefix[..m.start()].chars().next_back();
        let after=prefix[m.end()..].chars().next();
        // The three-digit unknown model must not be a postal number,
        // telephone or part of a longer numeric field.
        before.map_or(true,|c|!c.is_ascii_digit() && c!='(')
            && after.map_or(true,|c|!c.is_ascii_digit())
    });
    unknown && !super::quantity::extract(prefix).is_empty()
}

/// Port of src/order-evidence.ts:609-650 (matchingRecipient).
/// Names are identified by *original evidence*, not by mutable display text.
/// A previously confirmed field is inherited only when the delivery
/// identity is unique in both the previous and incoming documents.
fn source_names(row: &serde_json::Value) -> Vec<String> {
    let mut found=Vec::new();
    for source in row.get("sources").and_then(serde_json::Value::as_array)
        .into_iter().flatten() {
        if source["field"]!="name" { continue; }
        if let Some(value)=source["text"].as_str() {
            let name=value.trim().to_owned();
            if !found.contains(&name) { found.push(name); }
        }
    }
    found
}
fn same_source_identity(a: &serde_json::Value, b: &serde_json::Value) -> bool {
    let a_names=source_names(a);
    let b_names=source_names(b);
    if a_names.len()==1 && b_names.len()==1 {
        return a_names[0]==b_names[0];
    }
    a_names.is_empty() && b_names.is_empty()
        && a["address"]==b["address"] && a["mobile"]==b["mobile"]
        && a["phone"]==b["phone"]
}
pub(super) fn matching_recipient(
    incoming: &serde_json::Value, previous: &[serde_json::Value],
    used: &std::collections::HashSet<usize>,
    incoming_rows: &[serde_json::Value],
) -> Option<usize> {
    let eligible:Vec<usize>=(0..previous.len()).filter(|i|!used.contains(i)).collect();
    let anchor=incoming.pointer("/evidence/anchorId").and_then(serde_json::Value::as_str)
        .filter(|s|!s.is_empty());
    if let Some(anchor)=anchor {
        let exact:Vec<usize>=eligible.iter().copied().filter(|i|
            previous[*i].pointer("/evidence/anchorId").and_then(serde_json::Value::as_str)
                == Some(anchor) && same_source_identity(incoming,&previous[*i])
        ).collect();
        if exact.len()==1 {return exact.first().copied();}
    }
    let original_name=incoming.get("sources").and_then(serde_json::Value::as_array)
        .and_then(|xs|xs.iter().find(|s|s["field"]=="name"));
    if let Some(name)=original_name {
        let by_source:Vec<usize>=eligible.iter().copied().filter(|i|{
            let old=&previous[*i];
            source_names(old).len()==1 && old.get("sources")
                .and_then(serde_json::Value::as_array).map_or(false,|sources|
                    sources.iter().any(|s|
                        s["field"]=="name" && s["start"]==name["start"]
                        && s["text"]==name["text"]))
        }).collect();
        if by_source.len()==1 {return by_source.first().copied();}
    }
    let candidates:Vec<usize>=eligible.iter().copied().filter(|i|
        same_source_identity(incoming,&previous[*i])).collect();
    if candidates.len()!=1 {return None;}
    let identity_count=incoming_rows.iter().filter(|row|
        same_source_identity(incoming,row)).count();
    if identity_count==1 {candidates.first().copied()} else {None}
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn original_person_guard() {
        assert!(person("이가상"));
        assert!(!person("납품장소"));
        assert!(!person("택배"));
        assert!(trailing_product_name("BD-950 *2개 선출고부탁드립니다.").is_none());
    }
    #[test]
    fn preserve_original_table_byte_spans() {
        let input="연주용의자 | BB-3 | EA | 1 | 여가상 / 0502-1234-5678";
        let prefix=table_product_prefix(input);
        assert!(input.starts_with(prefix));
        let (value,start,end)=table_quantity(input,Some(input.find("BB-3").unwrap()+4)).unwrap();
        assert_eq!(value,1);
        assert_eq!(&input[start..end],"1");
    }
    #[test]
    fn contact_not_a_model() {
        assert!(only_contact_or_identity("TEL 031-123-4567",&[(4,16)]));
        assert!(only_contact_or_identity("김가상 010-1234-5678",&[(10,23)]) || person("김가상"));
    }
}
