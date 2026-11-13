//! Poll-based, file-stability checked factory reply inbox.
//! Source XLSX parsing and business matching reuse the existing frontend
//! preview pipeline. This module owns directory boundaries, deduplication,
//! byte identity, and the final revision-checked SQLite commit.
use super::*;
use serde::Serialize;
use unicode_normalization::UnicodeNormalization;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::time::SystemTime;

const MAX_REPLY_BYTES: u64 = 10 * 1024 * 1024;
const MAX_FILES_PER_SCAN: usize = 2;

#[derive(Clone, Copy, PartialEq, Eq)]
struct Stamp {
    size: u64,
    modified: SystemTime,
}
#[derive(Clone)]
struct SeenFile {
    stamp: Stamp,
    observations: u8,
    digest: Option<String>,
}
#[derive(Default)]
pub(super) struct InboxWatch(Mutex<HashMap<PathBuf, SeenFile>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct InboxFile {
    filename: String,
    id: String,
    bytes: Vec<u8>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ImportResult {
    duplicate: bool,
    applied: usize,
    held: usize,
    archive_warning: Option<String>,
}

fn file_id(bytes: &[u8]) -> String {
    format!("factory-reply-{:x}", Sha256::digest(bytes))
}
fn valid_filename(name: &str) -> bool {
    name.len() <= 240 && !name.is_empty() && !name.starts_with("~$")
        && !name.chars().any(|c| matches!(c, '/' | '\\' | '\0'))
        && name.to_ascii_lowercase().ends_with(".xlsx")
        && name != "." && name != ".."
}

fn inbox_directory(base: &Path, is_test: bool, settings: &Value) -> Result<Option<PathBuf>, String> {
    if is_test {
        let isolated = base.join("Excel").join("공장 회신 수신");
        fs::create_dir_all(&isolated).map_err(err)?;
        return Ok(Some(canonical_excel_directory(&isolated)?));
    }
    let Some(path) = settings["factoryReplyDirectory"].as_str()
        .map(str::trim).filter(|p| !p.is_empty()) else { return Ok(None); };
    Ok(Some(canonical_excel_directory(Path::new(path))?))
}
fn scan_files(
    dir: &Path, seen: &mut HashMap<PathBuf, SeenFile>, registered: &HashSet<String>
) -> Result<Vec<InboxFile>, String> {
    let mut files = fs::read_dir(dir).map_err(err)?
        .collect::<Result<Vec<_>, _>>().map_err(err)?;
    files.sort_by_key(|entry| entry.file_name());
    let mut ready = Vec::new();
    let mut active = HashSet::new();
    for entry in files {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if !valid_filename(&name) || !entry.file_type().map_err(err)?.is_file() {
            continue;
        }
        let metadata = entry.metadata().map_err(err)?;
        if metadata.len() == 0 || metadata.len() > MAX_REPLY_BYTES {
            continue;
        }
        let stamp = Stamp { size: metadata.len(), modified: metadata.modified().map_err(err)? };
        active.insert(path.clone());
        let record = seen.entry(path.clone()).or_insert_with(|| SeenFile {
            stamp, observations: 0, digest: None,
        });
        if record.stamp != stamp {
            *record = SeenFile { stamp, observations: 0, digest: None };
        }
        // Require three unchanged observations before attempting XLSX parse.
        // A file being copied can have a brief period with stable metadata.
        record.observations = record.observations.saturating_add(1);
        if record.observations < 3 || ready.len() >= MAX_FILES_PER_SCAN { continue; }
        if record.digest.as_ref().is_some_and(|id| registered.contains(id)) {
            continue; // Never re-read gigabytes of historical processed replies.
        }
        let bytes = fs::read(&path).map_err(err)?;
        let after = fs::metadata(&path).map_err(err)?;
        if after.len() != stamp.size || after.modified().map_err(err)? != stamp.modified
            || bytes.len() as u64 != stamp.size { continue; }
        let id = file_id(&bytes);
        if let Some(record) = seen.get_mut(&path) { record.digest = Some(id.clone()); }
        if !registered.contains(&id) {
            ready.push(InboxFile { filename: name, id, bytes });
        }
    }
    seen.retain(|path, _| active.contains(path));
    Ok(ready)
}

#[tauri::command]
pub(super) async fn choose_factory_reply_directory(
    app: tauri::AppHandle, db: State<'_, Database>
) -> Result<Option<String>, String> {
    if db.is_test {
        let folder = inbox_directory(&db.base, true, &Value::Null)?
            .ok_or("테스트 수신 폴더가 없습니다.")?;
        return Ok(Some(folder.to_string_lossy().into_owned()));
    }
    tauri::async_runtime::spawn_blocking(move || {
        use tauri_plugin_dialog::DialogExt;
        let chosen = app.dialog().file()
            .set_title("공장 회신 자동 수신 폴더 선택").blocking_pick_folder();
        let Some(chosen) = chosen else { return Ok(None); };
        let folder = chosen.into_path().map_err(err)?;
        Ok(Some(canonical_excel_directory(&folder)?.to_string_lossy().into_owned()))
    }).await.map_err(err)?
}

#[tauri::command]
pub(super) fn factory_reply_watch_scan(
    db: State<'_, Database>, watch: State<'_, InboxWatch>
) -> Result<Vec<InboxFile>, String> {
    let current = get_snapshot(&*lock_db(&db)?)?;
    let Some(directory) = inbox_directory(&db.base, db.is_test, &current["settings"])? else {
        return Ok(Vec::new());
    };
    let registered: HashSet<String> = current["factoryReplies"].as_array().into_iter()
        .flatten().filter_map(|r| r["id"].as_str()).map(str::to_owned).collect();
    let mut seen = watch.0.lock().map_err(|_| "공장 회신 폴더 감시 잠금 오류")?;
    scan_files(&directory, &mut seen, &registered)
}

// Apply the exact NFKC recipient normalization used by the original TS
// matcher and the Rust matching engine. Native auto-import validation must
// not reject a shipment that the reviewed Rust preview uniquely matched.
fn compact_recipient(text: &str) -> String {
    text.nfkc().filter(|c| !c.is_whitespace() && !"(),.-[]".contains(*c))
        .flat_map(char::to_lowercase).collect()
}
fn same_recipient(row: &Value, queue: &Value) -> bool {
    let recipient = &queue["snapshot"]["recipient"];
    let text_matches = |key: &str| {
        let left = row[key].as_str().unwrap_or("");
        let right = recipient[key].as_str().unwrap_or("");
        !left.is_empty() && !right.is_empty()
            && compact_recipient(left) == compact_recipient(right)
    };
    let contact_matches = row["contacts"].as_array().is_some_and(|contacts|
        contacts.iter().filter_map(Value::as_str).any(|contact|
            ["phone", "mobile"].iter().any(|field| recipient[*field].as_str()
                .is_some_and(|saved| !saved.is_empty()
                    && compact_recipient(saved) == compact_recipient(contact)))));
    text_matches("name") && text_matches("address") && contact_matches
}

// Automated imports are narrower than the general state_save API.
// The UI may only append one reply and change the related workflow shipments
// and append-only workflow events. The original orders and everything else
// must remain exactly as it was.
fn validate_automatic_change(before: &Value, next: &Value, id: &str, name: &str)
    -> Result<(usize, usize), String> {
    let old = before.as_object().ok_or("기존 DB 형식 오류")?;
    let updated = next.as_object().ok_or("회신 변경 형식 오류")?;
    if old.len() != updated.len() {
        // Legacy snapshots may not yet have the optional factoryReplies key.
        if !(old.len() + 1 == updated.len() && !old.contains_key("factoryReplies")
            && updated.contains_key("factoryReplies")) {
            return Err("회신과 관계없는 데이터 구조가 변경됐습니다.".into());
        }
    }
    for (field, value) in old {
        if !["factoryReplies", "workflow"].contains(&field.as_str())
            && updated.get(field) != Some(value) {
            return Err(format!("자동 회신이 허용되지 않은 필드 {field}를 변경했습니다."));
        }
    }
    for key in updated.keys() {
        if !old.contains_key(key) && key != "factoryReplies" {
            return Err("자동 회신이 다른 데이터를 추가했습니다.".into());
        }
    }
    let old_replies = before["factoryReplies"].as_array();
    let new_replies = next["factoryReplies"].as_array().ok_or("공장 회신 이력 형식 오류")?;
    let previous_count = old_replies.map_or(0, Vec::len);
    if new_replies.len() != previous_count + 1
        || old_replies.is_some_and(|v| new_replies.get(..v.len()) != Some(v.as_slice())) {
        return Err("자동 회신은 기존 이력을 변경하거나 여러 건을 추가할 수 없습니다.".into());
    }
    let reply = new_replies.last().ok_or("회신 기록이 없습니다.")?;
    if reply["id"] != id || reply["filename"] != name
        || reply["resolves"].is_object() {
        return Err("자동 회신 파일 식별자 또는 기록 형식 오류".into());
    }
    let rows = reply["rows"].as_array().ok_or("회신 행이 없습니다.")?;
    if rows.len() > 1000 { return Err("회신 행이 1,000건을 초과했습니다.".into()); }
    let applied = rows.iter().filter(|r| r["applied"] == true).count();
    let held = rows.len() - applied;
    let error = reply["error"].as_str().filter(|t| !t.is_empty());
    if error.is_some_and(|e| e.len() > 500) || (rows.is_empty() && error.is_none()) {
        return Err("공장 회신 오류 사유 또는 처리할 행이 없습니다.".into());
    }
    let expected_status = if error.is_some() || applied == 0 { "REVIEW" }
        else if held > 0 { "PARTIAL" } else { "APPLIED" };
    if reply["status"] != expected_status {
        return Err("공장 회신 반영 상태가 행별 결과와 다릅니다.".into());
    }
    if before["workflow"].is_null() && next["workflow"].is_null() {
        if applied != 0 { return Err("배송 건 없이 운송장을 연결할 수 없습니다.".into()); }
        return Ok((applied, held));
    }
    let old_workflow = before["workflow"].as_object().ok_or("기존 배송 데이터 오류")?;
    let new_workflow = next["workflow"].as_object().ok_or("배송 변경 데이터 오류")?;
    if old_workflow.keys().collect::<HashSet<_>>() != new_workflow.keys().collect::<HashSet<_>>() {
        return Err("배송 데이터 구조를 변경할 수 없습니다.".into());
    }
    for (key, value) in old_workflow {
        if !["shipments", "events"].contains(&key.as_str())
            && new_workflow.get(key) != Some(value) {
            return Err(format!("자동 회신이 배송 필드 {key}를 변경할 수 없습니다."));
        }
    }
    let old_shipments = before["workflow"]["shipments"].as_array()
        .ok_or("기존 배송 목록 오류")?;
    let new_shipments = next["workflow"]["shipments"].as_array()
        .ok_or("변경된 배송 목록 오류")?;
    if old_shipments.len() != new_shipments.len() {
        return Err("자동 회신 중 배송 건 목록이 변경됐습니다.".into());
    }
    let mut applied_ids = HashSet::new();
    for row in rows.iter().filter(|r| r["applied"] == true) {
        let shipment_id = row["shipmentId"].as_str().ok_or("자동 연결 배송 ID 누락")?;
        if !applied_ids.insert(shipment_id) {
            return Err("같은 배송 건에 중복 회신을 자동 반영할 수 없습니다.".into());
        }
        let tracking = row["tracking"].as_str().ok_or("운송장번호가 없습니다.")?;
        let actual = row["actual"].as_u64().ok_or("실제 운임이 올바르지 않습니다.")?;
        if !(8..=30).contains(&tracking.len())
            || !tracking.bytes().all(|b| b.is_ascii_digit()) || actual > i64::MAX as u64 {
            return Err("자동 회신 운송장번호 또는 운임이 올바르지 않습니다.".into());
        }
        let matched = new_shipments.iter().find(|s| s["id"] == shipment_id)
            .ok_or("반영 대상 배송 건을 찾을 수 없습니다.")?;
        // The TS original leaves shipment.actualFreight.FACTORY absent when
        // the current order recipient already carries the exact actual fee.
        // Its effective value is still valid and must not be rewritten merely
        // to satisfy this automatic-import guard.
        let effective_actual = if let Some(saved) =
            matched["actualFreight"].as_object().and_then(|m| m.get("FACTORY")) {
            saved.as_u64()
        } else {
            next["orders"].as_array().and_then(|orders| orders.iter()
                .find(|order| order["id"] == matched["orderId"]))
                .and_then(|order| order["recipients"].as_array())
                .and_then(|recipients| recipients.iter()
                    .find(|recipient| recipient["id"] == matched["recipientId"]))
                .and_then(|recipient| recipient["actualFreight"].as_u64())
        };
        if matched["orderId"] != row["orderId"]
            || matched["tracking"]["FACTORY"] != tracking
            || effective_actual != Some(actual) {
            return Err("운송장번호와 운임이 반영된 배송 건의 값이 다릅니다.".into());
        }
        let matching_ids: HashSet<&str> = before["workflow"]["queue"].as_array()
            .ok_or("공장 발송 목록 오류")?.iter()
            .filter(|q| q["origin"] == "FACTORY" && q["status"] == "EXPORTED"
                && same_recipient(row, q))
            .filter_map(|q| q["shipmentId"].as_str()).collect();
        if matching_ids.len() != 1 || !matching_ids.contains(shipment_id) {
            return Err("수취인 정보가 고유한 공장 발송 배송 건과 일치하지 않습니다.".into());
        }
        let original = old_shipments.iter().find(|s| s["id"] == shipment_id)
            .ok_or("원본 공장 배송 건 누락")?;
        if original["tracking"]["FACTORY"].as_str()
            .is_some_and(|old| !old.is_empty() && old != tracking) {
            return Err("기존 운송장번호와 충돌합니다. 직원 승인이 필요합니다.".into());
        }
        let original_freight = if let Some(saved) =
            original["actualFreight"].as_object().and_then(|m| m.get("FACTORY")) {
            saved.as_u64()
        } else {
            before["orders"].as_array().and_then(|orders| orders.iter()
                .find(|order| order["id"] == original["orderId"]))
                .and_then(|order| order["recipients"].as_array())
                .and_then(|recipients| recipients.iter()
                    .find(|recipient| recipient["id"] == original["recipientId"]))
                .and_then(|recipient| recipient["actualFreight"].as_u64())
        };
        if original_freight.is_some_and(|amount| amount != actual) {
            return Err("기존 실제 운임과 충돌합니다. 직원 승인이 필요합니다.".into());
        }
        if new_shipments.iter().any(|s| s["id"] != shipment_id
            && s["tracking"]["FACTORY"] == tracking) {
            return Err("운송장번호가 다른 배송 건에 중복 연결됐습니다.".into());
        }
    }
    for (before_ship, after_ship) in old_shipments.iter().zip(new_shipments) {
        if before_ship["id"] != after_ship["id"] { return Err("배송 건 순서가 변경됐습니다.".into()); }
        if before_ship == after_ship { continue; }
        let ship_id = before_ship["id"].as_str().ok_or("배송 건 ID 누락")?;
        if !applied_ids.contains(ship_id) {
            return Err("회신에 없는 배송 건을 수정할 수 없습니다.".into());
        }
        let mut original = before_ship.clone();
        let mut updated = after_ship.clone();
        for candidate in [&mut original, &mut updated] {
            if let Some(map) = candidate.as_object_mut() {
                map.remove("tracking");
                map.remove("actualFreight");
            }
        }
        if original != updated {
            return Err("공장 운송장과 운임 외의 배송 정보를 변경할 수 없습니다.".into());
        }
        for key in ["tracking", "actualFreight"] {
            let old_value = before_ship[key].as_object();
            let next_value = after_ship[key].as_object();
            let non_factory = |m: Option<&serde_json::Map<String, Value>>| {
                m.into_iter().flat_map(|v| v.iter())
                    .filter(|(k, _)| *k != "FACTORY")
                    .map(|(k,v)| (k.clone(),v.clone()))
                    .collect::<serde_json::Map<String,Value>>()
            };
            if non_factory(old_value) != non_factory(next_value) {
                return Err("매장 발송 정보는 자동 회신으로 변경할 수 없습니다.".into());
            }
        }
    }
    let before_events = before["workflow"]["events"].as_array().ok_or("기존 변경 이력 오류")?;
    let after_events = next["workflow"]["events"].as_array().ok_or("변경 이력 형식 오류")?;
    if after_events.get(..before_events.len()) != Some(before_events.as_slice())
        || after_events.len() > before_events.len() + applied * 2 {
        return Err("기존 변경 이력이 수정됐거나 추가 이력이 과도합니다.".into());
    }
    for event in &after_events[before_events.len()..] {
        let action = event["action"].as_str().unwrap_or("");
        if !["실제 출고 운임 입력", "공장 회신 반영", "공장 송장 / 운임 정정"].contains(&action) {
            return Err("자동 회신과 관계없는 변경 이력이 포함되어 있습니다.".into());
        }
        let ids = event["shipmentIds"].as_array().ok_or("변경 이력의 배송 건 누락")?;
        if ids.len() != 1 || !ids[0].as_str().is_some_and(|id| applied_ids.contains(id)) {
            return Err("변경 이력이 실제 적용 행과 일치하지 않습니다.".into());
        }
    }
    if applied == 0 && before["workflow"] != next["workflow"] {
        return Err("보류 회신이 실제 배송 정보를 변경했습니다.".into());
    }
    Ok((applied, held))
}

fn write_original(base: &Path, id: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    let dir = base.join("factory-replies");
    fs::create_dir_all(&dir).map_err(err)?;
    let digest = id.strip_prefix("factory-reply-").ok_or("회신 식별자 오류")?;
    let destination = dir.join(format!("{digest}.xlsx"));
    if destination.exists() {
        if fs::read(&destination).map_err(err)? != bytes {
            return Err("기존 원본 파일이 현재 회신과 다릅니다.".into());
        }
    } else {
        let mut file = fs::OpenOptions::new().create_new(true).write(true)
            .open(&destination).map_err(err)?;
        if let Err(error) = file.write_all(bytes).and_then(|_| file.sync_all()) {
            drop(file);
            let _ = fs::remove_file(&destination);
            return Err(err(error));
        }
    }
    Ok(destination)
}

fn commit_auto(
    conn: &mut Connection, base: &Path, is_test: bool,
    filename: &str, id: &str, mut candidate: Value, expected_revision: u64,
) -> Result<ImportResult, String> {
    if !valid_filename(filename) || id.len() != "factory-reply-".len() + 64
        || !id.starts_with("factory-reply-")
        || !id["factory-reply-".len()..].bytes().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()) {
        return Err("자동 회신 파일명 또는 식별자가 잘못됐습니다.".into());
    }
    let previous = get_snapshot(conn)?;
    let saved_revision = previous["revision"].as_u64().ok_or("DB 리비전 오류")?;
    if saved_revision != expected_revision || candidate["revision"] != expected_revision {
        return Err("자동 회신 중 다른 작업에서 DB가 변경됐습니다. 다시 검사합니다.".into());
    }
    if previous["factoryReplies"].as_array().is_some_and(|rows|
        rows.iter().any(|r| r["id"] == id)) {
        return Ok(ImportResult { duplicate: true, applied: 0, held: 0, archive_warning: None });
    }
    let directory = inbox_directory(base, is_test, &previous["settings"])?
        .ok_or("공장 회신 수신 폴더가 설정되지 않았습니다.")?;
    let original = directory.join(filename);
    let resolved = fs::canonicalize(&original).map_err(err)?;
    if resolved.parent() != Some(directory.as_path()) || !resolved.is_file() {
        return Err("자동 회신 파일은 지정된 수신 폴더의 파일만 허용합니다.".into());
    }
    let metadata = fs::metadata(&resolved).map_err(err)?;
    if metadata.len() == 0 || metadata.len() > MAX_REPLY_BYTES {
        return Err("공장 회신 파일은 10MB 이하만 허용합니다.".into());
    }
    let bytes = fs::read(&resolved).map_err(err)?;
    if bytes.len() as u64 != metadata.len() || file_id(&bytes) != id
        || !bytes.starts_with(b"PK") {
        return Err("감지 후 회신 원본이 변경되었거나 XLSX 형식이 아닙니다.".into());
    }
    let (applied, held) = validate_automatic_change(&previous, &candidate, id, filename)?;
    let path = write_original(base, id, &bytes)?;
    candidate["factoryReplies"].as_array_mut().ok_or("회신 이력 형식 오류")?
        .last_mut().ok_or("회신 이력 누락")?["archivedPath"] =
        json!(path.to_string_lossy().to_string());
    write_snapshot(conn, candidate, expected_revision, true)?;
    // The user-facing dated copy is not the audit authority; failure here
    // cannot undo a transaction already committed with its private original.
    let archive_root = if is_test {
        canonical_excel_directory(&base.join("Excel"))
    } else {
        saved_excel_directory(&previous["settings"])
    };
    let archive_warning = match archive_root {
        Ok(root) => archive_workbook_bytes(&root, WorkbookKind::FactoryReply, Local::now(), &bytes)
            .err(),
        Err(error) => Some(error),
    };
    Ok(ImportResult { duplicate: false, applied, held, archive_warning })
}

#[tauri::command]
pub(super) fn factory_reply_watch_commit(
    db: State<'_, Database>, filename: String, id: String,
    candidate: Value, expected_revision: u64,
) -> Result<ImportResult, String> {
    let mut conn = lock_db(&db)?;
    commit_auto(&mut conn, &db.base, db.is_test,
        &filename, &id, candidate, expected_revision)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::UNIX_EPOCH;

    fn fixture() -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "bando-reply-watch-{}-{}", std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
        ));
        fs::create_dir(&root).unwrap();
        root
    }
    #[test]
    fn only_stable_files_are_emitted_and_registered_files_are_not_repeated() {
        let root = fixture();
        fs::write(root.join("~$temporary.xlsx"), b"PK-incomplete").unwrap();
        fs::write(root.join("reply.xlsx"), b"PK-factory").unwrap();
        let mut seen = HashMap::new();
        let empty = HashSet::new();
        assert!(scan_files(&root,&mut seen,&empty).unwrap().is_empty());
        assert!(scan_files(&root,&mut seen,&empty).unwrap().is_empty());
        let scanned = scan_files(&root,&mut seen,&empty).unwrap();
        assert_eq!(scanned.len(),1);
        assert_eq!(scanned[0].filename,"reply.xlsx");
        assert_eq!(scanned[0].id,file_id(b"PK-factory"));
        let registered = HashSet::from([scanned[0].id.clone()]);
        assert!(scan_files(&root,&mut seen,&registered).unwrap().is_empty());
        fs::write(root.join("reply.xlsx"), b"PK-factory-updated").unwrap();
        assert!(scan_files(&root,&mut seen,&empty).unwrap().is_empty());
        assert!(scan_files(&root,&mut seen,&empty).unwrap().is_empty());
        assert_eq!(scan_files(&root,&mut seen,&empty).unwrap().len(),1);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn test_inbox_cannot_resolve_production_folder() {
        let root = fixture();
        let settings = json!({"factoryReplyDirectory":"C:\\real-company-orders"});
        let inbox = inbox_directory(&root, true, &settings).unwrap().unwrap();
        let canonical_root = fs::canonicalize(&root).unwrap();
        assert!(inbox.starts_with(&canonical_root));
        assert!(inbox.ends_with(Path::new("Excel").join("공장 회신 수신")));
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn native_matching_rejects_wrong_recipient_and_existing_waybill_collision() {
        let recipient = json!({
            "id":"r1","name":"김수취","address":"서울 테스트로 1",
            "phone":"010-2222-3333","mobile":"","actualFreight":null,
            "items":[{"origin":"FACTORY"}]
        });
        let before = json!({
            "revision":4,"products":[],"orders":[{"id":"order1","recipients":[recipient.clone()]}],
            "settings":{},"factoryReplies":[],
            "workflow":{
                "queue":[{"shipmentId":"ship1","origin":"FACTORY","status":"EXPORTED",
                    "snapshot":{"recipient":recipient}}],
                "shipments":[{"id":"ship1","orderId":"order1","recipientId":"r1",
                    "tracking":{},"actualFreight":{}}],
                "events":[]
            }
        });
        let mut next = before.clone();
        next["factoryReplies"] = json!([{
            "id":"factory-reply-synthetic","filename":"factory.xlsx","status":"APPLIED",
            "rows":[{"row":2,"applied":true,"shipmentId":"ship1","orderId":"order1",
                "name":"김수취","address":"서울 테스트로 1",
                "contacts":["010-2222-3333"],"tracking":"001234567890","actual":4000}]
        }]);
        next["workflow"]["shipments"][0]["tracking"]["FACTORY"] = json!("001234567890");
        next["workflow"]["shipments"][0]["actualFreight"]["FACTORY"] = json!(4000);
        next["workflow"]["events"] = json!([{"action":"공장 회신 반영","shipmentIds":["ship1"]}]);
        let validate = |old: &Value, updated: &Value| {
            validate_automatic_change(old,updated,"factory-reply-synthetic","factory.xlsx")
        };
        assert_eq!(validate(&before,&next).unwrap(),(1,0));
        let mut mismatched = next.clone();
        mismatched["factoryReplies"][0]["rows"][0]["address"] = json!("다른 주소");
        assert!(validate(&before,&mismatched).unwrap_err().contains("수취인"));
        let mut conflicting = before.clone();
        conflicting["workflow"]["shipments"][0]["tracking"]["FACTORY"] =
            json!("009988776655");
        assert!(validate(&conflicting,&next).unwrap_err().contains("기존 운송장"));
        let mut freight_conflict = before.clone();
        freight_conflict["workflow"]["shipments"][0]["actualFreight"]["FACTORY"] =
            json!(5000);
        assert!(validate(&freight_conflict,&next).unwrap_err().contains("기존 실제 운임"));
    }

    #[test]
    fn guarded_import_commits_original_and_review_record_to_real_sqlite() {
        let base = fixture();
        let inbox = base.join("incoming");
        let archive = base.join("archive");
        fs::create_dir_all(&inbox).unwrap();
        fs::create_dir_all(&archive).unwrap();
        let original_bytes = b"PK-invalid-workbook-for-review";
        let filename = "invalid-response.xlsx";
        let digest = file_id(original_bytes);
        fs::write(inbox.join(filename), original_bytes).unwrap();
        let mut conn = initialize_database(&base.join("live.sqlite")).unwrap();
        let mut initial = get_snapshot(&conn).unwrap();
        initial["settings"]["factoryReplyDirectory"] =
            json!(fs::canonicalize(&inbox).unwrap().to_string_lossy().to_string());
        initial["settings"]["excelDirectory"] =
            json!(fs::canonicalize(&archive).unwrap().to_string_lossy().to_string());
        write_snapshot(&mut conn, initial, 0, false).unwrap();
        let before = get_snapshot(&conn).unwrap();
        let revision = before["revision"].as_u64().unwrap();
        let mut candidate = before.clone();
        candidate["factoryReplies"] = json!([{
            "id":digest, "filename":filename,"status":"REVIEW",
            "businessDate":"2026-11-08","at":"2026-11-08T00:00:00Z",
            "actor":"자동 감시","rows":[],"error":"Excel 양식 오류"
        }]);
        let result = commit_auto(
            &mut conn, &base, false, filename, &digest, candidate, revision
        ).unwrap();
        assert!(!result.duplicate);
        assert_eq!(result.applied,0);
        assert_eq!(result.held,0);
        let persisted = get_snapshot(&conn).unwrap();
        assert_eq!(persisted["revision"].as_u64(),Some(revision + 1));
        assert_eq!(persisted["factoryReplies"][0]["status"],"REVIEW");
        let archived = persisted["factoryReplies"][0]["archivedPath"].as_str().unwrap();
        assert_eq!(fs::read(archived).unwrap(),original_bytes);
        assert_eq!(persisted["workflow"],before["workflow"]);
        let duplicate = commit_auto(
            &mut conn, &base, false, filename, &digest,
            persisted.clone(), revision + 1
        ).unwrap();
        assert!(duplicate.duplicate);
        drop(conn);
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn matched_reply_is_applied_to_sqlite_once_with_archived_source_and_revision_guard() {
        let base = fixture();
        let inbox = base.join("incoming");
        let archive = base.join("archive");
        fs::create_dir_all(&inbox).unwrap();
        fs::create_dir_all(&archive).unwrap();
        let filename = "matched-response.xlsx";
        let bytes = b"PK\x03\x04synthetic-factory-reply-valid-identity";
        let id = file_id(bytes);
        fs::write(inbox.join(filename), bytes).unwrap();
        let mut db = initialize_database(&base.join("actual-sqlite.db")).unwrap();
        let mut initial = get_snapshot(&db).unwrap();
        initial["settings"]["factoryReplyDirectory"] =
            json!(fs::canonicalize(&inbox).unwrap().to_string_lossy().to_string());
        initial["settings"]["excelDirectory"] =
            json!(fs::canonicalize(&archive).unwrap().to_string_lossy().to_string());
        let recipient = json!({"id":"r1","name":"박수하","address":"서울 서초구 123",
            "phone":"010-1111-2222","mobile":"","actualFreight":4000,
            "items":[{"id":"i1","origin":"FACTORY","quantity":1}]});
        initial["orders"] = json!([{"id":"o1","clientId":"","status":"STATEMENT",
            "createdAt":"2026-11-13T08:00:00Z","recipients":[recipient.clone()]}]);
        initial["workflow"] = json!({"queue":[{
            "id":"q1","shipmentId":"s1","origin":"FACTORY","status":"EXPORTED",
            "snapshot":{"recipient":recipient}}],
            "shipments":[{"id":"s1","orderId":"o1","recipientId":"r1",
                "tracking":{},"actualFreight":{}}],
            "events":[],"groups":[],"sources":[],"payments":[],
            "deliveries":[],"changeRequests":[]});
        write_snapshot(&mut db,initial,0,false).unwrap();
        let before = get_snapshot(&db).unwrap();
        let revision = before["revision"].as_u64().unwrap();
        let mut candidate = before.clone();
        candidate["workflow"]["shipments"][0]["tracking"]["FACTORY"] =
            json!("001234567890");
        candidate["workflow"]["events"].as_array_mut().unwrap().push(json!({
            "id":"event-synthetic","at":"2026-11-13T08:05:00Z",
            "action":"공장 회신 반영","shipmentIds":["s1"]}));
        candidate["factoryReplies"].as_array_mut().unwrap().push(json!({
            "id":id,"filename":filename,"status":"APPLIED",
            "businessDate":"2026-11-13","at":"2026-11-13T08:05:00Z",
            "actor":"직원","rows":[{
                "row":2,"name":"박수하","address":"서울 서초구 １２３",
                "contacts":["010-1111-2222"],"tracking":"001234567890",
                "actual":4000,"shipmentId":"s1","orderId":"o1","applied":true
            }]}));
        let mut unauthorized = candidate.clone();
        unauthorized["orders"][0]["recipients"][0]["name"] = json!("무단 변경");
        assert!(commit_auto(&mut db,&base,false,filename,&id,unauthorized,revision)
            .unwrap_err().contains("orders"));
        assert_eq!(get_snapshot(&db).unwrap(),before);
        let saved = commit_auto(&mut db,&base,false,filename,&id,
            candidate.clone(),revision).unwrap();
        assert!(!saved.duplicate);
        assert_eq!((saved.applied,saved.held),(1,0));
        let current = get_snapshot(&db).unwrap();
        assert_eq!(current["revision"],revision + 1);
        assert_eq!(current["orders"],before["orders"]);
        assert_eq!(current["workflow"]["shipments"][0]["tracking"]["FACTORY"],
            "001234567890");
        // The original order had this amount already: no synthetic overwrite.
        assert!(current["workflow"]["shipments"][0]["actualFreight"]["FACTORY"].is_null());
        assert_eq!(current["factoryReplies"][0]["status"],"APPLIED");
        let original=current["factoryReplies"][0]["archivedPath"].as_str().unwrap();
        assert_eq!(fs::read(original).unwrap(),bytes);
        let duplicate=commit_auto(&mut db,&base,false,filename,&id,
            current.clone(),revision + 1).unwrap();
        assert!(duplicate.duplicate);
        assert_eq!(get_snapshot(&db).unwrap(),current);
        let mut stale=candidate;
        stale["revision"]=json!(revision);
        assert!(commit_auto(&mut db,&base,false,filename,&id,stale,revision)
            .unwrap_err().contains("다른 작업에서"));
        assert_eq!(get_snapshot(&db).unwrap(),current);
        drop(db);
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn unchanged_order_recipient_freight_is_valid_without_new_shipment_rate() {
        let recipient=json!({"id":"r1","name":"박수하","address":"서울 서초구 123",
            "phone":"010-1111-2222","mobile":"","actualFreight":4000,
            "items":[{"origin":"FACTORY"}]});
        let before=json!({"revision":5,"products":[],"settings":{},
            "factoryReplies":[],"orders":[{"id":"o1","recipients":[recipient.clone()]}],
            "workflow":{"queue":[{"shipmentId":"s1","origin":"FACTORY",
                "status":"EXPORTED","snapshot":{"recipient":recipient}}],
                "shipments":[{"id":"s1","orderId":"o1","recipientId":"r1",
                    "tracking":{},"actualFreight":{}}],"events":[]}
        });
        let mut next=before.clone();
        next["workflow"]["shipments"][0]["tracking"]["FACTORY"]=json!("001234567890");
        next["factoryReplies"]=json!([{"id":"factory-reply-test","filename":"reply.xlsx",
            "status":"APPLIED","rows":[{
                "row":2,"name":"박수하","address":"서울 서초구 １２３",
                "contacts":["010-1111-2222"],"tracking":"001234567890",
                "actual":4000,"shipmentId":"s1","orderId":"o1","applied":true
            }]}]);
        next["workflow"]["events"]=json!([{"action":"공장 회신 반영",
            "shipmentIds":["s1"]}]);
        assert_eq!(validate_automatic_change(&before,&next,
            "factory-reply-test","reply.xlsx").unwrap(),(1,0));
        // A changed hidden actual fare must not be accepted by this guard.
        next["orders"][0]["recipients"][0]["actualFreight"]=json!(5000);
        assert!(validate_automatic_change(&before,&next,
            "factory-reply-test","reply.xlsx").is_err());
    }

    #[test]
    fn invalid_automatic_reply_cannot_modify_unrelated_database_fields() {
        let before = json!({
            "revision":4, "products":[], "orders":[], "settings":{},
            "factoryReplies":[], "workflow":{"shipments":[],"events":[],"queue":[]}
        });
        let mut changed = before.clone();
        changed["products"] = json!([{"id":"unauthorized"}]);
        changed["factoryReplies"] = json!([{
            "id":"factory-reply-synthetic","filename":"example.xlsx",
            "status":"REVIEW","rows":[],"error":"invalid"
        }]);
        assert!(validate_automatic_change(&before,&changed,"factory-reply-synthetic","example.xlsx")
            .unwrap_err().contains("products"));
        let mut held = before.clone();
        held["factoryReplies"] = json!([{
            "id":"factory-reply-synthetic","filename":"example.xlsx",
            "status":"REVIEW","rows":[],"error":"양식 오류"
        }]);
        assert_eq!(validate_automatic_change(&before,&held,"factory-reply-synthetic","example.xlsx").unwrap(),(0,0));
    }
}
