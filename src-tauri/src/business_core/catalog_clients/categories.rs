//! Native category management rules, port of src/category-tree.ts.
//! UI maps and selections stay React-owned. All candidate state mutations,
//! implicit product category reassignment and revision-safe save inputs are Rust.
use serde_json::{json, Value};
use std::collections::HashSet;
use super::{field,items};

fn category_path(cats:&[Value], id:&str)->Result<Vec<Value>,String>{
    let mut path=Vec::new();
    let mut current=id.to_owned();
    let mut seen=HashSet::new();
    while !current.is_empty(){
        if !seen.insert(current.clone()){return Err("카테고리가 순환합니다.".into())}
        let Some(cat)=cats.iter().find(|cat|field(cat,"id")==current) else {break};
        path.insert(0,cat.clone());
        current=field(cat,"parentId").to_owned();
    }
    Ok(path)
}
fn descendants(cats:&[Value],id:&str)->Result<HashSet<String>,String>{
    let mut result=HashSet::new();
    for cat in cats {
        if category_path(cats,field(cat,"id"))?
            .iter().any(|ancestor|field(ancestor,"id")==id){
            result.insert(field(cat,"id").to_owned());
        }
    }
    Ok(result)
}
fn category_ids(product:&Value)->Vec<String>{
    items(product,"categories").iter().filter_map(Value::as_str)
        .map(str::to_owned).collect()
}
fn parent_id(value:&Value)->Option<&str>{
    value.get("parentId").and_then(Value::as_str).filter(|s|!s.is_empty())
}
pub(super) fn validate(before:Option<&Value>,next:&Value)->Result<(),String>{
    let cats=items(next,"categories");
    let mut known=HashSet::new();
    for cat in cats{
        if !known.insert(field(cat,"id")){return Err("카테고리 ID가 중복됩니다.".into())}
    }
    for cat in cats{
        if field(cat,"name").trim().is_empty() ||
            parent_id(cat).is_some_and(|id|!cats.iter().any(|c|field(c,"id")==id)){
            return Err("카테고리 이름과 상위를 확인하세요.".into())
        }
        category_path(cats,field(cat,"id"))?;
    }
    for product in items(next,"products"){
        let before_product=before.and_then(|s|items(s,"products").iter()
            .find(|p|field(p,"id")==field(product,"id")));
        let Some(old)=before_product else {continue};
        if old.get("categories")==product.get("categories"){continue}
        let ids=category_ids(product);
        for id in &ids{
            if !cats.iter().any(|c|field(c,"id")==id){continue}
            let inactive=category_path(cats,id)?.iter()
                .any(|c|c.get("active")==Some(&Value::Bool(false)));
            let unchosen_child=cats.iter().any(|c|parent_id(c)==Some(id.as_str())
                && !ids.iter().any(|part|part==field(c,"id")));
            if inactive||unchosen_child{
                return Err("활성 최하위 카테고리에 배정하세요.".into())
            }
        }
    }
    Ok(())
}
fn set_product_path(product:&mut Value,cats:&[Value])->Result<(),String>{
    let ids=category_ids(product);
    if let Some(last)=ids.last(){
        product["category"]=json!(category_path(cats,last)?
            .iter().map(|part|field(part,"name")).collect::<Vec<_>>().join(" > "));
    }
    Ok(())
}
fn change(input:&Value,id:&str,name:&str,parent:Option<&str>,transfer:bool,
    guard_catalog_move:bool,guard_message:&str)->Result<Value,String>{
    // This is the original CategoryManager move check, previously in React.
    // Empty/unknown catalog roots impose no additional restriction, matching
    // catalogFromCategory() + categoryProducts() in the original UI.
    if guard_catalog_move {
        let cats=items(input,"categories");
        let target_path=category_path(cats,parent.unwrap_or(""))?;
        let destination_catalog=target_path.first().and_then(|root|
            match field(root,"id"){
                "catalog-root:BANDOSTAND"=>Some("BANDOSTAND"),
                "catalog-root:BANDOMALL"=>Some("BANDOMALL"),
                _=>None,
            });
        if let Some(catalog)=destination_catalog {
            let linked=descendants(cats,id)?;
            let mismatch=items(input,"products").iter().any(|p|{
                field(p,"deletedAt").is_empty() &&
                field(p,"supersededBy").is_empty() &&
                category_ids(p).iter().any(|cat|linked.contains(cat)) &&
                !field(p,"catalog").is_empty() && field(p,"catalog")!="DEMO" &&
                field(p,"catalog")!=catalog
            });
            if mismatch {return Err(guard_message.to_owned())}
        }
    }
    let mut next=input.clone();
    let mut cats=items(input,"categories").to_vec();
    let name=name.trim();
    if name.is_empty() || cats.iter().any(|c|
        field(c,"id")!=id && parent_id(c)==parent && field(c,"name")==name) {
        return Err("분류 이름을 확인하세요.".into())
    }
    let existing=cats.iter().any(|c|field(c,"id")==id);
    let affected=if !existing && parent.is_some_and(|p|
        !cats.iter().any(|cat|parent_id(cat)==Some(p))){
        items(input,"products").iter().filter(|p|
            category_ids(p).iter().any(|category|Some(category.as_str())==parent))
            .map(|p|field(p,"id").to_owned()).collect::<HashSet<_>>()
    }else{HashSet::new()};
    if !affected.is_empty()&&!transfer{
        return Err(format!("기존 상품 {}개 이전 확인이 필요합니다.",affected.len()))
    }
    if !existing {
        cats.push(json!({"id":id,"name":name,"parentId":parent}));
    }else if let Some(c)=cats.iter_mut().find(|cat|field(cat,"id")==id){
        c["name"]=json!(name);
        c["parentId"]=json!(parent);
    }
    let old_ancestors=category_path(items(input,"categories"),id)?
        .into_iter().rev().skip(1)
        .map(|part|field(&part,"id").to_owned()).collect::<HashSet<_>>();
    let moved=descendants(items(input,"categories"),id)?;
    let mut products=items(input,"products").to_vec();
    for product in &mut products{
        if affected.contains(field(product,"id")) {
            if let Some(old_ids)=product.get_mut("categories").and_then(Value::as_array_mut){
                for category in old_ids.iter_mut(){
                    if category.as_str()==parent {*category=json!(id);}
                }
            }
        }
        if !existing&&affected.contains(field(product,"id")){
            let ids=category_ids(product).into_iter().filter(|category|
                !cats.iter().any(|c|parent_id(c)==Some(category.as_str())))
                .collect::<Vec<_>>();
            product["categories"]=json!(ids);
        }
        if existing&&category_ids(product).iter().any(|part|moved.contains(part)){
            let ids=category_ids(product).into_iter()
                .filter(|part|!old_ancestors.contains(part)).collect::<Vec<_>>();
            product["categories"]=json!(ids);
        }
        set_product_path(product,&cats)?;
    }
    next["categories"]=json!(cats);
    next["products"]=json!(products);
    validate(Some(input),&next)?;
    Ok(json!({"state":next}))
}
fn delete(input:&Value,id:&str,destination:&str)->Result<Value,String>{
    let mut next=input.clone();
    let cats=items(input,"categories");
    if cats.iter().any(|cat|parent_id(cat)==Some(id)){
        return Err("하위 카테고리를 먼저 이동하세요.".into())
    }
    let current=cats.iter().find(|cat|field(cat,"id")==id)
        .ok_or("분류를 찾을 수 없습니다.")?;
    if !destination.is_empty(){
        let target=cats.iter().find(|cat|field(cat,"id")==destination);
        if target.is_none_or(|c|
            field(c,"id")==id ||
            parent_id(c)!=parent_id(current) ||
            c.get("active")==Some(&Value::Bool(false)) ||
            cats.iter().any(|child|parent_id(child)==Some(destination))
        ){
            return Err("같은 상위의 활성 최하위 분류를 선택하세요.".into())
        }
    }
    let updated=cats.iter().filter(|cat|field(cat,"id")!=id)
        .cloned().collect::<Vec<_>>();
    let removed_path=category_path(cats,id)?
        .iter().map(|c|field(c,"id").to_owned()).collect::<HashSet<_>>();
    let mut products=items(input,"products").to_vec();
    for product in &mut products{
        let ids=category_ids(product);
        if !ids.iter().any(|category|category==id){continue}
        let mut new_ids=Vec::new();
        let mut unique=HashSet::new();
        for category in ids.iter().filter(|cat|!removed_path.contains(cat.as_str()))
            .map(String::as_str).chain((!destination.is_empty()).then_some(destination)){
            if unique.insert(category.to_owned()){new_ids.push(category.to_owned());}
        }
        product["categories"]=json!(new_ids);
        if category_ids(product).is_empty(){
            product["category"]=json!("미분류");
        }else{
            set_product_path(product,&updated)?;
        }
    }
    next["categories"]=json!(updated);
    next["products"]=json!(products);
    validate(Some(input),&next)?;
    Ok(json!({"state":next}))
}
/// Match the two lower-volume legacy CategoriesPanel actions without
/// silently switching them to the more opinionated category-tree behavior.
fn legacy_add(input:&Value,id:&str,name:&str,parent:Option<&str>)->Result<Value,String>{
    let mut next=input.clone();
    let cats=items(input,"categories");
    let trimmed=name.trim();
    if trimmed.is_empty(){return Err("분류 이름을 입력하세요.".into())}
    if !name.chars().any(|c|('가'..='힣').contains(&c)) ||
        trimmed=="미분류"||(parent.is_none()&&trimmed=="악세사리"){
        return Err("한글 분류명을 사용하세요. 미분류는 검토 상태이며, 스탠드 악세사리는 별도 대분류를 사용합니다.".into())
    }
    if cats.iter().any(|cat|field(cat,"name")==trimmed&&parent_id(cat)==parent){
        return Err("같은 분류가 있습니다.".into())
    }
    let mut updated=cats.to_vec();
    updated.push(json!({"id":id,"name":trimmed,"parentId":parent}));
    next["categories"]=json!(updated);
    Ok(json!({"state":next}))
}
fn legacy_rename(input:&Value,id:&str,name:&str)->Result<Value,String>{
    let mut next=input.clone();
    let trimmed=name.trim();
    if trimmed.is_empty(){return Err("분류 이름을 입력하세요.".into())}
    let cat=items(input,"categories").iter().find(|c|field(c,"id")==id)
        .ok_or("분류를 찾을 수 없습니다.")?;
    let old_name=field(cat,"name");
    if let Some(categories)=next.get_mut("categories").and_then(Value::as_array_mut){
        if let Some(target)=categories.iter_mut().find(|c|field(c,"id")==id){
            target["name"]=json!(trimmed);
        }
    }
    if let Some(products)=next.get_mut("products").and_then(Value::as_array_mut){
        for product in products.iter_mut(){
            if category_ids(product).iter().any(|category|category==id){
                let current=field(product,"category").to_owned();
                product["category"]=json!(current.replacen(old_name,trimmed,1));
            }
        }
    }
    Ok(json!({"state":next}))
}
pub(super) fn execute(operation:&str,payload:&Value)->Result<Value,String>{
    let state=payload.get("state").ok_or("현재 상태가 없습니다.")?;
    let id=field(payload,"categoryId");
    match operation{
        "change_category"=>change(state,id,field(payload,"name"),
            payload.get("parentId").and_then(Value::as_str),
            payload.get("transfer")==Some(&Value::Bool(true)),
            payload.get("guardCatalogMove")==Some(&Value::Bool(true)),
            field(payload,"guardError")),
        "delete_category"=>delete(state,id,field(payload,"destination")),
        "legacy_add_category"=>legacy_add(state,id,field(payload,"name"),
            payload.get("parentId").and_then(Value::as_str)),
        "legacy_rename_category"=>legacy_rename(state,id,field(payload,"name")),
        "validate_categories"=>{
            validate(payload.get("before"),state)?;
            Ok(json!({"valid":true}))
        }
        _=>Err(format!("지원하지 않는 카테고리 관리 업무입니다: {operation}"))
    }
}
#[cfg(test)]
mod tests{
    use super::*;
    #[test]
    fn changing_category_preserves_order_and_product_identity(){
        let state=json!({
            "categories":[{"id":"root","name":"기존","parentId":null}],
            "products":[{"id":"p1","name":"상품","categories":["root"],
                "category":"기존"}],"orders":[{"id":"o1","price":12000}]
        });
        let r=change(&state,"root","변경",None,false,false,"").unwrap();
        assert_eq!(r["state"]["products"][0]["category"],"변경");
        assert_eq!(r["state"]["products"][0]["id"],"p1");
        assert_eq!(r["state"]["orders"][0]["price"],12000);
    }
}
