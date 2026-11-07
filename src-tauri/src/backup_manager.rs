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
        let mut restored = get_snapshot(conn)?;
        restored["revision"] = json!(next_revision);
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

    fn temporary() -> PathBuf {
        let suffix = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("bando-backup-{}-{suffix}",std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir
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
        assert_eq!(list_backups(&base).unwrap().len(),3);
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
        fs::remove_dir_all(base).unwrap();
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
