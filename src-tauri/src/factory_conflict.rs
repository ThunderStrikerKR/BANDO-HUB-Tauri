//! A single, explicit factory reply correction at the Rust persistence boundary.
//! Uploaded originals are immutable; no general-purpose frontend state override.
use crate::{Database, err, get_snapshot, lock_db, reply_digest, write_snapshot};
use rusqlite::Connection;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use unicode_normalization::UnicodeNormalization;
use std::{collections::HashSet, fs, path::{Path, PathBuf}, time::{SystemTime, UNIX_EPOCH}};
use tauri::State;

const MAX_JS_INT: u64 = 9_007_199_254_740_991;

fn normalized(value: &str) -> String {
    // The review, automatic-import guard and explicit employee correction
    // must all match recipients with the same Unicode compatibility rules.
    value.nfkc()
        .filter(|c| !c.is_whitespace() && !matches!(c, '(' | ')' | '[' | ']' | ',' | '.' | '-'))
        .flat_map(|c| c.to_lowercase()).collect()
}
fn text<'a>(value: &'a Value, name: &str) -> &'a str {
    value.get(name).and_then(Value::as_str).unwrap_or("")
}
fn unique_id(db: &Connection) -> Result<String, String> {
    db.query_row("SELECT lower(hex(randomblob(16)))", [], |r| r.get(0)).map_err(err)
}
fn now_utc(db: &Connection) -> Result<String, String> {
    db.query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now')", [], |r| r.get(0)).map_err(err)
}
fn verified_original(base: &Path, id: &str, reply: &Value) -> Result<(), String> {
    let digest = reply_digest(id)?;
    let file = base.join("factory-replies").join(format!("{digest}.xlsx"));
    let saved = reply["archivedPath"].as_str()
        .ok_or("공장 회신 원본 보관 경로가 없어 정정을 진행할 수 없습니다.")?;
    let canonical_file = fs::canonicalize(&file)
        .map_err(|_| "공장 회신 원본 파일이 없어 정정을 진행할 수 없습니다.".to_owned())?;
    let canonical_saved = fs::canonicalize(saved)
        .map_err(|_| "공장 회신 원본 보관 경로를 확인할 수 없습니다.".to_owned())?;
    if canonical_saved != canonical_file {
        return Err("공장 회신 원본 경로가 일치하지 않습니다.".into());
    }
    let meta = fs::metadata(&file).map_err(err)?;
    if !meta.is_file() || meta.len() < 4 || meta.len() > 10 * 1024 * 1024 {
        return Err("공장 회신 원본 파일 크기를 확인하세요.".into());
    }
    let bytes = fs::read(file).map_err(err)?;
    if format!("{:x}", Sha256::digest(&bytes)) != digest {
        return Err("공장 회신 원본 파일이 변경됐습니다. 정정을 차단했습니다.".into());
    }
    Ok(())
}
fn correct_state(
    db: &Connection,
    base: &Path,
    state: &mut Value,
    id: &str,
    row_number: u32,
) -> Result<(), String> {
    let replies = state["factoryReplies"].as_array()
        .ok_or("공장 회신 이력 형식을 확인하세요.")?;
    let original = replies.iter().find(|r| text(r, "id") == id)
        .ok_or("공장 회신 원본을 찾지 못했습니다.")?.clone();
    let target = original["rows"].as_array().and_then(|rs|
        rs.iter().find(|r| r["row"].as_u64() == Some(row_number as u64)))
        .ok_or("선택한 회신 행을 찾지 못했습니다.")?.clone();
    if row_number < 2 || target["applied"] == true
        || !text(&target, "issue").contains("충돌")
        || text(&target, "shipmentId").is_empty() {
        return Err("직원 정정을 허용하는 충돌 행이 아닙니다.".into());
    }
    if replies.iter().any(|r| r["resolves"]["id"] == id
        && r["resolves"]["row"] == row_number) {
        return Err("이미 정정된 회신 행입니다.".into());
    }
    // An override is never accepted without its exact archived XLSX.
    verified_original(base, id, &original)?;
    let shipment_id = text(&target, "shipmentId").to_owned();
    let order_id = text(&target, "orderId").to_owned();
    let tracking = text(&target, "tracking").to_owned();
    if !(8..=30).contains(&tracking.len()) || !tracking.bytes().all(|b| b.is_ascii_digit()) {
        return Err("회신 운송장번호 형식이 올바르지 않습니다.".into());
    }
    let actual = target["actual"].as_u64()
        .filter(|n| *n <= MAX_JS_INT)
        .ok_or("회신 실제 운임을 확인하세요.")?;
    let contacts = target["contacts"].as_array()
        .ok_or("회신 연락처가 없습니다.")?;
    let matching_queue: HashSet<String> = state["workflow"]["queue"].as_array()
        .ok_or("공장 출고 큐를 확인할 수 없습니다.")?.iter()
        .filter(|q| text(q,"origin") == "FACTORY" && text(q,"status") == "EXPORTED")
        .filter(|q| {
            let recipient = &q["snapshot"]["recipient"];
            normalized(text(recipient,"name")) == normalized(text(&target,"name"))
                && normalized(text(recipient,"address")) == normalized(text(&target,"address"))
                && contacts.iter().any(|n| n.as_str().is_some_and(|n| {
                    let n = normalized(n);
                    !n.is_empty() && [text(recipient,"phone"), text(recipient,"mobile")]
                        .iter().any(|phone| !phone.is_empty() && normalized(phone) == n)
                }))
        })
        .filter_map(|q| q["shipmentId"].as_str().map(ToOwned::to_owned)).collect();
    if matching_queue.len() != 1 || !matching_queue.contains(&shipment_id) {
        return Err("공장 발송 수취인과 배송 건을 재검증할 수 없습니다.".into());
    }
    let shipments = state["workflow"]["shipments"].as_array()
        .ok_or("배송 건을 확인할 수 없습니다.")?;
    let ship = shipments.iter().find(|s| text(s,"id") == shipment_id)
        .ok_or("공장 배송 건이 존재하지 않습니다.")?.clone();
    if text(&ship,"orderId") != order_id {
        return Err("회신 주문과 배송 건이 일치하지 않습니다.".into());
    }
    let recipient_id = text(&ship, "recipientId");
    let recipient = state["orders"].as_array().and_then(|orders|
        orders.iter().find(|o| text(o,"id") == order_id))
        .and_then(|o| o["recipients"].as_array())
        .and_then(|rows| rows.iter().find(|r| text(r,"id") == recipient_id))
        .ok_or("원본 주문 수취인을 찾지 못했습니다.")?.clone();
    if !recipient["items"].as_array().is_some_and(|items|
        items.iter().any(|item| text(item,"origin") == "FACTORY")) {
        return Err("공장 출고 품목이 없는 배송 건입니다.".into());
    }
    if shipments.iter().any(|other|
        text(other,"id") != shipment_id && text(&other["tracking"],"FACTORY") == tracking) {
        return Err("다른 배송 건이 사용 중인 운송장번호는 승인할 수 없습니다.".into());
    }
    let old_tracking = ship["tracking"]["FACTORY"].as_str()
        .filter(|s| !s.is_empty()).map(str::to_owned);
    let old_actual = if ship["actualFreight"].as_object().is_some_and(|m| m.contains_key("FACTORY")) {
        ship["actualFreight"]["FACTORY"].clone()
    } else {
        recipient["actualFreight"].clone()
    };
    if old_tracking.as_deref() == Some(tracking.as_str()) && old_actual.as_u64() == Some(actual) {
        return Err("이미 같은 운송장번호와 운임이 반영되어 있습니다.".into());
    }
    let actor = state["settings"]["operatorName"].as_str()
        .map(str::trim).filter(|s| !s.is_empty())
        .unwrap_or("직원").to_owned();
    let now = now_utc(db)?;
    let new_id = unique_id(db)?;
    let before = json!({"tracking":old_tracking,"actual":old_actual});
    if old_actual.as_u64() != Some(actual) {
        state["workflow"]["events"].as_array_mut()
            .ok_or("배송 업무 이력 형식 오류")?
            .push(json!({"id":unique_id(db)?,"at":now,"actor":actor,
                "action":"실제 출고 운임 입력","shipmentIds":[shipment_id],
                "before":old_actual,"after":{"origin":"FACTORY","amount":actual}}));
    }
    let changed_tracking = old_tracking.as_deref().is_some_and(|old| old != tracking);
    let shipment = state["workflow"]["shipments"].as_array_mut().unwrap()
        .iter_mut().find(|s| text(s,"id") == shipment_id).unwrap();
    shipment["tracking"]["FACTORY"] = json!(tracking);
    shipment["actualFreight"]["FACTORY"] = json!(actual);
    state["workflow"]["events"].as_array_mut().unwrap()
        .push(json!({"id":unique_id(db)?,"at":now,"actor":actor,
            "action":if changed_tracking {"공장 송장 / 운임 정정"} else {"공장 회신 반영"},
            "shipmentIds":[shipment_id],"before":before,
            "after":{"tracking":tracking,"actual":actual,"fileId":new_id}}));
    let mut corrected = target;
    corrected.as_object_mut().ok_or("회신 행 형식 오류")?.remove("issue");
    corrected["applied"] = json!(true);
    state["factoryReplies"].as_array_mut().unwrap()
        .push(json!({"id":new_id,"filename":original["filename"],
            "businessDate":original["businessDate"],"at":now,"actor":actor,
            "resolves":{"id":id,"row":row_number},"status":"APPLIED",
            "rows":[corrected]}));
    Ok(())
}
fn backup_before_correction(db: &Connection, base: &Path) -> Result<PathBuf, String> {
    let folder = base.join("backups");
    fs::create_dir_all(&folder).map_err(err)?;
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map_err(err)?.as_nanos();
    let path = folder.join(format!("bando-hub-before-factory-correction-{stamp}.sqlite"));
    db.execute("VACUUM INTO ?1", [path.to_string_lossy().to_string()]).map_err(err)?;
    Ok(path)
}
fn approve_factory_conflict_impl(
    db: &mut Connection, base: &Path,
    id: &str, row: u32, expected_revision: u64,
) -> Result<(), String> {
    let mut state = get_snapshot(db)?;
    let revision = state["revision"].as_u64().unwrap_or(0);
    if revision != expected_revision {
        return Err("다른 작업에서 데이터가 변경됐습니다. 최신 회신 내역을 다시 확인하세요.".into());
    }
    correct_state(db, base, &mut state, id, row)?;
    backup_before_correction(db, base)?;
    write_snapshot(db, state, revision, true)?;
    Ok(())
}
#[tauri::command]
pub(crate) fn approve_factory_conflict(
    db: State<'_, Database>, id: String, row: u32, expected_revision: u64,
) -> Result<(), String> {
    let mut conn = lock_db(&db)?;
    approve_factory_conflict_impl(&mut conn, &db.base, &id, row, expected_revision)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (Connection, PathBuf, String) {
        let stamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let base = std::env::temp_dir().join(format!("bando-conflict-test-{}-{stamp}",std::process::id()));
        fs::create_dir_all(base.join("factory-replies")).unwrap();
        let original_bytes = b"PK\x03\x04synthetic-excel-only";
        let id = format!("factory-reply-{:x}",Sha256::digest(original_bytes));
        let original_file = base.join("factory-replies").join(format!("{}.xlsx",&id[14..]));
        fs::write(&original_file,original_bytes).unwrap();
        let state=json!({
            "revision":7,"products":[],"orders":[{
                "id":"order-1","recipients":[{
                    "id":"recipient-1","items":[{"id":"item-1","origin":"FACTORY"}],
                    "actualFreight":null
                }]
            }],"clients":[],"aliases":[],"queue":[],"exports":[],"settings":{"accounts":[],"operatorName":"승인 담당"},
            "workflow":{"queue":[{
                "id":"q1","origin":"FACTORY","status":"EXPORTED","shipmentId":"ship-1",
                "snapshot":{"recipient":{"name":"김수취","address":"서울 강남구 123",
                    "phone":"010-1234-5678","mobile":""}}
            }],"shipments":[{
                "id":"ship-1","orderId":"order-1","recipientId":"recipient-1",
                "tracking":{"FACTORY":"001234567891"},"actualFreight":{"FACTORY":3000}
            }],"events":[]},
            "factoryReplies":[{
                "id":id,"filename":"원본.xlsx","businessDate":"2026-11-07",
                "at":"2026-11-07T00:00:00Z","status":"REVIEW",
                "archivedPath":original_file.to_string_lossy(),
                "rows":[{
                    "row":2,"name":"김수취","address":"서울 강남구 123",
                    "contacts":["010-1234-5678"],"tracking":"009988776655",
                    "actual":4000,"shipmentId":"ship-1","orderId":"order-1",
                    "issue":"기존 송장 / 실제 운임과 충돌합니다. 직원 확인 필요"
                }]
            }]
        });
        let db=Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE app_state(id INTEGER PRIMARY KEY,payload TEXT NOT NULL);
            CREATE TABLE product_index(id TEXT PRIMARY KEY,code TEXT NOT NULL,name TEXT NOT NULL,payload TEXT NOT NULL);
            CREATE TABLE order_index(id TEXT PRIMARY KEY,client_id TEXT NOT NULL,created_at TEXT NOT NULL,confirmed_at TEXT,status TEXT NOT NULL);
            CREATE TABLE receipt_archive(id TEXT PRIMARY KEY,order_id TEXT NOT NULL,record TEXT NOT NULL);").unwrap();
        db.execute("INSERT INTO app_state(id,payload) VALUES(1,?1)",[state.to_string()]).unwrap();
        (db,base,id)
    }
    #[test]
    fn correction_is_one_row_append_only_atomic_and_backed_up() {
        let (mut db,base,id)=fixture();
        let old=get_snapshot(&db).unwrap();
        approve_factory_conflict_impl(&mut db,&base,&id,2,7).unwrap();
        let next=get_snapshot(&db).unwrap();
        assert_eq!(next["revision"],8);
        assert_eq!(next["factoryReplies"][0],old["factoryReplies"][0]);
        assert_eq!(next["factoryReplies"].as_array().unwrap().len(),2);
        assert_eq!(next["factoryReplies"][1]["resolves"],json!({"id":id,"row":2}));
        assert_eq!(next["factoryReplies"][1]["rows"][0]["tracking"],"009988776655");
        assert_eq!(next["workflow"]["shipments"][0]["tracking"]["FACTORY"],"009988776655");
        assert_eq!(next["workflow"]["shipments"][0]["actualFreight"]["FACTORY"],4000);
        assert!(next["workflow"]["events"].as_array().unwrap().len()>=1);
        assert_eq!(fs::read_dir(base.join("backups")).unwrap().count(),1);
        assert!(approve_factory_conflict_impl(&mut db,&base,&id,2,8).unwrap_err().contains("이미 정정"));
        assert_eq!(get_snapshot(&db).unwrap(),next);
        fs::remove_dir_all(base).unwrap();
    }
    #[test]
    fn rejects_stale_revision_tampered_source_and_tracking_reuse() {
        let (mut db,base,id)=fixture();
        assert!(approve_factory_conflict_impl(&mut db,&base,&id,2,6).unwrap_err().contains("변경"));
        let mut state=get_snapshot(&db).unwrap();
        state["workflow"]["shipments"].as_array_mut().unwrap().push(json!({
            "id":"ship-other","tracking":{"FACTORY":"009988776655"}}));
        db.execute("UPDATE app_state SET payload=?1 WHERE id=1",[state.to_string()]).unwrap();
        assert!(approve_factory_conflict_impl(&mut db,&base,&id,2,7).unwrap_err().contains("다른 배송 건"));
        state["workflow"]["shipments"].as_array_mut().unwrap().pop();
        db.execute("UPDATE app_state SET payload=?1 WHERE id=1",[state.to_string()]).unwrap();
        fs::write(base.join("factory-replies").join(format!("{}.xlsx",&id[14..])),b"PK\x03\x04modified").unwrap();
        assert!(approve_factory_conflict_impl(&mut db,&base,&id,2,7).unwrap_err().contains("변경"));
        assert_eq!(get_snapshot(&db).unwrap(),state);
        fs::remove_dir_all(base).unwrap();
    }
}
