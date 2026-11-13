//! Full catalog audit against the committed, immutable 360-product seed.
//! No fake products or mock match engine. This calls the production Rust path.
//!
//! Accuracy policy:
//! 1. Full unique registered name: expected exact productId.
//! 2. Identical registered full names: a name alone must not select one SKU.
//! 3. Model-only: if several independently registered products share the lead,
//!    selecting one without evidence is UNSAFE.
//! 4. Model+registered color: never choose outside the matching lead/color set.
//!    Where two products share that combination, do not select arbitrarily.
use crate::recognition;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

fn seed() -> Value {
    serde_json::from_str(include_str!("../../../../src-tauri/resources/state-seed.json"))
        .expect("committed 360-product seed")
}

fn key(s: &str) -> String {
    s.chars().filter(|c|!c.is_whitespace())
        .flat_map(char::to_uppercase).collect()
}
fn registered_color(s: &str) -> Option<&'static str> {
    match s.trim().to_lowercase().as_str() {
        "black"|"블랙"|"검정"|"검정색" => Some("Black"),
        "white"|"화이트"|"흰색" => Some("White"),
        "brown"|"브라운" => Some("Brown"),
        "gray"|"grey"|"그레이"|"회색" => Some("Gray"),
        "silver"|"실버" => Some("Silver"),
        "red"|"레드" => Some("Red"),
        "blue"|"블루" => Some("Blue"),
        "gold"|"골드" => Some("Gold"),
        "chrome"|"크롬" => Some("Chrome"),
        "clear"|"클리어" => Some("Clear"),
        "frost"|"프로스트" => Some("Frost"),
        _ => None,
    }
}
fn match_id(text: &str,state: &Value) -> (Option<String>,String) {
    let outcome=recognition::execute("match_products",json!({
        "text":text,"state":state
    })).unwrap_or_else(|e|panic!("match_products failed for {text}: {e}"));
    (outcome["productId"].as_str().map(str::to_owned),
        outcome["match"]["kind"].as_str().unwrap_or("?").to_owned())
}

/// A self-contained machine-readable CI report: always emit all anomalies,
/// including null results, to distinguish lack of evidence from a wrong SKU.
#[test]
fn complete_360_product_name_matching_audit() {
    let state=seed();
    let products=state["products"].as_array().expect("seed products");
    assert_eq!(products.len(),360,"this audit requires the exact 360 SKU seed");
    let mut names=BTreeMap::<String,BTreeSet<String>>::new();
    for p in products {
        let name=p["name"].as_str().expect("name");
        let id=p["id"].as_str().expect("id");
        names.entry(name.to_owned()).or_default().insert(id.to_owned());
    }
    let mut exact=0;
    let mut unresolved_unique=Vec::new();
    let mut wrong_unique=Vec::new();
    let mut safely_ambiguous=0;
    let mut unsafe_duplicate=Vec::new();
    for (index,p) in products.iter().enumerate() {
        let name=p["name"].as_str().unwrap();
        let expected=p["id"].as_str().unwrap();
        let (actual,kind)=match_id(name,&state);
        let peers=&names[name];
        if peers.len()>1 {
            if let Some(chosen)=actual {
                unsafe_duplicate.push(json!({
                    "index":index,"name":name,"expectedCandidates":peers,
                    "got":chosen,"match":kind
                }));
            } else {safely_ambiguous+=1;}
        } else {
            match actual {
                Some(chosen) if chosen==expected =>exact+=1,
                Some(chosen)=>wrong_unique.push(json!({
                    "index":index,"name":name,"expected":expected,
                    "got":chosen,"match":kind
                })),
                None=>unresolved_unique.push(json!({
                    "index":index,"name":name,"expected":expected,
                    "match":kind
                })),
            }
        }
    }
    println!("CATALOG_FULL_NAME_SUMMARY {}",json!({
        "checked":360,"distinctNames":names.len(),"exact":exact,
        "unresolvedUnique":unresolved_unique.len(),
        "wrongUnique":wrong_unique.len(),
        "safelyAmbiguousDuplicate":safely_ambiguous,
        "unsafeDuplicate":unsafe_duplicate.len()
    }));
    for x in &wrong_unique {println!("CATALOG_WRONG {}",x);}
    for x in &unresolved_unique {println!("CATALOG_UNRESOLVED {}",x);}
    for x in &unsafe_duplicate {println!("CATALOG_UNSAFE_DUPLICATE {}",x);}
    assert!(wrong_unique.is_empty() && unsafe_duplicate.is_empty(),
        "unsafe full-name recognition: {} wrong products, {} arbitrarily selected duplicate names",
        wrong_unique.len(),unsafe_duplicate.len());
}

/// The model lead itself (before /) must not cause false positive matches.
/// Separate exact-code uniqueness from shared-code option/color ambiguity.
#[test]
fn complete_distinct_model_and_color_matching_audit() {
    let state=seed();
    let products=state["products"].as_array().expect("seed products");
    assert_eq!(products.len(),360);
    let mut leads=BTreeMap::<String,(String,BTreeSet<String>)>::new();
    let mut colors=BTreeMap::<(String,String),(String,BTreeSet<String>)>::new();
    for p in products {
        let lead=p["name"].as_str().unwrap().split('/').next().unwrap().trim();
        let id=p["id"].as_str().unwrap();
        let k=key(lead);
        let entry=leads.entry(k.clone()).or_insert_with(||(lead.to_owned(),BTreeSet::new()));
        entry.1.insert(id.to_owned());
        if let Some(color)=p["defaultColor"].as_str().and_then(registered_color){
            let entry=colors.entry((k,color.to_owned()))
                .or_insert_with(||(lead.to_owned(),BTreeSet::new()));
            entry.1.insert(id.to_owned());
        }
    }
    let mut safe=0;
    let mut unresolved=0;
    let mut outside=Vec::new();
    let mut guessed=Vec::new();
    for (_, (lead,ids)) in &leads {
        let (actual,kind)=match_id(lead,&state);
        match actual {
            None=>unresolved+=1,
            Some(got) if ids.contains(&got) && ids.len()==1=>safe+=1,
            Some(got) if ids.contains(&got)=>guessed.push(json!({
                "probe":lead,"ids":ids,"got":got,"match":kind
            })),
            Some(got)=>outside.push(json!({
                "probe":lead,"expectedSet":ids,"got":got,"match":kind
            }))
        }
    }
    let mut safe_color=0;
    let mut unresolved_color=0;
    let mut outside_color=Vec::new();
    let mut guessed_color=Vec::new();
    for ((_,color),(lead,ids)) in &colors {
        let input=format!("{lead} {color}");
        let (actual,kind)=match_id(&input,&state);
        match actual {
            None=>unresolved_color+=1,
            Some(got) if ids.contains(&got) && ids.len()==1=>safe_color+=1,
            Some(got) if ids.contains(&got)=>guessed_color.push(json!({
                "probe":input,"ids":ids,"got":got,"match":kind
            })),
            Some(got)=>outside_color.push(json!({
                "probe":input,"expectedSet":ids,"got":got,"match":kind
            }))
        }
    }
    println!("CATALOG_MODEL_COLOR_SUMMARY {}",json!({
        "distinctModelProbes":leads.len(),"safeUniqueModel":safe,
        "unresolvedModel":unresolved,"outsideModel":outside.len(),
        "unsafeAmbiguousModel":guessed.len(),
        "modelColorProbes":colors.len(),"safeUniqueModelColor":safe_color,
        "unresolvedModelColor":unresolved_color,
        "outsideModelColor":outside_color.len(),
        "unsafeAmbiguousModelColor":guessed_color.len()
    }));
    for x in &outside {println!("MODEL_OUTSIDE {}",x);}
    for x in &guessed {println!("MODEL_UNSAFE_GUESS {}",x);}
    for x in &outside_color {println!("COLOR_OUTSIDE {}",x);}
    for x in &guessed_color {println!("COLOR_UNSAFE_GUESS {}",x);}
    assert!(outside.is_empty() && guessed.is_empty()
        && outside_color.is_empty() && guessed_color.is_empty(),
        "wrong or speculative model-only/color match: {}, {}, {}, {}",
        outside.len(),guessed.len(),outside_color.len(),guessed_color.len());
}
