//! Native freight display and editor projections, original oracle:
 //! src/shipping.ts::{effectiveShippingRule, combinationCurrent, editableShippingRule}.
 //! Shipping calculations and history remain in rules::shipping; this is read-only.
use serde_json::{json,Value};
use super::{field,find_by_id,rows,str_field,flag,has_value};
fn list<'a>(value:&'a Value,key:&str)->&'a [Value]{
    rows(field(value,key))
}


fn edit_rule(rule:&Value)->Value {
    let mut edited=rule.clone();
    let per_item=field(rule,"perItem").as_i64();
    if let Some(price)=per_item.filter(|p| (0..=9_007_199_254_740_991).contains(p)) {
        if !field(&edited,"fees").is_object(){edited["fees"]=json!({});}
        edited["fees"]["1"]=json!(price);
        edited["perItem"]=Value::Null;
        edited["maxBundle"]=json!(1);
        edited["maxConfirmed"]=json!(true);
    }
    edited
}
fn current_combo(combination:&Value,state:&Value)->bool {
    let shipping=field(state,"shipping");
    if !shipping.is_object() || !flag(combination,"active") ||
        field(combination,"epoch") != field(shipping,"epoch") {return false;}
    let Some(versions)=field(combination,"versions").as_object() else{return true;};
    for (key,version) in versions {
        let expected=version.as_str().unwrap_or("");
        if let Some(group_id)=key.strip_prefix("group:"){
            let Some(group)=list(shipping,"groups").iter().find(|g|
                str_field(g,"id")==group_id) else{return false;};
            if str_field(field(group,"current"),"version")!=expected ||
                !field(group,"current").is_object() {return false;}
        }else if let Some(product_id)=key.strip_prefix("product:"){
            let rule=field(field(shipping,"productRules"),product_id);
            let version=rule.get("version").and_then(Value::as_str)
                .unwrap_or("unregistered");
            if version != expected {return false;}
        }else if let Some(product_id)=key.strip_prefix("assignment:"){
            let assigned=find_by_id(field(state,"products"),product_id)
                .and_then(|p|p.get("shippingGroupId")).and_then(Value::as_str)
                .unwrap_or("individual");
            if assigned!=expected{return false;}
        }else{
            let group=list(shipping,"groups").iter().find(|g|str_field(g,"id")==key);
            if group.and_then(|g|field(g,"current").get("version"))
                .and_then(Value::as_str)!=Some(expected) {return false;}
        }
    }
    true
}
pub(super) fn project(payload:&Value)->Result<Value,String>{
    let state=payload.get("state").ok_or("운임 상태가 없습니다.")?;
    let shipping=field(state,"shipping");
    let mut effective=Vec::new();
    for product in list(state,"products"){
        let pid=str_field(product,"id");
        let group_id=str_field(product,"shippingGroupId");
        let group=list(shipping,"groups").iter().find(|g|
            str_field(g,"id")==group_id && !has_value(field(g,"deletedAt")));
        let rule=group.and_then(|g|g.get("current")).filter(|r|!r.is_null())
            .or_else(||field(shipping,"productRules").get(pid));
        effective.push(json!({
            "productId":pid,
            "group":group.cloned(),
            "rule":rule.cloned(),
            "editableRule":rule.filter(|v|v.is_object()).map(edit_rule)
        }));
    }
    let groups=list(shipping,"groups").iter().map(|group|
        json!({"id":field(group,"id"),
            "editableRule":edit_rule(field(group,"current"))})
    ).collect::<Vec<_>>();
    let combinations=list(shipping,"combinations").iter().map(|combination|
        json!({"id":field(combination,"id"),
            "current":current_combo(combination,state)})
    ).collect::<Vec<_>>();
    Ok(json!({"effective":effective,"groups":groups,"combinations":combinations}))
}
#[cfg(test)]
mod tests{
    use super::*;
    #[test]
    fn per_item_shipping_edit_and_assignment_revision(){
        let s=json!({"products":[{"id":"p1","shippingGroupId":"g1"},
            {"id":"p2"}],"shipping":{"epoch":3,
            "groups":[{"id":"g1","current":{"version":"v1",
                "perItem":3000,"maxBundle":4,"maxConfirmed":false,"fees":{}}}],
            "productRules":{"p2":{"version":"v2","fees":{"1":2500}}},
            "combinations":[{"id":"c1","active":true,"epoch":3,
                "versions":{"group:g1":"v1","assignment:p1":"g1"}}]}});
        let r=project(&json!({"state":s})).unwrap();
        assert_eq!(r["effective"][0]["editableRule"]["fees"]["1"],3000);
        assert_eq!(r["effective"][0]["editableRule"]["maxBundle"],1);
        assert_eq!(r["effective"][1]["rule"]["version"],"v2");
        assert_eq!(r["combinations"][0]["current"],true);
    }
}
