//! Non-destructive Tauri startup diagnostics and guarded database retry.
//! A failed DB open must not abort the native window or recreate an existing
//! database. Operators can retry after releasing a file lock or permissions.
use super::*;
use serde::Serialize;
use std::sync::Mutex;
use std::time::Instant;
use tauri::AppHandle;

#[derive(Debug, Clone)]
enum Phase {
    Opening,
    Ready { database_ms: u64, ready_ms: u64 },
    Failed(String),
    Retrying,
}
#[derive(Debug)]
struct StartupProgress {
    phase: Phase,
    attempts: u32,
}
pub(super) struct StartupRecovery {
    pub(super) is_test: bool,
    started: Instant,
    progress: Mutex<StartupProgress>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct StartupStatus {
    phase: &'static str,
    error: Option<String>,
    attempts: u32,
    database_ms: Option<u64>,
    ready_ms: Option<u64>,
    is_test: bool,
}
impl StartupRecovery {
    pub(super) fn new(is_test: bool) -> Self {
        Self {
            is_test,
            started: Instant::now(),
            progress: Mutex::new(StartupProgress {
                phase: Phase::Opening, attempts: 1,
            }),
        }
    }
    fn status(&self) -> Result<StartupStatus, String> {
        let value = self.progress.lock().map_err(|_| "초기화 상태 잠금 오류")?;
        Ok(value_to_status(self.is_test, &value))
    }
    fn finish(&self, result: Result<u64, String>) -> Result<StartupStatus, String> {
        let mut state = self.progress.lock().map_err(|_| "초기화 상태 잠금 오류")?;
        state.phase = match result {
            Ok(database_ms) => Phase::Ready {
                database_ms,
                ready_ms: self.started.elapsed().as_millis() as u64,
            },
            Err(reason) => Phase::Failed(reason),
        };
        Ok(value_to_status(self.is_test, &state))
    }
    fn start_retry(&self) -> Result<(), String> {
        let mut value = self.progress.lock().map_err(|_| "초기화 상태 잠금 오류")?;
        if !matches!(value.phase, Phase::Failed(_)) {
            return Err("DB 초기화 실패 상태에서만 다시 시도할 수 있습니다.".into());
        }
        value.phase = Phase::Retrying;
        value.attempts += 1;
        Ok(())
    }
}
fn value_to_status(test: bool, state: &StartupProgress) -> StartupStatus {
    let (phase, error, database_ms, ready_ms) = match &state.phase {
        Phase::Opening => ("OPENING", None, None, None),
        Phase::Retrying => ("RETRYING", None, None, None),
        Phase::Failed(message) => ("ERROR", Some(message.clone()), None, None),
        Phase::Ready { database_ms, ready_ms } =>
            ("READY", None, Some(*database_ms), Some(*ready_ms)),
    };
    StartupStatus {
        phase, error, attempts: state.attempts,
        database_ms, ready_ms, is_test: test,
    }
}
/// Validation only reads the persisted snapshot. Never run VACUUM INTO,
/// migration rollback, restore, DELETE, or a seed overwrite on startup failure.
fn open_checked_sqlite(path: &Path) -> Result<Connection, String> {
    // An existing file is user data, even if malformed. Do not accidentally
    // treat it as an empty new database and insert a fresh seed.
    if path.exists() {
        let preview = Connection::open_with_flags(
            path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY
        ).map_err(|error| format!("기존 SQLite 파일을 읽을 수 없습니다: {error}"))?;
        let has_table: Option<i64> = preview.query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='app_state'",
            [], |row| row.get(0),
        ).optional().map_err(err)?;
        if has_table.is_none() {
            return Err("기존 SQLite 파일에 업무 데이터 테이블이 없습니다. 자동 초기화하지 않았습니다.".into());
        }
        valid_state(&get_snapshot(&preview)?)?;
    }
    let connection = initialize_database(path)?;
    let verdict: String = connection
        .query_row("PRAGMA quick_check(1)", [], |row| row.get(0))
        .map_err(|error| format!("SQLite 무결성 검사 실패: {error}"))?;
    if verdict != "ok" {
        return Err(format!("SQLite 무결성 오류: {verdict}"));
    }
    let snapshot = get_snapshot(&connection)?;
    valid_state(&snapshot)?;
    Ok(connection)
}
fn open_database(app: &AppHandle, is_test: bool) -> Result<Database, String> {
    let base = app.path().app_data_dir().map_err(err)?;
    fs::create_dir_all(&base).map_err(err)?;
    let (active_base, connection) = if is_test {
        // Never fall back to the live SQLite file when developer TEST fails.
        let (root, candidate) = developer_workspace::open_isolated(&base)?;
        let check: String = candidate.query_row("PRAGMA quick_check(1)", [], |row| row.get(0))
            .map_err(err)?;
        if check != "ok" {
            return Err(format!("격리 TEST SQLite 무결성 오류: {check}"));
        }
        valid_state(&get_snapshot(&candidate)?)?;
        (root, candidate)
    } else {
        (base.clone(), open_checked_sqlite(&base.join("bando-hub-v001.sqlite"))?)
    };
    Ok(Database {
        connection: Mutex::new(connection),
        base: active_base,
        is_test,
    })
}
/// The setup handler must return Ok even if the DB cannot be opened, so the
/// application can paint its recovery screen. Failed startup never manages
/// a partially initialized Database instance.
pub(super) fn initial_open(app: &AppHandle, state: &StartupRecovery) {
    let began = Instant::now();
    match open_database(app, state.is_test) {
        Ok(db) => {
            if !app.manage(db) {
                let _ = state.finish(Err("이미 열린 데이터베이스 상태와 충돌합니다.".into()));
                return;
            }
            let _ = state.finish(Ok(began.elapsed().as_millis() as u64));
            super::start_automatic_backup(app.clone());
        }
        Err(reason) => {
            eprintln!("반도허브 DB 초기화 실패 (기존 파일 보존): {reason}");
            let _ = state.finish(Err(reason));
        }
    }
}
#[tauri::command]
pub(super) fn startup_status(state: State<'_, StartupRecovery>) -> Result<StartupStatus, String> {
    state.status()
}
#[tauri::command]
pub(super) fn startup_metrics(state: State<'_, StartupRecovery>) -> Result<Value, String> {
    let status = state.status()?;
    // Do not invent window paint or JS hydration times. Only the native
    // database-open and startup-ready durations are actually measured.
    Ok(json!({
        "databaseMs": status.database_ms,
        "readyMs": status.ready_ms,
        "windowShownMs": null,
        "dataMs": null
    }))
}
#[tauri::command]
pub(super) async fn retry_startup(
    app: AppHandle, state: State<'_, StartupRecovery>,
) -> Result<StartupStatus, String> {
    state.start_retry()?;
    let target = app.clone();
    let test_mode = state.is_test;
    let began = Instant::now();
    let attempt = tauri::async_runtime::spawn_blocking(move || open_database(&target, test_mode))
        .await.map_err(|error| format!("초기화 재시도 작업 실패: {error}"));
    match attempt {
        Ok(Ok(db)) => {
            if !app.manage(db) {
                return state.finish(Err("재시도 중 이미 열린 DB가 발견됐습니다.".into()));
            }
            let status = state.finish(Ok(began.elapsed().as_millis() as u64))?;
            super::start_automatic_backup(app.clone());
            Ok(status)
        }
        Ok(Err(message)) | Err(message) => {
            eprintln!("반도허브 DB 재시도 실패 (기존 파일 보존): {message}");
            state.finish(Err(message))
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_directory() -> PathBuf {
        let suffix = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let root = std::env::temp_dir().join(format!(
            "bando-startup-recovery-{}-{suffix}",std::process::id()
        ));
        fs::create_dir(&root).unwrap();
        root
    }
    #[test]
    fn failed_open_never_replaces_existing_user_payload() {
        let root = unique_directory();
        let path = root.join("existing.sqlite");
        let conn = initialize_database(&path).unwrap();
        let raw = "{\"revision\":3,\"orders\":\"broken\"}";
        conn.execute("UPDATE app_state SET payload=?1 WHERE id=1", [raw]).unwrap();
        drop(conn);
        assert!(open_checked_sqlite(&path).is_err());
        let current = Connection::open(&path).unwrap();
        let saved: String = current.query_row(
            "SELECT payload FROM app_state WHERE id=1", [], |row| row.get(0),
        ).unwrap();
        assert_eq!(saved, raw, "실패 중 기존 주문 데이터에 손대면 안 됩니다");
        drop(current);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn foreign_existing_sqlite_is_never_seeded() {
        let root = unique_directory();
        let path = root.join("other.sqlite");
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch("CREATE TABLE unrelated(value TEXT);
            INSERT INTO unrelated(value) VALUES ('preserve this record');").unwrap();
        drop(conn);
        let result = open_checked_sqlite(&path);
        assert!(result.unwrap_err().contains("자동 초기화하지 않았습니다"));
        let conn = Connection::open(&path).unwrap();
        let table_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='app_state'",
            [], |row| row.get(0)
        ).unwrap();
        assert_eq!(table_count, 0);
        let saved: String = conn.query_row(
            "SELECT value FROM unrelated", [], |row| row.get(0)
        ).unwrap();
        assert_eq!(saved, "preserve this record");
        drop(conn);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn retry_is_only_allowed_from_failed_state_and_does_not_reset_mode() {
        let recover = StartupRecovery::new(true);
        assert_eq!(recover.status().unwrap().phase, "OPENING");
        assert!(recover.start_retry().is_err());
        recover.finish(Err("database locked".into())).unwrap();
        assert_eq!(recover.status().unwrap().phase, "ERROR");
        recover.start_retry().unwrap();
        assert_eq!(recover.status().unwrap().phase, "RETRYING");
        assert!(recover.start_retry().is_err());
        let resumed = recover.finish(Ok(12)).unwrap();
        assert_eq!(resumed.phase, "READY");
        assert_eq!(resumed.attempts, 2);
        assert_eq!(resumed.database_ms, Some(12));
        assert!(resumed.is_test);
        assert!(recover.start_retry().is_err());
    }
    #[test]
    fn missing_db_uses_seed_but_existing_valid_db_survives_reopen() {
        let root = unique_directory();
        let file = root.join("live.sqlite");
        let mut conn = open_checked_sqlite(&file).unwrap();
        let mut saved = get_snapshot(&conn).unwrap();
        let previous = saved["revision"].as_u64().unwrap_or(0);
        saved["settings"]["operatorName"] = json!("업무 테스트");
        write_snapshot(&mut conn, saved, previous, false).unwrap();
        drop(conn);
        let conn = open_checked_sqlite(&file).unwrap();
        assert_eq!(get_snapshot(&conn).unwrap()["settings"]["operatorName"], "업무 테스트");
        drop(conn);
        fs::remove_dir_all(root).unwrap();
    }
}
