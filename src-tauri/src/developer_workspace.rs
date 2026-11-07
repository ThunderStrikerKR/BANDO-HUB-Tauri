//! Native isolated developer workspace. Only this secondary process may reset
//! its database and record synthetic case runs. The production SQLite file is
//! opened READ ONLY once during first test workspace creation.
use super::*;
use rusqlite::OpenFlags;

const TEST_ARGUMENT: &str = "--bando-developer-test";

fn test_root(app_root: &Path) -> PathBuf {
    app_root.join("developer-test")
}

/// Preserve master products/prices/category/shipping/settings but omit all
/// actual client, order, audit, payment, notification, alias and export records.
fn clean_activity(mut snapshot: Value, test_base: &Path) -> Result<Value, String> {
    for key in [
        "orders", "clients", "aliases", "queue", "exports",
        "factoryReplies", "registrationBatches",
    ] {
        snapshot[key] = json!([]);
    }
    // Workflow records may reference production clients/orders; none may cross.
    snapshot["workflow"] = json!({
        "sources": [], "groups": [], "shipments": [], "payments": [],
        "queue": [], "events": [], "deliveries": [],
        "changeRequests": [], "confirmations": []
    });
    let excel = test_base.join("Excel");
    fs::create_dir_all(&excel).map_err(err)?;
    let excel = canonical_excel_directory(&excel)?;
    let settings = snapshot["settings"].as_object_mut().ok_or("테스트 기준 설정 오류")?;
    settings.insert("excelDirectory".into(), json!(excel.to_string_lossy().to_string()));
    settings.remove("factoryReplyDirectory");
    snapshot["revision"] = json!(0);
    valid_state(&snapshot)?;
    Ok(snapshot)
}
fn ensure_run_table(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(r#"
        CREATE TABLE IF NOT EXISTS developer_test_runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            recorded_at TEXT NOT NULL,
            scenario TEXT NOT NULL,
            passed INTEGER NOT NULL,
            report TEXT NOT NULL
        );
    "#).map_err(err)
}
pub(super) fn open_isolated(app_root: &Path) -> Result<(PathBuf, Connection), String> {
    let root = test_root(app_root);
    fs::create_dir_all(&root).map_err(err)?;
    let path = root.join("bando-hub-test.sqlite");
    let first_open = !path.exists();
    let baseline = if first_open {
        let production = Connection::open_with_flags(
            app_root.join("bando-hub-v001.sqlite"), OpenFlags::SQLITE_OPEN_READ_ONLY
        ).map_err(|e| format!("기준 업무 DB를 읽을 수 없습니다: {e}"))?;
        Some(clean_activity(get_snapshot(&production)?, &root)?)
    } else { None };
    let mut conn = initialize_database(&path)?;
    ensure_run_table(&conn)?;
    if let Some(initial) = baseline {
        // The new test database begins at seed revision 0; copy just master data.
        write_snapshot(&mut conn, initial, 0, false)?;
    }
    Ok((root, conn))
}
#[tauri::command]
pub fn workspace_mode(db: State<'_, Database>) -> bool { db.is_test }

#[tauri::command]
pub fn open_test_workspace(db: State<'_, Database>) -> Result<(), String> {
    if db.is_test {
        return Err("이미 테스트 작업공간에서 실행 중입니다.".into());
    }
    // Never trust an executable path supplied by JavaScript.
    std::process::Command::new(std::env::current_exe().map_err(err)?)
        .arg(TEST_ARGUMENT).spawn().map_err(err)?;
    Ok(())
}

#[tauri::command]
pub fn test_database_preview(db: State<'_, Database>) -> Result<Value, String> {
    if !db.is_test { return Ok(json!({"enabled":false})); }
    let conn = lock_db(&db)?;
    let state = get_snapshot(&conn)?;
    let workflow = &state["workflow"];
    let count = |v: &Value| v.as_array().map_or(0, Vec::len);
    Ok(json!({
        "enabled": true,
        "revision": state["revision"].as_u64().unwrap_or(0),
        "orders": count(&state["orders"]), "clients": count(&state["clients"]),
        "exports": count(&state["exports"]), "shipments": count(&workflow["shipments"]),
        "payments": count(&workflow["payments"]), "replies": count(&state["factoryReplies"])
    }))
}
fn backup_test_and_reset(conn: &mut Connection, base: &Path, expected_revision: u64)
    -> Result<String, String> {
    let previous = get_snapshot(conn)?;
    if previous["revision"].as_u64().unwrap_or(0) != expected_revision {
        return Err("다른 시험 작업에서 데이터가 변경됐습니다. 다시 조회하세요.".into());
    }
    let mut next = clean_activity(previous, base)?;
    next["revision"] = json!(expected_revision + 1);
    let backups = base.join("backups");
    fs::create_dir_all(&backups).map_err(err)?;
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).map_err(err)?.as_nanos();
    let dest = backups.join(format!("test-reset-{}-{nanos}.sqlite", std::process::id()));
    // Consistent SQLite backup occurs BEFORE touching any working data.
    conn.execute("VACUUM INTO ?1", [dest.to_string_lossy().to_string()]).map_err(err)?;
    let tx = conn.transaction().map_err(err)?;
    let actual = get_snapshot(&tx)?;
    if actual["revision"].as_u64().unwrap_or(0) != expected_revision {
        return Err("백업 중 데이터가 바뀌었습니다. 초기화를 취소했습니다.".into());
    }
    tx.execute("UPDATE app_state SET payload=?1 WHERE id=1",
        [serde_json::to_string(&next).map_err(err)?]).map_err(err)?;
    tx.execute("DELETE FROM order_index", []).map_err(err)?;
    tx.execute("DELETE FROM receipt_archive", []).map_err(err)?;
    tx.execute("DELETE FROM developer_test_runs", []).map_err(err)?;
    // Existing products and their price index remain unchanged.
    tx.commit().map_err(err)?;
    Ok(dest.to_string_lossy().into_owned())
}
#[tauri::command]
pub fn reset_test_database(db: State<'_, Database>, revision: u64) -> Result<Value, String> {
    if !db.is_test { return Err("정식 업무 데이터베이스는 개발자 모드에서 초기화할 수 없습니다.".into()); }
    let mut conn = lock_db(&db)?;
    let backup = backup_test_and_reset(&mut *conn, &db.base, revision)?;
    Ok(json!({"backup":backup}))
}

#[tauri::command]
pub fn test_record_run(db: State<'_, Database>, report: Value) -> Result<(), String> {
    if !db.is_test { return Err("시험 결과는 격리된 작업공간에서만 저장합니다.".into()); }
    let scenario = report["scenario"].as_str().filter(|s| !s.is_empty() && s.len() <= 160)
        .ok_or("시험 시나리오 이름이 올바르지 않습니다.")?;
    let passed = report["passed"].as_bool().ok_or("시험 판정 형식이 올바르지 않습니다.")?;
    let raw = serde_json::to_string(&report).map_err(err)?;
    if raw.len() > 96 * 1024 { return Err("시험 결과가 허용 크기를 초과했습니다.".into()); }
    let at = Local::now().to_rfc3339();
    let conn = lock_db(&db)?;
    ensure_run_table(&conn)?;
    conn.execute("INSERT INTO developer_test_runs(recorded_at,scenario,passed,report) VALUES (?1,?2,?3,?4)",
        params![at,scenario,i64::from(passed),raw]).map_err(err)?;
    // Bounded history; keep the latest 200 runs only.
    conn.execute("DELETE FROM developer_test_runs WHERE id NOT IN
        (SELECT id FROM developer_test_runs ORDER BY id DESC LIMIT 200)", []).map_err(err)?;
    Ok(())
}

#[tauri::command]
pub fn test_run_history(db: State<'_, Database>) -> Result<Value, String> {
    if !db.is_test { return Err("시험 기록은 격리 작업공간에서만 조회합니다.".into()); }
    let conn = lock_db(&db)?;
    ensure_run_table(&conn)?;
    let mut stmt = conn.prepare(
        "SELECT id,recorded_at,scenario,passed,report FROM developer_test_runs ORDER BY id DESC LIMIT 200"
    ).map_err(err)?;
    let mut rows = stmt.query([]).map_err(err)?;
    let mut result = Vec::new();
    while let Some(row) = rows.next().map_err(err)? {
        let record: String = row.get(4).map_err(err)?;
        result.push(json!({
            "id": row.get::<_,i64>(0).map_err(err)?,
            "at": row.get::<_,String>(1).map_err(err)?,
            "scenario": row.get::<_,String>(2).map_err(err)?,
            "passed": row.get::<_,i64>(3).map_err(err)? == 1,
            "report": serde_json::from_str::<Value>(&record).map_err(err)?
        }));
    }
    Ok(json!(result))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn temp_base() -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let path = std::env::temp_dir().join(
            format!("bando-dev-workspace-{}-{nanos}",std::process::id()));
        fs::create_dir_all(&path).unwrap();
        path
    }
    #[test]
    fn isolated_clone_keeps_master_and_does_not_touch_production_state() {
        let base = temp_base();
        let production_path = base.join("bando-hub-v001.sqlite");
        let mut original = initialize_database(&production_path).unwrap();
        let mut state = get_snapshot(&original).unwrap();
        state["settings"]["operatorName"] = json!("real-staff");
        state["clients"] = json!([{"id":"real","name":"비공개거래처","tier":"wholesale",
            "address":"서울 테스트로 7","phone":"01000000000","mobile":"",
            "active":true,"payment":"PREPAID","overrides":{},"shippingFeeExcluded":false}]);
        write_snapshot(&mut original, state, 0, false).unwrap();
        let before = get_snapshot(&original).unwrap();
        let (test_base, test_conn) = open_isolated(&base).unwrap();
        let test = get_snapshot(&test_conn).unwrap();
        assert_ne!(test_base, base);
        assert!(test_base.ends_with("developer-test"));
        assert!(test["clients"].as_array().unwrap().is_empty());
        assert_eq!(test["products"],before["products"]);
        assert_eq!(test["settings"]["operatorName"],"real-staff");
        assert_eq!(test["settings"]["excelDirectory"],
            test_base.join("Excel").to_string_lossy().as_ref());
        assert_eq!(get_snapshot(&original).unwrap(),before);
        drop(test_conn);
        drop(original);
        fs::remove_dir_all(base).unwrap();
    }
    #[test]
    fn test_reset_preserves_prices_and_archives_old_audit_and_case_runs() {
        let base = temp_base();
        let test_base = base.join("developer-test");
        fs::create_dir_all(&test_base).unwrap();
        let mut conn = initialize_database(&test_base.join("bando-hub-test.sqlite")).unwrap();
        ensure_run_table(&conn).unwrap();
        let mut state = get_snapshot(&conn).unwrap();
        state["settings"]["excelDirectory"] =
            json!(test_base.join("Excel").to_string_lossy().to_string());
        fs::create_dir_all(test_base.join("Excel")).unwrap();
        state["clients"] = json!([{"id":"fake","name":"가상악기사","tier":"wholesale",
            "address":"서울 테스트로 7","phone":"01000000000","mobile":"",
            "active":true,"payment":"PREPAID","overrides":{},"shippingFeeExcluded":false}]);
        write_snapshot(&mut conn,state,0,false).unwrap();
        conn.execute("INSERT INTO developer_test_runs(recorded_at,scenario,passed,report)
            VALUES ('now','test',1,'{}')",[]).unwrap();
        conn.execute("INSERT INTO receipt_archive(id,order_id,record)
            VALUES ('receipt:test','test','{}')",[]).unwrap();
        let before = get_snapshot(&conn).unwrap();
        assert!(backup_test_and_reset(&mut conn,&test_base,999).is_err());
        let filename = backup_test_and_reset(&mut conn,&test_base,1).unwrap();
        assert!(Path::new(&filename).is_file());
        let after = get_snapshot(&conn).unwrap();
        assert_eq!(after["products"],before["products"]);
        assert_eq!(after["shipping"],before["shipping"]);
        assert_eq!(after["settings"],before["settings"]);
        assert!(after["clients"].as_array().unwrap().is_empty());
        assert_eq!(after["revision"],2);
        let num:i64 = conn.query_row("SELECT COUNT(*) FROM receipt_archive",[],|r|r.get(0)).unwrap();
        assert_eq!(num,0);
        let num:i64 = conn.query_row("SELECT COUNT(*) FROM developer_test_runs",[],|r|r.get(0)).unwrap();
        assert_eq!(num,0);
        drop(conn);
        fs::remove_dir_all(base).unwrap();
    }
}
