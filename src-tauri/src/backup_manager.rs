//! Full SQLite backups for production and isolated TEST workspaces.
//! Daily automatic snapshots retain 30 calendar days. The first actual
//! automatic backup in each local calendar month is promoted to permanent.
//! Manual backups and pre-restore safety backups are never pruned.
use super::*;
use chrono::{Duration as CalendarDuration, NaiveDate};
use rusqlite::{backup::Backup, OpenFlags};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const BACKUP_KEEP_DAYS: i64 = 30;

fn backup_dir(base: &Path) -> PathBuf { base.join("backups") }

fn filename(kind: &str, date: NaiveDate) -> Result<String, String> {
    let unix = SystemTime::now().duration_since(UNIX_EPOCH).map_err(err)?;
    Ok(format!("{kind}-{}-{}-{}.sqlite",
        date.format("%Y%m%d"), unix.as_nanos(), std::process::id()))
}

fn validate_database(conn: &Connection) -> Result<(), String> {
    let integrity: String = conn.query_row("PRAGMA integrity_check", [], |row| row.get(0)).map_err(err)?;
    if integrity != "ok" { return Err(format!("SQLite 데이터 무결성 오류: {integrity}")); }
    let state = get_snapshot(conn)?;
    valid_state(&state)?;
    relational_store::verify(conn)?;
    for table in ["app_state", "product_index", "order_index", "receipt_archive"] {
        let sql = format!("SELECT COUNT(*) FROM {table}");
        conn.query_row(&sql, [], |row| row.get::<_, i64>(0)).map_err(|e|
            format!("백업 파일의 필수 데이터 테이블 {table}을 확인할 수 없습니다: {e}"))?;
    }
    Ok(())
}

fn read_backup(path: &Path) -> Result<Connection, String> {
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(err)?;
    validate_database(&conn)?;
    Ok(conn)
}

fn write_backup(conn: &Connection, base: &Path, kind: &str, date: NaiveDate)
    -> Result<PathBuf, String> {
    let dir = backup_dir(base);
    fs::create_dir_all(&dir).map_err(err)?;
    let path = dir.join(filename(kind, date)?);
    if path.exists() { return Err("같은 이름의 백업 파일이 이미 존재합니다.".into()); }
    // VACUUM INTO is consistent with active WAL and never copies a partial
    // database. Incomplete files are removed if creation/verification fails.
    let outcome = (|| {
        conn.execute("VACUUM INTO ?1", [path.to_string_lossy().to_string()]).map_err(err)?;
        let snapshot = read_backup(&path)?;
        drop(snapshot);
        Ok::<_, String>(())
    })();
    if outcome.is_err() { let _ = fs::remove_file(&path); }
    outcome?;
    Ok(path)
}

pub(super) fn manual_backup(conn: &Connection, base: &Path) -> Result<String, String> {
    let path = write_backup(conn, base, "manual", Local::now().date_naive())?;
    Ok(path.to_string_lossy().into_owned())
}

pub(super) fn list_backups(base: &Path) -> Result<Vec<String>, String> {
    let dir = backup_dir(base);
    if !dir.exists() { return Ok(vec![]); }
    let mut names = fs::read_dir(dir).map_err(err)?.filter_map(Result::ok)
        .filter(|e| e.path().extension().is_some_and(|v| v == "sqlite") && e.path().is_file())
        .map(|entry| entry.path().to_string_lossy().into_owned()).collect::<Vec<_>>();
    names.sort();
    names.reverse();
    Ok(names)
}

fn name_date(name: &str, prefix: &str) -> Option<NaiveDate> {
    let date = name.strip_prefix(prefix)?.get(..8)?;
    NaiveDate::parse_from_str(date, "%Y%m%d").ok()
}

fn month_has_permanent(dir: &Path, date: NaiveDate) -> Result<bool, String> {
    if !dir.exists() { return Ok(false); }
    for entry in fs::read_dir(dir).map_err(err)? {
        let entry = entry.map_err(err)?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if entry.path().is_file() && name.ends_with(".sqlite")
            && name_date(&name, "monthly-").is_some_and(|saved|
                saved.year() == date.year() && saved.month() == date.month()) {
            return Ok(true);
        }
    }
    Ok(false)
}

fn day_has_automatic(dir: &Path, date: NaiveDate) -> Result<bool, String> {
    if !dir.exists() { return Ok(false); }
    for entry in fs::read_dir(dir).map_err(err)? {
        let entry = entry.map_err(err)?;
        if !entry.path().is_file() { continue; }
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.ends_with(".sqlite") { continue; }
        if name_date(&name, "auto-") == Some(date) ||
            name_date(&name, "monthly-") == Some(date) { return Ok(true); }
    }
    Ok(false)
}

/// Never delete unknown, manual, monthly, pre-restore, or legacy backup names.
/// A missing/invalid date also means preservation, not deletion.
fn prune_automatic(dir: &Path, date: NaiveDate) -> Result<(), String> {
    if !dir.exists() { return Ok(()); }
    let oldest = date - CalendarDuration::days(BACKUP_KEEP_DAYS - 1);
    for entry in fs::read_dir(dir).map_err(err)? {
        let entry = entry.map_err(err)?;
        let path = entry.path();
        if !path.is_file() || path.extension().is_none_or(|v| v != "sqlite") { continue; }
        let name = entry.file_name().to_string_lossy().into_owned();
        if name_date(&name, "auto-").is_some_and(|saved| saved < oldest) {
            fs::remove_file(path).map_err(err)?;
        }
    }
    Ok(())
}

/// Called once on application startup. An app left open across midnight
/// does not schedule another backup until it is launched again.
/// A day without a backup has no invented file: the next actual backup
/// becomes that month's permanent first-backup day.
pub(super) fn automatic_backup_if_needed(
    conn: &Connection, base: &Path, today: NaiveDate
) -> Result<Option<String>, String> {
    let dir = backup_dir(base);
    fs::create_dir_all(&dir).map_err(err)?;
    if day_has_automatic(&dir, today)? {
        prune_automatic(&dir, today)?;
        return Ok(None);
    }
    let kind = if month_has_permanent(&dir, today)? { "auto" } else { "monthly" };
    let path = write_backup(conn, base, kind, today)?;
    prune_automatic(&dir, today)?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

fn copy_entire_db(source: &Connection, target: &mut Connection) -> Result<(), String> {
    {
        let copy = Backup::new(source, target).map_err(err)?;
        copy.run_to_completion(128, Duration::from_millis(20), None).map_err(err)?;
    }
    validate_database(target)
}

fn restore_selected(conn: &mut Connection, base: &Path, filename: &str)
    -> Result<String, String> {
    let allowed = fs::canonicalize(backup_dir(base)).map_err(err)?;
    let selected = fs::canonicalize(filename).map_err(err)?;
    if selected.parent() != Some(allowed.as_path()) ||
        selected.extension().is_none_or(|ext| ext != "sqlite") ||
        !selected.is_file() {
        return Err("현재 작업공간 백업 폴더 안의 SQLite 파일만 복원할 수 있습니다.".into());
    }
    // Validate the selected backup BEFORE writing anything to the live DB.
    let backup = read_backup(&selected)?;
    let active_revision = get_snapshot(conn)?["revision"].as_u64().ok_or("현재 DB 리비전 오류")?;
    let selected_revision = get_snapshot(&backup)?["revision"].as_u64().ok_or("백업 DB 리비전 오류")?;
    // Never reuse an old revision after restoring history: a stale editor must
    // not accidentally overwrite the newly restored data.
    let next_revision = active_revision.max(selected_revision)
        .checked_add(1).ok_or("리비전 한도 초과로 복원할 수 없습니다.")?;
    // Save the current entire SQLite DB, not just the app_state JSON.
    let safety = write_backup(conn, base, "pre-restore", Local::now().date_naive())?;
    let result = (|| {
        copy_entire_db(&backup, conn)?;
        // Backups made before the split still contain legacy JSON. Convert
        // them transactionally after the entire backup is restored.
        relational_store::migrate(conn)?;
        let mut restored = get_snapshot(conn)?;
        restored["revision"] = json!(next_revision);
        relational_store::strip_core(&mut restored);
        conn.execute("UPDATE app_state SET payload=?1 WHERE id=1",
            [serde_json::to_string(&restored).map_err(err)?]).map_err(err)?;
        validate_database(conn)
    })();
    if let Err(primary_error) = result {
        // The SQLite backup API is transactional, but independently verify
        // the rollback path and retain the safety copy for manual recovery.
        let rollback = read_backup(&safety)
            .and_then(|previous| copy_entire_db(&previous, conn));
        return match rollback {
            Ok(()) => Err(format!("복원을 취소하고 직전 상태로 되돌렸습니다: {primary_error}")),
            Err(rollback_error) => Err(format!(
                "복원 및 자동 원상복구에 실패했습니다. 안전 백업 {}을 보존했습니다. 오류: {primary_error}; 원상복구: {rollback_error}",
                safety.display())),
        };
    }
    Ok(safety.to_string_lossy().into_owned())
}

pub(super) fn restore_backup(conn: &mut Connection, base: &Path, filename: &str)
    -> Result<String, String> {
    restore_selected(conn, base, filename)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    // The Rust test runner executes cases in parallel. Windows system clock
    // values alone are not a collision-proof temporary directory identifier.
    // Reserve a fresh directory atomically instead of reusing an existing one.
    static NEXT_TEST_DIRECTORY: AtomicU64 = AtomicU64::new(0);

    fn temporary() -> PathBuf {
        for _ in 0..1_000 {
            let timestamp = SystemTime::now().duration_since(UNIX_EPOCH)
                .unwrap().as_nanos();
            let unique = NEXT_TEST_DIRECTORY.fetch_add(1, Ordering::Relaxed);
            let dir = std::env::temp_dir().join(format!(
                "bando-backup-test-{}-{timestamp}-{unique}", std::process::id()
            ));
            match fs::create_dir(&dir) {
                Ok(()) => return dir,
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => panic!("백업 시험용 독립 폴더 생성 실패: {error}"),
            }
        }
        panic!("백업 시험용 독립 폴더 주소를 확보하지 못했습니다.")
    }

    #[test]
    fn parallel_tests_never_share_backup_directories() {
        let threads: Vec<_> = (0..16).map(|_| std::thread::spawn(temporary)).collect();
        let mut seen = std::collections::HashSet::new();
        let mut paths = Vec::new();
        for thread in threads {
            let path = thread.join().expect("시험용 폴더 생성 스레드 실패");
            assert!(path.is_dir());
            assert!(seen.insert(path.clone()), "다른 테스트와 폴더가 중복됐습니다");
            paths.push(path);
        }
        for path in paths {
            fs::remove_dir(path).unwrap();
        }
    }
    fn date(ymd: &str) -> NaiveDate {
        NaiveDate::parse_from_str(ymd,"%Y%m%d").unwrap()
    }
    #[test]
    fn first_actual_backup_in_month_becomes_permanent_even_after_closed_days() {
        let base = temporary();
        let conn = initialize_database(&base.join("main.sqlite")).unwrap();
        assert!(automatic_backup_if_needed(&conn,&base,date("20261203")).unwrap()
            .unwrap().contains("monthly-20261203"));
        assert!(automatic_backup_if_needed(&conn,&base,date("20261203")).unwrap().is_none());
        assert!(automatic_backup_if_needed(&conn,&base,date("20261204")).unwrap()
            .unwrap().contains("auto-20261204"));
        assert!(automatic_backup_if_needed(&conn,&base,date("20270105")).unwrap()
            .unwrap().contains("monthly-20270105"));
        // January 5 is 32 days after the ordinary December 4 backup.
        // The 30-day retention must remove that old daily backup, while
        // December 3 and January 5 remain as permanent monthly snapshots.
        let backups = list_backups(&base).unwrap();
        assert_eq!(backups.len(), 2, "예상하지 못한 백업 파일: {backups:?}");
        assert!(backups.iter().any(|name| name.contains("monthly-20261203")));
        assert!(backups.iter().any(|name| name.contains("monthly-20270105")));
        assert!(!backups.iter().any(|name| name.contains("auto-20261204")));
        drop(conn);
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn retention_prunes_only_expired_auto_and_keeps_monthly_manual_safety_and_legacy() {
        let base = temporary();
        let dir = backup_dir(&base);
        fs::create_dir_all(&dir).unwrap();
        for name in [
            "auto-20260901-1.sqlite", "auto-20261009-1.sqlite",
            "auto-20261010-1.sqlite", "auto-invalid.sqlite",
            "monthly-20260901-1.sqlite", "manual-20260801-1.sqlite",
            "pre-restore-20260801-1.sqlite", "bando-hub-old.sqlite"
        ] { fs::write(dir.join(name), b"fixture").unwrap(); }
        prune_automatic(&dir,date("20261108")).unwrap();
        for expired in ["auto-20260901-1.sqlite","auto-20261009-1.sqlite"] {
            assert!(!dir.join(expired).exists());
        }
        for retained in ["auto-20261010-1.sqlite","auto-invalid.sqlite","monthly-20260901-1.sqlite",
            "manual-20260801-1.sqlite","pre-restore-20260801-1.sqlite","bando-hub-old.sqlite"] {
            assert!(dir.join(retained).exists());
        }
        // Windows CI can temporarily hold the synthetic .sqlite fixtures open
        // while virus scanning. This cleanup is not part of the retention
        // behavior under test: the file presence assertions above are.
        let mut removed = false;
        for _ in 0..10 {
            match fs::remove_dir_all(&base) {
                Ok(()) => { removed = true; break; },
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    removed = true; break;
                }
                Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => {
                    std::thread::sleep(Duration::from_millis(100));
                }
                Err(e) => panic!("테스트 임시 백업 폴더 정리 실패: {e}"),
            }
        }
        if !removed {
            eprintln!("Windows 테스트 임시 폴더가 잠겨 정리를 건너뜁니다: {}", base.display());
        }
    }

    #[test]
    fn entire_sqlite_restore_recovers_snapshot_indexes_and_receipt_audit() {
        let base = temporary();
        let mut conn = initialize_database(&base.join("main.sqlite")).unwrap();
        let mut state = get_snapshot(&conn).unwrap();
        state["settings"]["operatorName"] = json!("before");
        state["clients"] = json!([{"id":"sample","name":"가상악기사",
            "address":"서울 테스트로 1","phone":"010-0000-0000","tier":"wholesale"}]);
        write_snapshot(&mut conn,state,0,false).unwrap();
        conn.execute("INSERT INTO receipt_archive(id,order_id,record) VALUES ('receipt:example','order','{\"original\":\"before\"}')",[]).unwrap();
        let before = get_snapshot(&conn).unwrap();
        let archive_count: i64 = conn.query_row("SELECT COUNT(*) FROM receipt_archive",[],|row| row.get(0)).unwrap();
        let original = manual_backup(&conn,&base).unwrap();

        let mut changed = before.clone();
        changed["settings"]["operatorName"] = json!("after");
        write_snapshot(&mut conn,changed,1,false).unwrap();
        conn.execute("DELETE FROM receipt_archive",[]).unwrap();
        assert_eq!(restore_backup(&mut conn,&base,&original).is_ok(),true);
        let mut expected = before.clone();
        expected["revision"] = json!(3);
        assert_eq!(get_snapshot(&conn).unwrap(),expected);
        let restored_count: i64 = conn.query_row("SELECT COUNT(*) FROM receipt_archive",[],|row| row.get(0)).unwrap();
        assert_eq!(restored_count,archive_count);
        assert!(list_backups(&base).unwrap().iter().any(|f| f.contains("pre-restore-")));
        drop(conn);
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn practical_v2_backup_restore_returns_prices_aliases_orders_and_audit_with_safe_undo(){
        let base=temporary();
        let path=base.join("main.sqlite");
        let mut conn=initialize_database(&path).unwrap();
        let mut original=get_snapshot(&conn).unwrap();
        let product_id=original["products"][0]["id"].as_str().unwrap().to_owned();
        let price_id=original["products"][0]["variants"][0]["id"].as_str().unwrap().to_owned();
        let second_id=original["products"][1]["id"].as_str().unwrap().to_owned();
        let second_price=original["products"][1]["variants"][0]["id"].as_str().unwrap().to_owned();

        original["products"][0]["variants"][0]["wholesale"]=json!(31870);
        original["products"][0]["variants"][0]["semi"]=json!(41870);
        original["products"][0]["variants"][0]["retail"]=json!(51870);
        let mut special_overrides=serde_json::Map::new();
        special_overrides.insert(price_id.clone(),json!(27630));
        original["clients"]=json!([{
            "id":"company-1","name":"가상 특수 거래처","tier":"special",
            "address":"가상 발송지","phone":"010-0000-0000",
            "overrides":special_overrides
        }]);
        original["aliases"]=json!([{
            "id":"dealer-alias","clientId":"company-1","text":"특수거래처 지정 상품",
            "productId":product_id,"variantId":price_id
        },{
            "id":"global-alias","clientId":null,"text":"공통 가상 상품",
            "productId":second_id,"variantId":second_price
        }]);
        let date="2026-11-08T10:00:00+09:00";
        let confirmed_item=json!({
            "id":"item-confirmed","productId":product_id,"variantId":price_id,
            "name":"당시 확정 상품명","quantity":2,"unitPrice":27630
        });
        let confirmed_snapshot=json!({
            "at":date,"raw":"확정 원문 / 상품 2개",
            "recipients":[{"id":"copy-receiver","name":"가상 수령인",
                "items":[confirmed_item.clone()]}]
        });
        original["orders"]=json!([{
            "id":"paid-confirmed","clientId":"company-1","createdAt":date,
            "confirmedAt":date,"raw":"확정 원문 / 상품 2개","status":"STATEMENT",
            "receipt":{"original":"확정 원문 / 상품 2개","at":date,
                "actor":"검증 담당자","clientId":"company-1"},
            "rawCorrections":[{
                "id":"history-1","at":date,"before":"원문 수정 전",
                "after":"원문 수정 후","actor":"검증 담당자"
            }],
            "confirmationSnapshot":confirmed_snapshot,
            "recipients":[{
                "id":"receiver-confirmed","name":"확정 수취인","items":[confirmed_item]
            }]
        },{
            "id":"draft-pending","clientId":"company-1","createdAt":date,
            "status":"REVIEW","raw":"미확정 주문",
            "recipients":[{
                "id":"receiver-draft","name":"가상 수취인",
                "items":[{
                    "id":"item-draft","productId":second_id,"variantId":second_price,
                    "name":"두 번째 상품","quantity":5,"unitPrice":41870
                }]
            }]
        }]);
        original["workflow"]=json!({
            "shipments":[{
                "id":"ship-1","orderId":"paid-confirmed",
                "recipientId":"receiver-confirmed","step":2,
                "freight":4000,"trackingNumber":"TEST123"
            }],
            "events":[{
                "id":"event-1","action":"주문 확인 완료",
                "shipmentIds":["ship-1"]
            }]
        });
        let saved=write_snapshot(&mut conn,original,0,false).unwrap();
        assert_eq!(saved["revision"],1);
        let archive_before:Vec<(String,String,String)> = {
            let mut query=conn.prepare(
                "SELECT id,order_id,record FROM receipt_archive ORDER BY id"
            ).unwrap();
            query.query_map([],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap()
                .collect::<Result<Vec<_>,_>>().unwrap()
        };
        assert_eq!(archive_before.len(),2);
        let original_manual=manual_backup(&conn,&base).unwrap();
        let opened=read_backup(Path::new(&original_manual)).unwrap();
        assert_eq!(get_snapshot(&opened).unwrap(),saved);
        relational_store::verify(&opened).unwrap();
        drop(opened);

        // Simulate employee changes after the backup: prices, alias links,
        // draft order quantity, special pricing, workflow, audit archive.
        let mut latest=saved.clone();
        latest["products"][0]["variants"][0]["wholesale"]=json!(99999);
        latest["products"][0]["variants"][0]["semi"]=json!(88888);
        latest["products"][0]["variants"][0]["retail"]=json!(77777);
        latest["clients"][0]["overrides"][price_id.as_str()]=json!(60000);
        latest["clients"][0]["address"]=json!("사후 변경된 주소");
        latest["aliases"]=json!([]);
        latest["orders"][1]["recipients"][0]["items"][0]["quantity"]=json!(98);
        latest["workflow"]["shipments"][0]["trackingNumber"]=json!("AFTER999");
        let changed=write_snapshot(&mut conn,latest,1,false).unwrap();
        assert_eq!(changed["revision"],2);
        conn.execute("DELETE FROM receipt_archive WHERE id='correction:history-1'",[]).unwrap();
        assert_ne!(get_snapshot(&conn).unwrap(),saved);

        let safety=restore_backup(&mut conn,&base,&original_manual).unwrap();
        let mut expected=saved.clone();
        expected["revision"]=json!(3);
        assert_eq!(get_snapshot(&conn).unwrap(),expected);
        let recovered_archive:Vec<(String,String,String)> = {
            let mut query=conn.prepare("SELECT id,order_id,record FROM receipt_archive ORDER BY id").unwrap();
            query.query_map([],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap()
                .collect::<Result<Vec<_>,_>>().unwrap()
        };
        assert_eq!(recovered_archive,archive_before);
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM core_product_prices",
            [],|r|r.get::<_,i64>(0)).unwrap(),360);
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM core_items",
            [],|r|r.get::<_,i64>(0)).unwrap(),2);
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM order_index",
            [],|r|r.get::<_,i64>(0)).unwrap(),2);
        relational_store::verify(&conn).unwrap();

        // The rollback copy contains the entire state from just before restore.
        let undo=read_backup(Path::new(&safety)).unwrap();
        assert_eq!(get_snapshot(&undo).unwrap(),changed);
        let count:i64=undo.query_row("SELECT COUNT(*) FROM receipt_archive",
            [],|r|r.get(0)).unwrap();
        assert_eq!(count,1);
        drop(undo);
        assert!(write_snapshot(&mut conn,changed.clone(),2,false).unwrap_err()
            .contains("새로고침"));

        drop(conn);
        let reopened=initialize_database(&path).unwrap();
        assert_eq!(get_snapshot(&reopened).unwrap(),expected);
        relational_store::verify(&reopened).unwrap();
        drop(reopened);
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn legacy_backup_restores_exact_prices_aliases_draft_and_frozen_orders_then_rolls_back_ambiguous_input(){
        let base=temporary();
        let path=base.join("main.sqlite");
        let mut live=initialize_database(&path).unwrap();
        let mut current=get_snapshot(&live).unwrap();
        current["settings"]["operatorName"]=json!("현재 작업 직원");
        let current=write_snapshot(&mut live,current,0,false).unwrap();
        assert_eq!(current["revision"],1);

        let mut legacy:Value=serde_json::from_str(
            include_str!("../resources/legacy-state-seed-303.json")).unwrap();
        let idx=legacy["products"].as_array().unwrap().iter()
            .position(|p|p["id"]=="bando-site-351").unwrap();
        let first=legacy["products"][idx]["variants"][0]["id"].as_str().unwrap().to_owned();
        let second=legacy["products"][idx]["variants"][1]["id"].as_str().unwrap().to_owned();
        legacy["products"][idx]["variants"][0]["wholesale"]=json!(18321);
        legacy["products"][idx]["variants"][0]["semi"]=json!(28321);
        legacy["products"][idx]["variants"][0]["retail"]=json!(38321);
        legacy["products"][idx]["variants"][1]["wholesale"]=json!(18322);
        legacy["products"][idx]["variants"][1]["semi"]=json!(28322);
        legacy["products"][idx]["variants"][1]["retail"]=json!(38322);
        let mut overrides=serde_json::Map::new();
        overrides.insert(first.clone(),json!(16321));
        legacy["clients"]=json!([{
            "id":"legacy-dealer","name":"이전 대리점","tier":"special",
            "address":"예전 발송 주소","phone":"010-0000-0000","overrides":overrides
        }]);
        legacy["aliases"]=json!([
            {"id":"legacy-scoped","clientId":"legacy-dealer",
             "text":"거래처 내부 별칭","productId":"bando-site-351","variantId":first},
            {"id":"legacy-shared","clientId":null,
             "text":"공통 별칭","productId":"bando-site-351","variantId":second}
        ]);
        legacy["orders"]=json!([
            {"id":"legacy-draft","clientId":"legacy-dealer",
             "createdAt":"2026-11-08T01:00:00+09:00","status":"REVIEW",
             "recipients":[{
                 "id":"legacy-draft-recipient","name":"가상 수취인",
                 "items":[{"id":"legacy-draft-item","productId":"bando-site-351",
                     "variantId":second,"name":"프로스트 구성","quantity":2,"unitPrice":28322}]
             }]},
            {"id":"legacy-confirmed","clientId":"legacy-dealer",
             "createdAt":"2026-11-08T01:00:00+09:00",
             "confirmedAt":"2026-11-08T01:05:00+09:00","status":"STATEMENT",
             "raw":"과거 발주 원문","receipt":{"original":"과거 발주 원문","actor":"가상 직원"},
             "confirmationSnapshot":{"raw":"과거 발주 원문","recipients":[{
                 "items":[{"productId":"bando-site-351","variantId":first,
                     "name":"과거 확정 상품명","quantity":3,"unitPrice":16321}]}]},
             "recipients":[{
                 "id":"legacy-confirmed-recipient","name":"가상 수취인",
                 "items":[{"id":"legacy-confirmed-item","productId":"bando-site-351",
                     "variantId":first,"name":"과거 확정 상품명","quantity":3,"unitPrice":16321}]
             }]}
        ]);
        let frozen=legacy["orders"][1].clone();
        legacy["revision"]=json!(7);
        // Unlike manual_backup, a hand-crafted historical fixture must create
        // its target directory before Connection::open on Windows.
        fs::create_dir_all(base.join("backups")).unwrap();
        let backup_file=base.join("backups").join("manual-legacy-v0.sqlite");
        let create_legacy=|destination:&Path,data:&Value|{
            let conn=Connection::open(destination).unwrap();
            conn.execute_batch(r#"
                CREATE TABLE app_state(id INTEGER PRIMARY KEY,payload TEXT NOT NULL);
                CREATE TABLE product_index(
                    id TEXT PRIMARY KEY,code TEXT NOT NULL,name TEXT NOT NULL,payload TEXT NOT NULL);
                CREATE TABLE order_index(
                    id TEXT PRIMARY KEY,client_id TEXT NOT NULL,created_at TEXT NOT NULL,
                    confirmed_at TEXT,status TEXT NOT NULL);
                CREATE TABLE receipt_archive(
                    id TEXT PRIMARY KEY,order_id TEXT NOT NULL,record TEXT NOT NULL);
            "#).unwrap();
            conn.execute("INSERT INTO app_state(id,payload) VALUES (1,?1)",
                [serde_json::to_string(data).unwrap()]).unwrap();
            // Old backups can contain the frozen receipt only inside the order
            // JSON, before an independent receipt_archive row was introduced.
            // The restore migration must backfill it without changing the order.
            conn
        };
        let historical=create_legacy(&backup_file,&legacy);
        assert_eq!(get_snapshot(&historical).unwrap(),legacy);
        drop(historical);

        let safety=restore_backup(&mut live,&base,&backup_file.to_string_lossy()).unwrap();
        let restored=get_snapshot(&live).unwrap();
        assert_eq!(restored["revision"],8);
        assert_eq!(restored["clients"],legacy["clients"]);
        assert_eq!(restored["orders"][1],frozen);
        let clear=restored["products"].as_array().unwrap().iter()
            .find(|p|p["variants"][0]["id"]==first).unwrap();
        let frost=restored["products"].as_array().unwrap().iter()
            .find(|p|p["variants"][0]["id"]==second).unwrap();
        assert_eq!(clear["variants"][0]["wholesale"],18321);
        assert_eq!(clear["variants"][0]["semi"],28321);
        assert_eq!(clear["variants"][0]["retail"],38321);
        assert_eq!(frost["variants"][0]["wholesale"],18322);
        assert_eq!(frost["variants"][0]["semi"],28322);
        assert_eq!(frost["variants"][0]["retail"],38322);
        assert_eq!(restored["clients"][0]["overrides"][first.as_str()],16321);
        assert_eq!(restored["aliases"][0]["productId"],clear["id"]);
        assert_eq!(restored["aliases"][1]["productId"],frost["id"]);
        assert_eq!(restored["aliases"][0]["clientId"],"legacy-dealer");
        assert_eq!(restored["aliases"][1]["clientId"],Value::Null);
        assert_eq!(restored["orders"][0]["recipients"][0]["items"][0]["productId"],frost["id"]);
        assert_eq!(restored["orders"][0]["recipients"][0]["items"][0]["unitPrice"],28322);
        assert_eq!(restored["orders"][1]["recipients"][0]["items"][0]["productId"],"bando-site-351");
        assert_eq!(live.query_row("SELECT COUNT(*) FROM core_product_prices",[],
            |r|r.get::<_,i64>(0)).unwrap(),360);
        assert_eq!(live.query_row("SELECT COUNT(*) FROM order_index",[],
            |r|r.get::<_,i64>(0)).unwrap(),2);
        let archived:String=live.query_row(
            "SELECT record FROM receipt_archive WHERE id='receipt:legacy-confirmed'",[],
            |r|r.get(0)).unwrap();
        assert_eq!(serde_json::from_str::<Value>(&archived).unwrap(),
            legacy["orders"][1]["receipt"]);
        relational_store::verify(&live).unwrap();
        let safety_conn=read_backup(Path::new(&safety)).unwrap();
        assert_eq!(get_snapshot(&safety_conn).unwrap(),current);
        drop(safety_conn);

        // The same legacy database with an unresolvable alias can be opened
        // as a valid SQLite file, but its migration must fail and restore the
        // complete pre-restore state (rather than dropping any order or price).
        let mut ambiguous=legacy.clone();
        ambiguous["aliases"][0].as_object_mut().unwrap().remove("variantId");
        let invalid_path=base.join("backups").join("manual-ambiguous-v0.sqlite");
        let invalid=create_legacy(&invalid_path,&ambiguous);
        drop(invalid);
        let before=get_snapshot(&live).unwrap();
        let before_audit:String=live.query_row(
            "SELECT record FROM receipt_archive WHERE id='receipt:legacy-confirmed'",[],
            |r|r.get(0)).unwrap();
        let err=restore_backup(&mut live,&base,&invalid_path.to_string_lossy()).unwrap_err();
        assert!(err.contains("별칭"),"unexpected restoration error: {err}");
        assert_eq!(get_snapshot(&live).unwrap(),before);
        let after_audit:String=live.query_row(
            "SELECT record FROM receipt_archive WHERE id='receipt:legacy-confirmed'",[],
            |r|r.get(0)).unwrap();
        assert_eq!(after_audit,before_audit);
        relational_store::verify(&live).unwrap();

        // A legacy backup with a *different* receipt under an existing audit ID
        // is rejected rather than overwriting immutable evidence.
        let conflict_path=base.join("backups").join("manual-conflicting-audit-v0.sqlite");
        let conflicting=create_legacy(&conflict_path,&legacy);
        conflicting.execute(
            "INSERT INTO receipt_archive(id,order_id,record)
             VALUES ('receipt:legacy-confirmed','legacy-confirmed',?1)",
            [r#"{"original":"변조된 가상 접수 원문"}"#]
        ).unwrap();
        drop(conflicting);
        let before_conflict=get_snapshot(&live).unwrap();
        let failure=restore_backup(&mut live,&base,&conflict_path.to_string_lossy()).unwrap_err();
        assert!(failure.contains("충돌"),"unexpected conflict response: {failure}");
        assert_eq!(get_snapshot(&live).unwrap(),before_conflict);
        assert_eq!(live.query_row(
            "SELECT record FROM receipt_archive WHERE id='receipt:legacy-confirmed'",[],
            |r|r.get::<_,String>(0)).unwrap(),before_audit);
        relational_store::verify(&live).unwrap();
        drop(live);
        let reopened=initialize_database(&path).unwrap();
        assert_eq!(get_snapshot(&reopened).unwrap(),before);
        drop(reopened);
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn corrupt_backup_is_rejected_without_changing_current_db() {
        let base = temporary();
        let mut conn = initialize_database(&base.join("main.sqlite")).unwrap();
        let before = get_snapshot(&conn).unwrap();
        let dir = backup_dir(&base);
        fs::create_dir_all(&dir).unwrap();
        let bad = dir.join("manual-corrupt.sqlite");
        fs::write(&bad,b"not a sqlite file").unwrap();
        assert!(restore_backup(&mut conn,&base,&bad.to_string_lossy()).is_err());
        assert_eq!(get_snapshot(&conn).unwrap(),before);
        assert!(!list_backups(&base).unwrap().iter().any(|f| f.contains("pre-restore-")));
        drop(conn);
        fs::remove_dir_all(base).unwrap();
    }
}
