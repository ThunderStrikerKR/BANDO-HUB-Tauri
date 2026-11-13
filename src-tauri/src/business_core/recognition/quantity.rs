use regex::Regex;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Quantity {
    pub value: i64,
    pub start: usize,
    pub end: usize,
}

fn korean_number(text: &str) -> Option<i64> {
    Some(match text {
        "한" | "하나" | "일" => 1,
        "두" | "둘" | "이" => 2,
        "세" | "셋" | "삼" => 3,
        "네" | "넷" | "사" => 4,
        "다섯" | "오" => 5,
        "여섯" | "육" => 6,
        "일곱" | "칠" => 7,
        "여덟" | "팔" => 8,
        "아홉" | "구" => 9,
        "열" | "십" => 10,
        _ => return None,
    })
}

pub(crate) fn extract(text: &str) -> Vec<Quantity> {
    let pattern = Regex::new(
        r"(?i)(\d+|다섯|여섯|일곱|여덟|아홉|하나|둘|셋|넷|한|두|세|네|열|일|이|삼|사|오|육|칠|팔|구|십)\s*(?:개|대|세트|ea|pcs)|[x×*]\s*(\d+)",
    ).expect("quantity expression");
    let mut found = Vec::new();
    for capture in pattern.captures_iter(text) {
        let whole = capture.get(0).expect("full match");
        let number = capture.get(2).or_else(|| capture.get(1)).expect("quantity number");
        // parser.ts::quantities excludes model dimensions such as x10cm,
        // x10 mm and false unit prefixes such as 1EAS. Rust regex does
        // not support look-ahead, so validate the following bytes explicitly.
        let following = &text[whole.end()..];
        if capture.get(2).is_some()
            && Regex::new(r"(?i)^\\s*(?:cm|mm)\\b").expect("dimension guard")
                .is_match(following) {
            continue;
        }
        if following.chars().next().map_or(false,|c|c.is_ascii_alphabetic()) {
            continue;
        }
        // A model identifier must not be interpreted as a quantity.
        if whole.start() > 0 && text[..whole.start()].ends_with('-') {
            let prefix = &text[..whole.start() - 1];
            // A dash immediately after a closed option, e.g. "709(블랙)-1개",
            // separates the quantity. "709-1개" and negative "-1개" do not.
            if !matches!(prefix.chars().next_back(), Some(')') | Some(']')) {
                continue;
            }
        }
        let value = number.as_str().parse::<i64>().ok()
            .or_else(|| korean_number(number.as_str()));
        if let Some(value) = value.filter(|v| *v > 0) {
            found.push(Quantity { value, start: whole.start(), end: whole.end() });
        }
    }
    found
}

/// Rows transcribed from an order table may use a bare numeric quantity column.
pub(crate) fn for_product(text: &str, allow_table: bool, allow_trailing: bool) -> Vec<Quantity> {
    let explicit = extract(text);
    if !explicit.is_empty() { return explicit; }
    if allow_table {
        let pattern = Regex::new(r"\|\s*([1-9]\d*)\s*(?:\||$)").expect("table quantity");
        let first = pattern.captures_iter(text).next();
        if let Some(c) = first {
            if let (Some(whole), Some(value)) = (c.get(0), c.get(1)) {
                if let Ok(number) = value.as_str().parse::<i64>() {
                    return vec![Quantity { value: number, start: whole.start() + 1, end: whole.end() - usize::from(whole.as_str().ends_with('|')) }];
                }
            }
        }
    }
    if allow_trailing {
        let pattern = Regex::new(r"\s+([1-9]\d*)\s*$").expect("trailing quantity");
        if let Some(c) = pattern.captures(text) {
            if let Some(value) = c.get(1) {
                if let Ok(number) = value.as_str().parse::<i64>() {
                    return vec![Quantity { value: number, start: value.start(), end: value.end() }];
                }
            }
        }
    }
    vec![]
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn quantity_with_korean_and_case_insensitive_units() {
        assert_eq!(extract("709 민판 한개 / Cart-10 2EA").iter().map(|q| q.value).collect::<Vec<_>>(), vec![1, 2]);
        assert_eq!(extract("Desk TS-2 * 1EA")[0].value, 1);
        assert_eq!(extract("709(블랙)-1개")[0].value, 1);
        assert!(extract("709-1개").is_empty());
    }
    #[test]
    fn original_type_script_quantity_boundaries() {
        assert!(extract("x10cm").is_empty());
        assert!(extract("x10mm").is_empty());
        assert!(extract("x10 cm").is_empty());
        assert!(extract("1EAS").is_empty());
        assert_eq!(extract("2EA")[0].value,2);
        assert_eq!(extract("x2")[0].value,2);
    }
    #[test]
    fn no_fabricated_quantity() {
        assert!(for_product("BD CONDUCTOR", false, true).is_empty());
        assert!(for_product("Cart-10", false, true).is_empty());
    }
    #[test]
    fn table_and_trailing_number() {
        assert_eq!(for_product("연주용의자 | BB-3 | EA | 1 | 여가상", true, false)[0].value, 1);
        assert_eq!(for_product("BC-105 1", false, true)[0].value, 1);
    }
}
