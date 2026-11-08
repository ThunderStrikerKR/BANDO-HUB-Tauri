//! Relational, SQLite-native source of truth for the stable business core.
//! React still receives the existing State shape; this adapter reconstructs
//! products, clients and orders from constrained rows. Other workflow modules
//! continue to use the compatibility envelope until separately migrated.
//!
//! Version 2 is an atomic, one-time conversion of an existing JSON snapshot.
//! There is deliberately no automatic fallback to a new seed after failure.
use super::{err, valid_state};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

const CORE_KEYS: [&str; 3] = ["products", "clients", "orders"];

/// Existing developer data is not throwaway: create a verified, immutable
/// pre-migration copy before adding tables or removing the legacy core arrays.
/// New empty databases skip this, because they are seeded after opening.
pub(super) fn backup_legacy_if_needed(conn:&Connection,path:&std::path::Path)->Result<(),String>{
    if active(conn)? { return Ok(()); }
    let found:bool=conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='app_state')",
        [],|r|r.get(0)).map_err(err)?;
    if !found { return Ok(()); }
    let previous:String=conn.query_row("SELECT payload FROM app_state WHERE id=1",[],|r|r.get(0)).map_err(err)?;
    valid_state(&super::get_snapshot(conn)?)?;
    let dir=path.parent().ok_or("DB 파일의 폴더가 없습니다.")?.join("backups");
    std::fs::create_dir_all(&dir).map_err(err)?;
    let nanos=std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).map_err(err)?.as_nanos();
    let filename=format!("pre-relational-{}-{nanos}.sqlite",std::process::id());
    let dest=dir.join(filename);
    let outcome=(||{
        conn.execute("VACUUM INTO ?1",[dest.to_string_lossy().to_string()]).map_err(err)?;
        let copy=Connection::open_with_flags(&dest,rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(err)?;
        let status:String=copy.query_row("PRAGMA integrity_check",[],|r|r.get(0)).map_err(err)?;
        if status!="ok" { return Err(format!("마이그레이션 안전 백업이 손상됐습니다: {status}")); }
        let text:String=copy.query_row("SELECT payload FROM app_state WHERE id=1",[],|r|r.get(0)).map_err(err)?;
        if text!=previous { return Err("마이그레이션 안전 백업 데이터가 원본과 다릅니다.".into()); }
        Ok::<_,String>(())
    })();
    if outcome.is_err() { let _=std::fs::remove_file(&dest); }
    outcome?;
    Ok(())
}

fn sql_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(r#"
        CREATE TABLE IF NOT EXISTS core_schema(
            key TEXT PRIMARY KEY, version INTEGER NOT NULL CHECK(version > 0)
        );
        CREATE TABLE IF NOT EXISTS core_products(
            id TEXT PRIMARY KEY, position INTEGER NOT NULL,
            code TEXT NOT NULL, name TEXT NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload))
        );
        CREATE INDEX IF NOT EXISTS idx_core_products_name ON core_products(name);
        CREATE INDEX IF NOT EXISTS idx_core_products_code ON core_products(code);
        CREATE TABLE IF NOT EXISTS core_product_prices(
            product_id TEXT PRIMARY KEY REFERENCES core_products(id) ON DELETE CASCADE,
            price_record_id TEXT NOT NULL UNIQUE,
            color TEXT NOT NULL,
            wholesale INTEGER CHECK(wholesale IS NULL OR wholesale >= 0),
            semi INTEGER CHECK(semi IS NULL OR semi >= 0),
            retail INTEGER CHECK(retail IS NULL OR retail >= 0),
            payload TEXT NOT NULL CHECK(json_valid(payload))
        );
        CREATE TABLE IF NOT EXISTS core_clients(
            id TEXT PRIMARY KEY, position INTEGER NOT NULL, name TEXT NOT NULL,
            tier TEXT NOT NULL, address TEXT NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload))
        );
        CREATE INDEX IF NOT EXISTS idx_core_clients_name ON core_clients(name);
        CREATE TABLE IF NOT EXISTS core_orders(
            id TEXT PRIMARY KEY, position INTEGER NOT NULL, client_id TEXT,
            created_at TEXT, confirmed_at TEXT, status TEXT,
            payload TEXT NOT NULL CHECK(json_valid(payload))
        );
        CREATE INDEX IF NOT EXISTS idx_core_orders_created ON core_orders(created_at);
        CREATE INDEX IF NOT EXISTS idx_core_orders_client ON core_orders(client_id);
        CREATE TABLE IF NOT EXISTS core_recipients(
            id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES core_orders(id) ON DELETE CASCADE,
            position INTEGER NOT NULL, name TEXT NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload))
        );
        CREATE INDEX IF NOT EXISTS idx_core_recipients_order ON core_recipients(order_id,position);
        CREATE TABLE IF NOT EXISTS core_items(
            id TEXT PRIMARY KEY, recipient_id TEXT NOT NULL REFERENCES core_recipients(id) ON DELETE CASCADE,
            position INTEGER NOT NULL, product_id TEXT, variant_id TEXT,
            payload TEXT NOT NULL CHECK(json_valid(payload))
        );
        CREATE INDEX IF NOT EXISTS idx_core_items_recipient ON core_items(recipient_id,position);
        CREATE INDEX IF NOT EXISTS idx_core_items_product ON core_items(product_id);
    "#).map_err(err)
}

fn schema_version(conn:&Connection)->Result<i64,String>{
    let exists:bool=conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='core_schema')",
        [],|r|r.get(0)).map_err(err)?;
    if !exists {return Ok(0);}
    Ok(conn.query_row("SELECT version FROM core_schema WHERE key='business-core'",[],
        |r|r.get::<_,i64>(0)).optional().map_err(err)?.unwrap_or(0))
}
pub(super) fn active(conn:&Connection)->Result<bool,String>{Ok(schema_version(conn)?==2)}


pub(super) fn strip_core(state: &mut Value) {
    if let Some(map) = state.as_object_mut() {
        for key in CORE_KEYS { map.remove(key); }
    }
}

fn source_list<'a>(value: &'a Value, key: &str) -> Result<&'a Vec<Value>, String> {
    value.get(key).and_then(Value::as_array)
        .ok_or_else(|| format!("{key} 목록 데이터가 없습니다."))
}

fn required_id<'a>(entry: &'a Value, label: &str) -> Result<&'a str, String> {
    entry.get("id").and_then(Value::as_str).filter(|s| !s.trim().is_empty())
        .ok_or_else(|| format!("{label} ID가 비어 있습니다."))
}

fn require_unique(seen: &mut HashSet<String>, id: &str, label: &str) -> Result<(), String> {
    if !seen.insert(id.to_string()) { return Err(format!("{label} ID 중복: {id}")); }
    Ok(())
}

fn payload(value: &Value, child: Option<&str>) -> Result<String, String> {
    let mut stripped = value.clone();
    if let Some(child) = child {
        stripped.as_object_mut()
            .ok_or("업무 데이터가 객체가 아닙니다.")?.remove(child);
    }
    serde_json::to_string(&stripped).map_err(err)
}

fn sync_prune(tx: &Transaction<'_>, table: &str, retain: &HashSet<String>) -> Result<(), String> {
    // Only called with fixed compile-time table names; no user SQL identifiers.
    let key = if table=="core_product_prices" { "product_id" } else { "id" };
    let select = format!("SELECT {key} FROM {table}");
    let mut read = tx.prepare(&select).map_err(err)?;
    let old = read.query_map([], |r| r.get::<_, String>(0)).map_err(err)?
        .collect::<Result<Vec<_>, _>>().map_err(err)?;
    drop(read);
    let sql = format!("DELETE FROM {table} WHERE {key}=?1");
    for id in old { if !retain.contains(&id) { tx.execute(&sql, [id]).map_err(err)?; } }
    Ok(())
}

/// Reconcile changed rows only. Unmodified JSON payloads do not cause SQLite
/// updates; every relation, update and removal belongs to the caller's transaction.
pub(super) fn store(tx: &Transaction<'_>, state: &Value) -> Result<(), String> {
    valid_state(state)?;
    let mut product_ids = HashSet::new();
    let mut price_ids = HashSet::new();
    let mut client_ids = HashSet::new();
    let mut order_ids = HashSet::new();
    let mut recipient_ids = HashSet::new();
    let mut item_ids = HashSet::new();

    {
        let mut statement = tx.prepare(
            "INSERT INTO core_products(id,position,code,name,payload) VALUES (?1,?2,?3,?4,?5)
             ON CONFLICT(id) DO UPDATE SET position=excluded.position,code=excluded.code,
             name=excluded.name,payload=excluded.payload
             WHERE core_products.position<>excluded.position OR core_products.payload<>excluded.payload"
        ).map_err(err)?;
        for (i, p) in source_list(state, "products")?.iter().enumerate() {
            let id = required_id(p,"상품")?;
            require_unique(&mut product_ids,id,"상품")?;
            let code = p["code"].as_str().ok_or("상품 모델코드 누락")?;
            let name = p["name"].as_str().ok_or("상품명 누락")?;
            statement.execute(params![id,i as i64,code,name,payload(p,Some("variants"))?]).map_err(err)?;
        }
    }
    {
        let mut statement = tx.prepare(
            "INSERT INTO core_product_prices(product_id,price_record_id,color,wholesale,semi,retail,payload)
             VALUES (?1,?2,?3,?4,?5,?6,?7)
             ON CONFLICT(product_id) DO UPDATE SET price_record_id=excluded.price_record_id,
             color=excluded.color,wholesale=excluded.wholesale,semi=excluded.semi,
             retail=excluded.retail,payload=excluded.payload
             WHERE core_product_prices.price_record_id<>excluded.price_record_id OR
             core_product_prices.payload<>excluded.payload"
        ).map_err(err)?;
        for p in source_list(state,"products")? {
            let owner=required_id(p,"상품")?;
            let prices=source_list(p,"variants")?;
            if prices.len()!=1 {
                return Err(format!("독립 상품 {owner}에 가격 기록이 {}개입니다. 각 판매 구성을 개별 상품으로 등록하세요.",prices.len()));
            }
            let v=&prices[0];
            let id=required_id(v,"기존 가격 식별자")?;
            require_unique(&mut price_ids,id,"가격 기록")?;
            statement.execute(params![owner,id,v["color"].as_str().unwrap_or(""),
                v["wholesale"].as_i64(),v["semi"].as_i64(),v["retail"].as_i64(),
                payload(v,None)?]).map_err(err)?;
        }
    }
    {
        let mut statement=tx.prepare(
            "INSERT INTO core_clients(id,position,name,tier,address,payload) VALUES (?1,?2,?3,?4,?5,?6)
             ON CONFLICT(id) DO UPDATE SET position=excluded.position,name=excluded.name,
             tier=excluded.tier,address=excluded.address,payload=excluded.payload
             WHERE core_clients.position<>excluded.position OR core_clients.payload<>excluded.payload"
        ).map_err(err)?;
        for (i,c) in source_list(state,"clients")?.iter().enumerate() {
            let id=required_id(c,"거래처")?;
            require_unique(&mut client_ids,id,"거래처")?;
            statement.execute(params![id,i as i64,c["name"].as_str().unwrap_or(""),
                c["tier"].as_str().unwrap_or(""),c["address"].as_str().unwrap_or(""),payload(c,None)?]).map_err(err)?;
        }
    }
    {
        let mut statement=tx.prepare(
            "INSERT INTO core_orders(id,position,client_id,created_at,confirmed_at,status,payload)
             VALUES (?1,?2,?3,?4,?5,?6,?7)
             ON CONFLICT(id) DO UPDATE SET position=excluded.position,client_id=excluded.client_id,
             created_at=excluded.created_at,confirmed_at=excluded.confirmed_at,
             status=excluded.status,payload=excluded.payload
             WHERE core_orders.position<>excluded.position OR core_orders.payload<>excluded.payload"
        ).map_err(err)?;
        for (i,o) in source_list(state,"orders")?.iter().enumerate() {
            let id=required_id(o,"주문")?;
            require_unique(&mut order_ids,id,"주문")?;
            statement.execute(params![id,i as i64,o["clientId"].as_str(),
                o["createdAt"].as_str(),o["confirmedAt"].as_str(),
                o["status"].as_str(),payload(o,Some("recipients"))?]).map_err(err)?;
        }
    }
    {
        let mut statement=tx.prepare(
            "INSERT INTO core_recipients(id,order_id,position,name,payload) VALUES (?1,?2,?3,?4,?5)
             ON CONFLICT(id) DO UPDATE SET order_id=excluded.order_id,position=excluded.position,
             name=excluded.name,payload=excluded.payload
             WHERE core_recipients.order_id<>excluded.order_id OR
             core_recipients.position<>excluded.position OR core_recipients.payload<>excluded.payload"
        ).map_err(err)?;
        for o in source_list(state,"orders")? {
            let owner=required_id(o,"주문")?;
            for (i,r) in source_list(o,"recipients")?.iter().enumerate() {
                let id=required_id(r,"수취인")?;
                require_unique(&mut recipient_ids,id,"수취인")?;
                statement.execute(params![id,owner,i as i64,r["name"].as_str().unwrap_or(""),
                    payload(r,Some("items"))?]).map_err(err)?;
            }
        }
    }
    {
        let mut statement=tx.prepare(
            "INSERT INTO core_items(id,recipient_id,position,product_id,variant_id,payload)
             VALUES (?1,?2,?3,?4,?5,?6)
             ON CONFLICT(id) DO UPDATE SET recipient_id=excluded.recipient_id,
             position=excluded.position,product_id=excluded.product_id,
             variant_id=excluded.variant_id,payload=excluded.payload
             WHERE core_items.recipient_id<>excluded.recipient_id OR
             core_items.position<>excluded.position OR core_items.payload<>excluded.payload"
        ).map_err(err)?;
        for o in source_list(state,"orders")? {
            for r in source_list(o,"recipients")? {
                let owner=required_id(r,"수취인")?;
                for (i,item) in source_list(r,"items")?.iter().enumerate() {
                    let id=required_id(item,"주문 품목")?;
                    require_unique(&mut item_ids,id,"주문 품목")?;
                    statement.execute(params![id,owner,i as i64,
                        item["productId"].as_str(),item["variantId"].as_str(),
                        payload(item,None)?]).map_err(err)?;
                }
            }
        }
    }
    // Remove children before parents so the FK check cannot observe orphans.
    sync_prune(tx,"core_items",&item_ids)?;
    sync_prune(tx,"core_recipients",&recipient_ids)?;
    sync_prune(tx,"core_orders",&order_ids)?;
    sync_prune(tx,"core_product_prices",&product_ids)?;
    sync_prune(tx,"core_products",&product_ids)?;
    sync_prune(tx,"core_clients",&client_ids)?;
    Ok(())
}

fn read_entities(conn:&Connection,sql:&str)->Result<Vec<Value>,String>{
    let mut statement=conn.prepare(sql).map_err(err)?;
    let rows=statement.query_map([],|r|r.get::<_,String>(0)).map_err(err)?;
    rows.map(|r|serde_json::from_str::<Value>(&r.map_err(err)?).map_err(err)).collect()
}
fn read_children(conn:&Connection,sql:&str)->Result<HashMap<String,Vec<Value>>,String>{
    let mut statement=conn.prepare(sql).map_err(err)?;
    let rows=statement.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).map_err(err)?;
    let mut grouped=HashMap::new();
    for row in rows {
        let (owner,json)=row.map_err(err)?;
        grouped.entry(owner).or_insert_with(Vec::new)
            .push(serde_json::from_str::<Value>(&json).map_err(err)?);
    }
    Ok(grouped)
}
fn attach(parents:&mut [Value],key:&str,mut children:HashMap<String,Vec<Value>>)->Result<(),String>{
    for parent in parents {
        let id=required_id(parent,"관계형 부모")?.to_owned();
        let nested = children.remove(&id).unwrap_or_default();
        parent.as_object_mut().ok_or("관계형 데이터 객체 오류")?
            .insert(key.to_string(),json!(nested));
    }
    if !children.is_empty() { return Err(format!("관계형 데이터에서 소유자가 없는 {key}을 발견했습니다.")); }
    Ok(())
}

pub(super) fn hydrate(conn:&Connection,state:&mut Value)->Result<(),String>{
    let version=schema_version(conn)?;
    if version==0 { return Ok(()); }
    let mut products=read_entities(conn,"SELECT payload FROM core_products ORDER BY position,id")?;
    let variants=read_children(conn,if version==1 {
        "SELECT product_id,payload FROM core_variants ORDER BY product_id,position,id"
    }else{
        "SELECT product_id,payload FROM core_product_prices ORDER BY product_id"
    })?;
    attach(&mut products,"variants",variants)?;
    let clients=read_entities(conn,"SELECT payload FROM core_clients ORDER BY position,id")?;
    let mut orders=read_entities(conn,"SELECT payload FROM core_orders ORDER BY position,id")?;
    let mut recipients=read_entities(conn,"SELECT payload FROM core_recipients ORDER BY position,id")?;
    let items=read_children(conn,
        "SELECT recipient_id,payload FROM core_items ORDER BY recipient_id,position,id")?;
    attach(&mut recipients,"items",items)?;
    let mut recipient_groups:HashMap<String,Vec<Value>>=HashMap::new();
    let mut read=conn.prepare("SELECT order_id,id FROM core_recipients ORDER BY order_id,position,id").map_err(err)?;
    let ids=read.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).map_err(err)?
        .collect::<Result<Vec<_>,_>>().map_err(err)?;
    drop(read);
    let mut by_id:HashMap<String,Value>=recipients.into_iter()
        .map(|r|Ok((required_id(&r,"수취인")?.to_owned(),r)))
        .collect::<Result<_,String>>()?;
    for (owner,id) in ids {
        let value=by_id.remove(&id).ok_or("수취인 관계형 데이터가 누락되었습니다.")?;
        recipient_groups.entry(owner).or_default().push(value);
    }
    if !by_id.is_empty() { return Err("관계형 수취인 ID가 중복되었거나 누락되었습니다.".into()); }
    attach(&mut orders,"recipients",recipient_groups)?;
    let root=state.as_object_mut().ok_or("업무 상태가 객체가 아닙니다.")?;
    root.insert("products".into(),json!(products));
    root.insert("clients".into(),json!(clients));
    root.insert("orders".into(),json!(orders));
    Ok(())
}

pub(super) fn migrate(conn:&mut Connection)->Result<(),String>{
    sql_schema(conn)?;
    let prior=schema_version(conn)?;
    if prior==2{return Ok(());}
    if prior>2 {return Err("이 프로그램보다 새로운 DB 구조입니다. 자동으로 변경하지 않았습니다.".into());}
    // Hydrate legacy v1 rows or v0.0.1 full JSON BEFORE converting.
    // A verified SQLite pre-migration backup is created by initialize_database.
    let old=super::get_snapshot(conn)?;
    valid_state(&old)?;
    let state=super::sale_unit_migration::transform(old)?;
    valid_state(&state)?;
    let tx=conn.transaction().map_err(err)?;
    store(&tx,&state)?;
    // Legacy search indexes are non-authoritative copies and rebuilt after migration.
    tx.execute("DELETE FROM product_index",[]).map_err(err)?;
    {
        let mut insert=tx.prepare(
            "INSERT INTO product_index(id,code,name,payload) VALUES (?1,?2,?3,?4)"
        ).map_err(err)?;
        for p in source_list(&state,"products")?{
            insert.execute(params![required_id(p,"상품")?,
                p["code"].as_str().ok_or("상품 코드 누락")?,
                p["name"].as_str().ok_or("상품명 누락")?,payload(p,None)?]
            ).map_err(err)?;
        }
    }
    tx.execute("DELETE FROM order_index",[]).map_err(err)?;
    {
        let mut insert=tx.prepare(
            "INSERT INTO order_index(id,client_id,created_at,confirmed_at,status)
             VALUES (?1,?2,?3,?4,?5)"
        ).map_err(err)?;
        for o in source_list(&state,"orders")?{
            insert.execute(params![required_id(o,"주문")?,
                o["clientId"].as_str().unwrap_or(""),
                o["createdAt"].as_str().unwrap_or(""),
                o["confirmedAt"].as_str(),
                o["status"].as_str().unwrap_or("REVIEW")]
            ).map_err(err)?;
        }
    }
    let mut envelope=state;
    strip_core(&mut envelope);
    tx.execute("UPDATE app_state SET payload=?1 WHERE id=1",
        [serde_json::to_string(&envelope).map_err(err)?]).map_err(err)?;
    if prior==1 {
        // An old physical option table must not remain part of the new schema.
        tx.execute("DROP TABLE core_variants",[]).map_err(err)?;
        tx.execute("UPDATE core_schema SET version=2 WHERE key='business-core'",[]).map_err(err)?;
    }else{
        tx.execute("INSERT INTO core_schema(key,version) VALUES ('business-core',2)",[]).map_err(err)?;
    }
    tx.commit().map_err(err)
}

pub(super) fn verify(conn:&Connection)->Result<(),String>{
    if !active(conn)? { return Ok(()); }
    let broken:Option<String>=conn.query_row(
        "SELECT \"table\" || ':' || rowid FROM pragma_foreign_key_check LIMIT 1",
        [],|r|r.get(0)).optional().map_err(err)?;
    if let Some(details)=broken { return Err(format!("SQLite 관계형 참조 무결성 오류: {details}")); }
    let mut snapshot:Value=serde_json::from_str(&conn.query_row(
        "SELECT payload FROM app_state WHERE id=1",[],|r|r.get::<_,String>(0)
    ).map_err(err)?).map_err(err)?;
    hydrate(conn,&mut snapshot)?;
    valid_state(&snapshot)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::time::{SystemTime,UNIX_EPOCH};
    fn temp()->std::path::PathBuf {
        let id=SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        std::env::temp_dir().join(format!("bando-relational-{}-{id}.sqlite",std::process::id()))
    }
    fn close(path:&std::path::Path) { std::fs::remove_file(path).ok(); }
    #[test]
    fn migrates_360_independent_products_from_the_site_catalog() {
        let path=temp();
        let conn=super::super::initialize_database(&path).unwrap();
        assert!(active(&conn).unwrap());
        let state=super::super::get_snapshot(&conn).unwrap();
        assert_eq!(state["products"].as_array().unwrap().len(),360);
        assert!(state["products"].as_array().unwrap().iter()
            .all(|p|p["variants"].as_array().unwrap().len()==1));
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM core_product_prices",[],|r|r.get::<_,i64>(0)).unwrap(),360);
        assert_eq!(schema_version(&conn).unwrap(),2);
        let raw:String=conn.query_row("SELECT payload FROM app_state WHERE id=1",[],|r|r.get(0)).unwrap();
        assert!(!raw.contains("\"products\""));
        assert_eq!(state["products"][0]["id"],"bando-site-358");
        verify(&conn).unwrap();
        drop(conn); close(&path);
    }
    #[test]
    fn canonical_product_order_and_exact_price_survive_reopen() {
        let path=temp();
        let mut conn=super::super::initialize_database(&path).unwrap();
        let mut state=super::super::get_snapshot(&conn).unwrap();
        let price=state["products"][0]["variants"][0]["retail"].clone();
        state["products"][0]["name"]=json!("수정 상품명");
        let state=super::super::write_snapshot(&mut conn,state,0,false).unwrap();
        assert_eq!(state["products"][0]["variants"][0]["retail"],price);
        drop(conn);
        let conn=super::super::initialize_database(&path).unwrap();
        let next=super::super::get_snapshot(&conn).unwrap();
        assert_eq!(next["products"][0]["name"],"수정 상품명");
        assert_eq!(next["products"][0]["variants"][0]["retail"],price);
        verify(&conn).unwrap();
        drop(conn);close(&path);
    }

    #[test]
    fn duplicate_price_record_id_rolls_back_every_relation_and_revision() {
        let path=temp();
        let mut conn=super::super::initialize_database(&path).unwrap();
        let before=super::super::get_snapshot(&conn).unwrap();
        let mut tampered=before.clone();
        let existing=before["products"][0]["variants"][0]["id"].clone();
        tampered["products"][1]["variants"][0]["id"]=existing;
        let result=super::super::write_snapshot(&mut conn,tampered,0,false);
        assert!(result.unwrap_err().contains("가격 기록 ID 중복"));
        assert_eq!(super::super::get_snapshot(&conn).unwrap(),before);
        verify(&conn).unwrap();
        drop(conn);close(&path);
    }
    #[test]
    fn upgrades_legacy_303_site_groups_to_360_units_with_verified_original_backup() {
        let folder=temp().with_extension("dir");
        std::fs::create_dir_all(&folder).unwrap();
        let path=folder.join("old.sqlite");
        let legacy=Connection::open(&path).unwrap();
        legacy.execute_batch("CREATE TABLE app_state(id INTEGER PRIMARY KEY,payload TEXT NOT NULL)").unwrap();
        // Exercise the *real prior 303-group layout*, not the new 360-unit seed.
        let original=include_str!("../resources/legacy-state-seed-303.json");
        let previous:Value=serde_json::from_str(original).unwrap();
        assert_eq!(previous["products"].as_array().unwrap().len(),303);
        let previous_prices=previous["products"].as_array().unwrap().iter()
            .flat_map(|p|p["variants"].as_array().unwrap())
            .map(|v|(v["id"].clone(),v["retail"].clone())).collect::<Vec<_>>();
        assert_eq!(previous_prices.len(),360);
        legacy.execute("INSERT INTO app_state(id,payload) VALUES (1,?1)",[original]).unwrap();
        drop(legacy);

        let conn=super::super::initialize_database(&path).unwrap();
        assert!(active(&conn).unwrap());
        assert_eq!(schema_version(&conn).unwrap(),2);
        let snapshot=super::super::get_snapshot(&conn).unwrap();
        assert_eq!(snapshot["products"].as_array().unwrap().len(),360);
        assert!(snapshot["products"].as_array().unwrap().iter()
            .all(|p|p["variants"].as_array().unwrap().len()==1));
        let prices=snapshot["products"].as_array().unwrap().iter()
            .map(|p|(&p["variants"][0]["id"],&p["variants"][0]["retail"]))
            .map(|(id,retail)|(id.clone(),retail.clone())).collect::<Vec<_>>();
        assert_eq!(prices,previous_prices);
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM core_product_prices",[],
            |r|r.get::<_,i64>(0)).unwrap(),360);
        verify(&conn).unwrap();

        // The original on-disk business snapshot must be retrievable *unchanged*.
        let backups=std::fs::read_dir(folder.join("backups")).unwrap()
            .map(|entry|entry.unwrap().path()).collect::<Vec<_>>();
        assert_eq!(backups.len(),1);
        let backup=Connection::open_with_flags(&backups[0],
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let backed_up:String=backup.query_row("SELECT payload FROM app_state WHERE id=1",[],
            |r|r.get(0)).unwrap();
        assert_eq!(backed_up,original);
        assert_eq!(backup.query_row("PRAGMA integrity_check",[],
            |r|r.get::<_,String>(0)).unwrap(),"ok");
        drop(backup);
        drop(conn);
        std::fs::remove_dir_all(folder).unwrap();
    }

    #[test]
    fn upgrades_existing_v1_relational_database_to_v2_without_losing_original_options() {
        let folder=temp().with_extension("v1-migration-test");
        std::fs::create_dir_all(&folder).unwrap();
        let path=folder.join("v1.sqlite");
        let mut legacy_db=Connection::open(&path).unwrap();
        legacy_db.execute_batch(r#"
            PRAGMA foreign_keys=ON;
            CREATE TABLE app_state(id INTEGER PRIMARY KEY,payload TEXT NOT NULL);
            CREATE TABLE core_schema(key TEXT PRIMARY KEY,version INTEGER NOT NULL);
            CREATE TABLE core_products(
                id TEXT PRIMARY KEY,position INTEGER NOT NULL,
                code TEXT NOT NULL,name TEXT NOT NULL,payload TEXT NOT NULL);
            CREATE TABLE core_variants(
                id TEXT PRIMARY KEY,product_id TEXT NOT NULL REFERENCES core_products(id) ON DELETE CASCADE,
                position INTEGER NOT NULL,color TEXT NOT NULL,
                wholesale INTEGER,semi INTEGER,retail INTEGER,payload TEXT NOT NULL);
            CREATE TABLE core_clients(
                id TEXT PRIMARY KEY,position INTEGER NOT NULL,name TEXT NOT NULL,
                tier TEXT NOT NULL,address TEXT NOT NULL,payload TEXT NOT NULL);
            CREATE TABLE core_orders(
                id TEXT PRIMARY KEY,position INTEGER NOT NULL,client_id TEXT,
                created_at TEXT,confirmed_at TEXT,status TEXT,payload TEXT NOT NULL);
            CREATE TABLE core_recipients(
                id TEXT PRIMARY KEY,order_id TEXT NOT NULL,position INTEGER NOT NULL,
                name TEXT NOT NULL,payload TEXT NOT NULL);
            CREATE TABLE core_items(
                id TEXT PRIMARY KEY,recipient_id TEXT NOT NULL,position INTEGER NOT NULL,
                product_id TEXT,variant_id TEXT,payload TEXT NOT NULL);
            INSERT INTO core_schema(key,version) VALUES ('business-core',1);
        "#).unwrap();
        let old:Value=serde_json::from_str(include_str!("../resources/legacy-state-seed-303.json")).unwrap();
        let mut envelope=old.clone();
        strip_core(&mut envelope);
        let tx=legacy_db.transaction().unwrap();
        tx.execute("INSERT INTO app_state(id,payload) VALUES (1,?1)",
            [serde_json::to_string(&envelope).unwrap()]).unwrap();
        for (position,p) in old["products"].as_array().unwrap().iter().enumerate(){
            tx.execute("INSERT INTO core_products(id,position,code,name,payload) VALUES (?1,?2,?3,?4,?5)",
                params![p["id"].as_str().unwrap(),position as i64,
                    p["code"].as_str().unwrap(),p["name"].as_str().unwrap(),
                    payload(p,Some("variants")).unwrap()]).unwrap();
            for (vpos,v) in p["variants"].as_array().unwrap().iter().enumerate(){
                tx.execute("INSERT INTO core_variants(id,product_id,position,color,wholesale,semi,retail,payload)
                    VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
                    params![v["id"].as_str().unwrap(),p["id"].as_str().unwrap(),vpos as i64,
                        v["color"].as_str().unwrap_or(""),v["wholesale"].as_i64(),
                        v["semi"].as_i64(),v["retail"].as_i64(),payload(v,None).unwrap()]).unwrap();
            }
        }
        tx.commit().unwrap();
        assert_eq!(legacy_db.query_row("SELECT COUNT(*) FROM core_variants",[],
            |r|r.get::<_,i64>(0)).unwrap(),360);
        drop(legacy_db);

        let conn=super::super::initialize_database(&path).unwrap();
        assert_eq!(schema_version(&conn).unwrap(),2);
        let restored=super::super::get_snapshot(&conn).unwrap();
        assert_eq!(restored["products"].as_array().unwrap().len(),360);
        assert!(restored["products"].as_array().unwrap().iter()
            .all(|p|p["variants"].as_array().unwrap().len()==1));
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM core_product_prices",[],
            |r|r.get::<_,i64>(0)).unwrap(),360);
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='core_variants'",[],
            |r|r.get::<_,i64>(0)).unwrap(),0);
        verify(&conn).unwrap();

        let backups=std::fs::read_dir(folder.join("backups")).unwrap()
            .map(|entry|entry.unwrap().path()).collect::<Vec<_>>();
        assert_eq!(backups.len(),1);
        let backup=Connection::open_with_flags(&backups[0],
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        assert_eq!(backup.query_row("SELECT version FROM core_schema WHERE key='business-core'",[],
            |r|r.get::<_,i64>(0)).unwrap(),1);
        assert_eq!(backup.query_row("SELECT COUNT(*) FROM core_products",[],
            |r|r.get::<_,i64>(0)).unwrap(),303);
        assert_eq!(backup.query_row("SELECT COUNT(*) FROM core_variants",[],
            |r|r.get::<_,i64>(0)).unwrap(),360);
        drop(backup);
        drop(conn);
        std::fs::remove_dir_all(folder).unwrap();
    }

    #[test]
    fn legacy_db_round_trip_preserves_prices_aliases_drafts_frozen_orders_and_receipt_audit(){
        let folder=temp().with_extension("legacy-business-roundtrip");
        std::fs::create_dir_all(&folder).unwrap();
        let path=folder.join("business.sqlite");
        let mut old:Value=serde_json::from_str(
            include_str!("../resources/legacy-state-seed-303.json")).unwrap();
        let product=old["products"].as_array().unwrap().iter()
            .position(|p|p["id"]=="bando-site-351").unwrap();
        let a=old["products"][product]["variants"][0]["id"].as_str().unwrap().to_owned();
        let b=old["products"][product]["variants"][1]["id"].as_str().unwrap().to_owned();
        old["products"][product]["variants"][0]["wholesale"]=json!(31731);
        old["products"][product]["variants"][0]["semi"]=json!(43731);
        old["products"][product]["variants"][0]["retail"]=json!(123457);
        old["products"][product]["variants"][1]["wholesale"]=json!(31732);
        old["products"][product]["variants"][1]["semi"]=json!(43732);
        old["products"][product]["variants"][1]["retail"]=json!(123458);
        let mut overrides=serde_json::Map::new();
        overrides.insert(a.clone(),json!(29817));
        old["clients"]=json!([{"id":"dealer-1","name":"가상거래처","tier":"special",
            "address":"가상 주소","phone":"010-0000-0000","overrides":overrides}]);
        old["aliases"]=json!([{"id":"scoped-1","clientId":"dealer-1",
            "text":"가상아크릴","productId":"bando-site-351","variantId":a}]);
        let frozen_item=json!({"id":"sold-1","productId":"bando-site-351",
            "variantId":a,"name":"역사적 상품명","quantity":3,"unitPrice":29817});
        let raw="가상원문 그대로 보관";
        let frozen=json!({"id":"confirmed-1","clientId":"dealer-1",
            "status":"STATEMENT","createdAt":"2026-11-08T00:00:00+09:00",
            "confirmedAt":"2026-11-08T00:05:00+09:00","raw":raw,
            "recipients":[{"id":"frozen-recipient","name":"받는사람",
                "items":[frozen_item.clone()]}],
            "receipt":{"original":raw,"at":"2026-11-08T00:05:00+09:00"},
            "rawCorrections":[{"id":"fix-1","before":"예전 원문","after":raw}],
            "confirmationSnapshot":{"recipients":[{"items":[frozen_item]}]}}
        );
        old["orders"]=json!([
            {"id":"draft-1","clientId":"dealer-1","status":"REVIEW",
             "createdAt":"2026-11-08T00:00:00+09:00",
             "recipients":[{"id":"draft-recipient","name":"받는사람",
                "items":[{"id":"pending-1","productId":"bando-site-351",
                    "variantId":b,"name":"BD 707A1 프로스트","quantity":2,
                    "unitPrice":43732}]}]},
            frozen
        ]);
        old["revision"]=json!(7);
        let confirmed_before=old["orders"][1].clone();
        let before_clients=old["clients"].clone();
        let before_revision=old["revision"].clone();
        let db=Connection::open(&path).unwrap();
        db.execute_batch("CREATE TABLE app_state(id INTEGER PRIMARY KEY,payload TEXT NOT NULL)").unwrap();
        db.execute("INSERT INTO app_state(id,payload) VALUES(1,?1)",
            [serde_json::to_string(&old).unwrap()]).unwrap();
        drop(db);

        let conn=super::super::initialize_database(&path).unwrap();
        let state=super::super::get_snapshot(&conn).unwrap();
        assert_eq!(state["revision"],before_revision);
        assert_eq!(state["products"].as_array().unwrap().len(),360);
        assert_eq!(state["clients"],before_clients);
        assert_eq!(state["orders"][1],confirmed_before);
        assert_eq!(state["aliases"][0]["clientId"],"dealer-1");
        let clear=state["products"].as_array().unwrap().iter()
            .find(|p|p["variants"][0]["id"]==a).unwrap();
        let frost=state["products"].as_array().unwrap().iter()
            .find(|p|p["variants"][0]["id"]==b).unwrap();
        assert_eq!(clear["variants"][0]["retail"],123457);
        assert_eq!(clear["variants"][0]["wholesale"],31731);
        assert_eq!(clear["variants"][0]["semi"],43731);
        assert_eq!(frost["variants"][0]["retail"],123458);
        assert_eq!(frost["variants"][0]["wholesale"],31732);
        assert_eq!(frost["variants"][0]["semi"],43732);
        assert_eq!(state["aliases"][0]["productId"],clear["id"]);
        assert_eq!(state["clients"][0]["overrides"][a.as_str()],29817);
        assert_eq!(state["orders"][0]["recipients"][0]["items"][0]["productId"],frost["id"]);
        assert_eq!(state["orders"][0]["recipients"][0]["items"][0]["unitPrice"],43732);
        let archived:String=conn.query_row(
            "SELECT record FROM receipt_archive WHERE id='receipt:confirmed-1'",[],
            |r|r.get(0)).unwrap();
        let receipt:Value=serde_json::from_str(&archived).unwrap();
        assert_eq!(receipt,old["orders"][1]["receipt"]);
        let correction:String=conn.query_row(
            "SELECT record FROM receipt_archive WHERE id='correction:fix-1'",[],
            |r|r.get(0)).unwrap();
        let correction:Value=serde_json::from_str(&correction).unwrap();
        assert_eq!(correction,old["orders"][1]["rawCorrections"][0]);
        verify(&conn).unwrap();
        drop(conn);

        let reopened=super::super::initialize_database(&path).unwrap();
        let after=super::super::get_snapshot(&reopened).unwrap();
        assert_eq!(after,state);
        verify(&reopened).unwrap();
        drop(reopened);
        std::fs::remove_dir_all(folder).unwrap();
    }

    #[test]
    fn client_order_recipient_and_item_have_reversible_foreign_keys() {
        let path=temp();
        let mut conn=super::super::initialize_database(&path).unwrap();
        let mut state=super::super::get_snapshot(&conn).unwrap();
        state["clients"]=json!([{"id":"c1","name":"가상 거래처","tier":"wholesale",
            "address":"주소","phone":"010-0000-0000"}]);
        state["orders"]=json!([{"id":"o1","clientId":"c1","createdAt":"2026-11-08",
            "recipients":[{"id":"r1","name":"테스트","items":[{"id":"i1","productId":"bando-site-358",
                "variantId":"bando-358-single","quantity":1}]}]}]);
        let result=super::super::write_snapshot(&mut conn,state,0,false).unwrap();
        assert_eq!(result["orders"][0]["recipients"][0]["items"][0]["quantity"],1);
        let raw=super::super::get_snapshot(&conn).unwrap();
        assert_eq!(raw,result);
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM core_items",[],|r|r.get::<_,i64>(0)).unwrap(),1);
        verify(&conn).unwrap();
        drop(conn);close(&path);
    }
}
