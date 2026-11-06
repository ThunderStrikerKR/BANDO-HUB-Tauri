mod reception;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::{fs, path::{Path, PathBuf}, sync::Mutex};
use tauri::{Manager, State};

struct Database { connection: Mutex<Connection>, base: PathBuf }

fn err<E: std::fmt::Display>(e: E) -> String { e.to_string() }
fn lock_db<'a>(db: &'a State<'_, Database>) -> Result<std::sync::MutexGuard<'a, Connection>, String> {
    db.connection.lock().map_err(|_| "데이터베이스 잠금 오류".to_string())
}
fn get_snapshot(conn: &Connection) -> Result<Value, String> {
    let text: String = conn.query_row("SELECT payload FROM app_state WHERE id=1", [], |row| row.get(0)).map_err(err)?;
    serde_json::from_str(&text).map_err(err)
}
fn valid_state(s: &Value) -> Result<(), String> {
    for field in ["products", "orders", "clients", "aliases", "queue", "exports"] {
        if !s.get(field).is_some_and(Value::is_array) {
            return Err(format!("저장 데이터 형식 오류: {field}"));
        }
    }
    if !s.get("settings").is_some_and(Value::is_object) { return Err("설정 데이터 형식 오류".into()); }
    if s["products"].as_array().is_some_and(|p| p.len() > 50000) { return Err("상품 한도 초과".into()); }
    if s["orders"].as_array().is_some_and(|p| p.len() > 100000) { return Err("주문 한도 초과".into()); }
    Ok(())
}
fn write_snapshot(conn: &mut Connection, mut state: Value, expected_revision: u64, validate_orders: bool) -> Result<Value, String> {
    valid_state(&state)?;
    let tx = conn.transaction().map_err(err)?;
    let current = get_snapshot(&tx)?;
    let current_revision = current["revision"].as_u64().unwrap_or(0);
    if current_revision != expected_revision {
        return Err("다른 작업에서 데이터가 수정되었습니다. 새로고침 후 다시 저장하세요.".into());
    }
    validate_clients(&current, &state)?;
    validate_brands(&current, &state)?;
    if validate_orders { reception::validate_reception(&current, &state)?; }
    let archive_entries = reception::new_archive_entries(&current, &state)?;
    state["revision"] = json!(current_revision + 1);
    tx.execute("UPDATE app_state SET payload=?1 WHERE id=1", [serde_json::to_string(&state).map_err(err)?]).map_err(err)?;
    // Maintain searchable product index in SQLite alongside the canonical JSON document.
    tx.execute("DELETE FROM product_index", []).map_err(err)?;
    {
        let mut insert = tx.prepare("INSERT INTO product_index(id,code,name,payload) VALUES (?1,?2,?3,?4)").map_err(err)?;
        for product in state["products"].as_array().ok_or("상품 데이터 오류")? {
            let id = product["id"].as_str().ok_or("상품 ID 누락")?;
            let code = product["code"].as_str().ok_or("상품 코드 누락")?;
            let name = product["name"].as_str().ok_or("상품명 누락")?;
            insert.execute(params![id, code, name, serde_json::to_string(product).map_err(err)?]).map_err(err)?;
        }
    }
    // Order index and the append-only reception archive share the snapshot transaction.
    tx.execute("DELETE FROM order_index", []).map_err(err)?;
    {
        let mut insert = tx.prepare("INSERT INTO order_index(id,client_id,created_at,confirmed_at,status) VALUES (?1,?2,?3,?4,?5)").map_err(err)?;
        for order in state["orders"].as_array().ok_or("주문 데이터 오류")? {
            insert.execute(params![
                order["id"].as_str().ok_or("주문 ID 누락")?,
                order["clientId"].as_str().unwrap_or(""),
                order["createdAt"].as_str().unwrap_or(""),
                order["confirmedAt"].as_str(),
                order["status"].as_str().unwrap_or("REVIEW")
            ]).map_err(err)?;
        }
    }
    for (id, order_id, record) in archive_entries {
        tx.execute(
            "INSERT OR IGNORE INTO receipt_archive(id,order_id,record) VALUES (?1,?2,?3)",
            params![id,order_id,serde_json::to_string(&record).map_err(err)?]
        ).map_err(err)?;
    }
    tx.commit().map_err(err)?;
    Ok(state)
}
// Only modified/new brands are validated so legacy unchanged rows cannot prevent
// routine product, price and order saves. Brand IDs remain stable across renames.
fn brand_terms(brand: &Value) -> Vec<String> {
    let fields = ["name", "korean"];
    let fixed = fields.iter().filter_map(|key| brand[*key].as_str());
    let aliases = brand["aliases"].as_array().into_iter().flatten().filter_map(Value::as_str);
    fixed.chain(aliases)
        .map(|term| term.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase())
        .filter(|term| !term.is_empty()).collect()
}
fn validate_brands(before: &Value, next: &Value) -> Result<(), String> {
    let Some(brands) = next["brands"].as_array() else { return Ok(()); };
    for (position, brand) in brands.iter().enumerate() {
        let id = brand["id"].as_str().unwrap_or("");
        if before["brands"].as_array().is_some_and(|previous| {
            previous.iter().any(|old| old["id"].as_str() == Some(id) && old == brand)
        }) { continue; }
        if id.trim().is_empty() || brand["name"].as_str().unwrap_or("").trim().is_empty() {
            return Err("브랜드 공식명과 식별자를 확인하세요.".into());
        }
        let evidence = brand["evidenceUrl"].as_str().unwrap_or("");
        let valid_evidence = url::Url::parse(evidence).is_ok_and(|link|
            link.scheme() == "https" && link.host_str().is_some() &&
            link.username().is_empty() && link.password().is_none());
        if !valid_evidence {
            return Err("브랜드 확인 근거는 HTTPS URL이어야 합니다.".into());
        }
        let terms = brand_terms(brand);
        for (other_position, other) in brands.iter().enumerate() {
            if position == other_position { continue; }
            if other["id"].as_str() == Some(id) {
                return Err("브랜드 식별자가 중복되었습니다.".into());
            }
            let other_terms = brand_terms(other);
            if terms.iter().any(|term| other_terms.contains(term)) {
                return Err("다른 브랜드의 공식명, 한글명 또는 검색 별칭과 중복됩니다.".into());
            }
        }
    }
    Ok(())
}

// Validate only newly created or edited clients. Existing historical test rows are
// not silently rewritten, but cannot be re-saved with missing sender information.
fn validate_clients(before: &Value, next: &Value) -> Result<(), String> {
    let clients = next["clients"].as_array().ok_or("거래처 데이터 형식 오류")?;
    let old = before["clients"].as_array().ok_or("기존 거래처 데이터 형식 오류")?;
    let accounts = next["settings"]["accounts"].as_array().ok_or("입금 계좌 형식 오류")?;
    for client in clients {
        let id = client["id"].as_str().ok_or("거래처 ID 누락")?;
        if old.iter().any(|c| c["id"].as_str() == Some(id) && c == client) { continue; }
        if !client["deletedAt"].is_null() { continue; }
        if client["name"].as_str().unwrap_or("").trim().is_empty() {
            return Err("거래처명을 입력하세요.".into());
        }
        if !["wholesale", "semi", "retail", "special"].contains(&client["tier"].as_str().unwrap_or("")) {
            return Err("거래처 가격 등급을 선택하세요.".into());
        }
        if client["address"].as_str().unwrap_or("").trim().is_empty() {
            return Err("거래처 주소를 입력하세요.".into());
        }
        if ["phone", "mobile"].iter().all(|k| client[*k].as_str().unwrap_or("").trim().is_empty()) {
            return Err("거래처 전화번호 또는 휴대폰 번호를 입력하세요.".into());
        }
        if let Some(preferred) = client["preferredAccountId"].as_str().filter(|s| !s.is_empty()) {
            if !accounts.iter().any(|a| a["id"].as_str() == Some(preferred)) {
                return Err("거래처 주 사용 계좌가 등록된 입금 계좌 목록에 없습니다.".into());
            }
        }
    }
    Ok(())
}
fn validate_accounts(state: &Value) -> Result<(), String> {
    let accounts = state["settings"]["accounts"].as_array().ok_or("입금 계좌 목록 형식 오류")?;
    let mut ids = std::collections::HashSet::new();
    for account in accounts {
        let id = account["id"].as_str().ok_or("계좌 ID 오류")?;
        if id.is_empty() || !ids.insert(id) { return Err("입금 계좌 ID가 중복되거나 비어 있습니다.".into()); }
        if ["bank", "number", "holder"].iter().any(|k| account[*k].as_str().unwrap_or("").trim().is_empty()) {
            return Err("은행명, 계좌번호, 예금주를 모두 입력한 뒤 저장하세요.".into());
        }
    }
    let check_id = |id: &Value| -> Result<(), String> {
        if let Some(id) = id.as_str().filter(|x| !x.is_empty()) {
            if !ids.contains(id) { return Err("추천 계좌가 등록된 입금 계좌 목록에 없습니다.".into()); }
        }
        Ok(())
    };
    check_id(&state["settings"]["defaultAccountId"])?;
    for brand in ["BANDOSTAND", "BANDOMALL"] {
        check_id(&state["settings"]["brandAccounts"][brand])?;
    }
    for client in state["clients"].as_array().ok_or("거래처 데이터 형식 오류")? {
        if !client["deletedAt"].is_null() { continue; }
        if let Some(id) = client["preferredAccountId"].as_str().filter(|x| !x.is_empty()) {
            if !ids.contains(id) { return Err("거래처에서 사용하는 입금 계좌는 삭제할 수 없습니다. 거래처의 주 사용 계좌부터 변경하세요.".into()); }
        }
    }
    Ok(())
}
fn initialize_database(path: &Path) -> Result<Connection, String> {
    let mut conn = Connection::open(path).map_err(err)?;
    conn.execute_batch(r#"
        PRAGMA journal_mode=WAL;
        PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS app_state(
            id INTEGER PRIMARY KEY CHECK(id=1),payload TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS product_index(
            id TEXT PRIMARY KEY,code TEXT NOT NULL,name TEXT NOT NULL,payload TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_product_code ON product_index(code);
        CREATE INDEX IF NOT EXISTS idx_product_name ON product_index(name);
        CREATE TABLE IF NOT EXISTS order_index(
            id TEXT PRIMARY KEY,client_id TEXT NOT NULL,created_at TEXT NOT NULL,
            confirmed_at TEXT,status TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_order_created ON order_index(created_at);
        CREATE INDEX IF NOT EXISTS idx_order_client ON order_index(client_id);
        CREATE TABLE IF NOT EXISTS receipt_archive(
            id TEXT PRIMARY KEY,order_id TEXT NOT NULL,record TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_receipt_order ON receipt_archive(order_id);
    "#).map_err(err)?;
    let exists: Option<i64> = conn.query_row("SELECT 1 FROM app_state WHERE id=1", [], |r| r.get(0)).optional().map_err(err)?;
    if exists.is_none() {
        let seed: Value = serde_json::from_str(include_str!("../resources/state-seed.json")).map_err(err)?;
        valid_state(&seed)?;
        // New product-only seed. Do not open or migrate the Electron test database.
        conn.execute("INSERT INTO app_state(id,payload) VALUES (1,?1)", [serde_json::to_string(&seed).map_err(err)?]).map_err(err)?;
        // Current revision starts at 0. Populate the same product index without creating fake test records.
        let transaction = conn.transaction().map_err(err)?;
        {
            let mut insert = transaction.prepare("INSERT INTO product_index(id,code,name,payload) VALUES (?1,?2,?3,?4)").map_err(err)?;
            for product in seed["products"].as_array().ok_or("상품 초기 데이터 누락")? {
                insert.execute(params![
                    product["id"].as_str().ok_or("상품 ID 누락")?,
                    product["code"].as_str().ok_or("상품 코드 누락")?,
                    product["name"].as_str().ok_or("상품명 누락")?,
                    serde_json::to_string(product).map_err(err)?
                ]).map_err(err)?;
            }
        }
        transaction.commit().map_err(err)?;
    }
    // Upgrade v0.0.1 in place. The app ID and SQLite filename remain unchanged;
    // previous staff-entered product prices and other local data are retained.
    if conn.query_row("SELECT COUNT(*) FROM order_index", [], |r| r.get::<_, i64>(0)).map_err(err)? == 0 {
        let existing = get_snapshot(&conn)?;
        for order in existing["orders"].as_array().ok_or("주문 데이터 오류")? {
            conn.execute("INSERT OR IGNORE INTO order_index(id,client_id,created_at,confirmed_at,status) VALUES (?1,?2,?3,?4,?5)", params![
                order["id"].as_str().ok_or("주문 ID 누락")?,
                order["clientId"].as_str().unwrap_or(""),
                order["createdAt"].as_str().unwrap_or(""),
                order["confirmedAt"].as_str(),
                order["status"].as_str().unwrap_or("REVIEW")
            ]).map_err(err)?;
            if let (Some(id),Some(receipt))=(order["id"].as_str(),order.get("receipt")) {
                if order["confirmedAt"].as_str().is_some() {
                    conn.execute("INSERT OR IGNORE INTO receipt_archive(id,order_id,record) VALUES (?1,?2,?3)",
                        params![format!("receipt:{id}"),id,serde_json::to_string(receipt).map_err(err)?]).map_err(err)?;
                }
            }
            if let Some(order_id)=order["id"].as_str() {
                for correction in order["rawCorrections"].as_array().into_iter().flatten() {
                    if let Some(correction_id)=correction["id"].as_str() {
                        conn.execute("INSERT OR IGNORE INTO receipt_archive(id,order_id,record) VALUES (?1,?2,?3)",
                            params![format!("correction:{correction_id}"),order_id,serde_json::to_string(correction).map_err(err)?]).map_err(err)?;
                    }
                }
            }
        }
    }
    Ok(conn)
}
#[tauri::command]
fn state_load(db: State<'_, Database>) -> Result<Value, String> { get_snapshot(&*lock_db(&db)?) }

#[tauri::command]
fn state_save(db: State<'_, Database>, state: Value) -> Result<(), String> {
    let revision = state["revision"].as_u64().ok_or("변경 이력이 없는 데이터를 저장할 수 없습니다.")?;
    write_snapshot(&mut *lock_db(&db)?, state, revision, true)?;
    Ok(())
}

// Save just the edited settings keys. Order/product updates do not invalidate
// this edit, but a simultaneous edit of the very same settings key is rejected.
#[tauri::command]
fn settings_patch(db: State<'_, Database>, changes: Value, expected: Value) -> Result<Value, String> {
    let changes = changes.as_object().ok_or("설정 변경 형식 오류")?;
    let expected = expected.as_object().ok_or("설정 기준값 형식 오류")?;
    if changes.is_empty() { return get_snapshot(&*lock_db(&db)?); }
    let allowed = ["senderPostcode", "excelDirectory", "factoryReplyDirectory",
        "modelRepresentatives", "modelFamilies", "kakaoTitleMappings", "kakaoTitleEnabled",
        "panelRatios", "receptionVerticalRatio", "operatorName", "uiScale", "accounts",
        "defaultAccountId", "senderName", "senderAddress", "senderPhone", "senderMobile",
        "rounding", "brandAccounts", "specialPolicy"];
    let mut conn = lock_db(&db)?;
    let mut state = get_snapshot(&conn)?;
    let revision = state["revision"].as_u64().unwrap_or(0);
    for (field, updated) in changes {
        if !allowed.contains(&field.as_str()) || !expected.contains_key(field) {
            return Err("허용되지 않은 설정 변경이거나 기준값이 누락되었습니다.".into());
        }
        let before = state["settings"].get(field.as_str()).unwrap_or(&Value::Null);
        if before != &expected[field] && before != updated {
            return Err(format!("{} 설정이 다른 화면에서 수정됐습니다. 다시 불러온 뒤 저장하세요.",field));
        }
    }
    {
        let settings = state["settings"].as_object_mut().ok_or("설정 데이터 오류")?;
        for (field, updated) in changes {
            if updated.is_null() { settings.remove(field); }
            else { settings.insert(field.clone(), updated.clone()); }
        }
    }
    if ["accounts", "defaultAccountId", "brandAccounts"].iter().any(|k| changes.contains_key(*k)) {
        validate_accounts(&state)?;
    }
    write_snapshot(&mut conn, state, revision, true)
}
#[tauri::command]
fn price_set(db: State<'_, Database>, product_id: String, variant_id: String, tier: String,
             price: Option<i64>, expected: Option<i64>) -> Result<Value, String> {
    if !["wholesale", "semi", "retail"].contains(&tier.as_str()) { return Err("가격 등급 오류".into()); }
    if price.is_some_and(|x| x < 0) { return Err("가격은 음수가 될 수 없습니다.".into()); }
    let mut conn = lock_db(&db)?;
    let mut state = get_snapshot(&conn)?;
    let revision = state["revision"].as_u64().unwrap_or(0);
    let product = state["products"].as_array_mut().unwrap().iter_mut()
        .find(|p| p["id"].as_str() == Some(&product_id)).ok_or("상품을 찾을 수 없습니다.")?;
    let variant = product["variants"].as_array_mut().ok_or("상품 옵션 오류")?.iter_mut()
        .find(|v| v["id"].as_str() == Some(&variant_id)).ok_or("상품 옵션을 찾을 수 없습니다.")?;
    if variant[tier.as_str()].as_i64() != expected {
        return Err("가격이 다른 곳에서 수정됐습니다. 새로고침 후 다시 시도하세요.".into());
    }
    variant[tier.as_str()] = json!(price);
    write_snapshot(&mut conn, state, revision, true)
}

#[tauri::command]
fn clipboard_write(text: String) -> Result<(), String> {
    if text.chars().count() > 100000 { return Err("복사할 문장이 너무 깁니다.".into()); }
    arboard::Clipboard::new().map_err(err)?.set_text(text).map_err(err)
}
#[tauri::command]
fn clipboard_read() -> Result<String, String> {
    arboard::Clipboard::new().map_err(err)?.get_text().map_err(err)
}

#[tauri::command]
fn product_open(target: String) -> Result<(), String> {
    let url = url::Url::parse(&target).map_err(err)?;
    if url.scheme() != "https" || url.host_str().is_none() {
        return Err("HTTPS 상품 링크만 열 수 있습니다.".into());
    }
    open::that(target).map_err(err)
}

#[tauri::command]
fn catalog_report() -> Result<Value, String> {
    let mut data: Value = serde_json::from_str(include_str!("../resources/catalog.json")).map_err(err)?;
    data["sourceProductCount"] = json!(data["products"].as_array().map(|x| x.len()).unwrap_or(0));
    Ok(data)
}

// The old catalog approval matched on product IDs and could create or overwrite
// variants without human review. Keep this compatibility command intentionally
// disabled. The reviewed UI uses revision-checked state_save after a backup.
#[tauri::command]
fn catalog_approve(_db: State<'_, Database>) -> Result<Value, String> {
    Err("이전 방식의 일괄 승인은 안전하지 않아 중지되었습니다. 상품 동기화에서 옵션별 미리보기를 사용하세요.".into())
}

#[tauri::command]
fn receipt_archive(db: State<'_, Database>) -> Result<Value, String> {
    let conn = lock_db(&db)?;
    let mut statement = conn.prepare("SELECT id,order_id,record FROM receipt_archive ORDER BY rowid DESC LIMIT 10000").map_err(err)?;
    let mut rows = statement.query([]).map_err(err)?;
    let mut archive = Vec::new();
    while let Some(row) = rows.next().map_err(err)? {
        let id: String = row.get(0).map_err(err)?;
        let order_id: String = row.get(1).map_err(err)?;
        let record: String = row.get(2).map_err(err)?;
        archive.push(json!({"id":id,"orderId":order_id,"record":serde_json::from_str::<Value>(&record).map_err(err)?}));
    }
    Ok(json!(archive))
}

#[tauri::command]
fn backup_create(db: State<'_, Database>) -> Result<String, String> {
    let backups = db.base.join("backups");
    fs::create_dir_all(&backups).map_err(err)?;
    let filename = format!("bando-hub-{}-{}.sqlite", std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(err)?.as_millis());
    let target = backups.join(&filename);
    if target.exists() { return Err("백업 파일이 이미 존재합니다.".into()); }
    // SQLite VACUUM INTO creates a consistent copy even when the live DB uses WAL.
    lock_db(&db)?.execute("VACUUM INTO ?1", [target.to_string_lossy().to_string()]).map_err(err)?;
    Ok(target.to_string_lossy().to_string())
}
#[tauri::command]
fn backup_list(db: State<'_, Database>) -> Result<Vec<String>, String> {
    let folder = db.base.join("backups");
    if !folder.exists() { return Ok(vec![]); }
    let mut names = fs::read_dir(folder).map_err(err)?.filter_map(|entry| entry.ok())
        .filter(|e| e.path().extension().is_some_and(|ext| ext == "sqlite"))
        .map(|e| e.path().to_string_lossy().to_string()).collect::<Vec<_>>();
    names.sort(); names.reverse(); Ok(names)
}
#[tauri::command]
fn backup_restore(db: State<'_, Database>, filename: String) -> Result<(), String> {
    let allowed = fs::canonicalize(db.base.join("backups")).map_err(err)?;
    let selected = fs::canonicalize(&filename).map_err(err)?;
    if !selected.starts_with(allowed) || selected.extension().is_none_or(|x| x != "sqlite") {
        return Err("백업 폴더에 있는 SQLite 파일만 복원할 수 있습니다.".into());
    }
    let backup = Connection::open_with_flags(selected, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(err)?;
    let mut state = get_snapshot(&backup)?;
    let mut conn = lock_db(&db)?;
    let current = get_snapshot(&conn)?;
    state["revision"] = current["revision"].clone();
    write_snapshot(&mut conn, state, current["revision"].as_u64().unwrap_or(0), false)?;
    Ok(())
}

// Only application-generated XLSX bytes are accepted; the destination is chosen
// in a native Save As dialog. No filesystem path is accepted from JavaScript.
async fn save_xlsx_with_dialog(
    app: tauri::AppHandle,
    label: &'static str,
    bytes: Vec<u8>,
) -> Result<Option<String>, String> {
    if bytes.len() < 4 || bytes.len() > 25 * 1024 * 1024 || !bytes.starts_with(b"PK") {
        return Err("올바른 XLSX 데이터가 아니거나 파일 크기가 너무 큽니다.".into());
    }
    tauri::async_runtime::spawn_blocking(move || -> Result<Option<String>, String> {
        use tauri_plugin_dialog::DialogExt;
        use std::io::Write;
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(err)?.as_millis();
        let filename = format!("BANDO-HUB-{label}-{stamp}.xlsx");
        let selected = app.dialog().file()
            .set_title("Excel 파일 저장 위치 선택")
            .set_file_name(filename)
            .add_filter("Excel 통합 문서", &["xlsx"])
            .blocking_save_file();
        let Some(selected) = selected else { return Ok(None); };
        let mut destination = selected.into_path().map_err(err)?;
        if destination.extension().is_none() {
            destination.set_extension("xlsx");
        }
        if !destination.extension().and_then(|e| e.to_str())
            .is_some_and(|e| e.eq_ignore_ascii_case("xlsx")) {
            return Err("Excel 파일은 .xlsx 확장자로만 저장할 수 있습니다.".into());
        }
        // Do not overwrite an existing workbook even if the file dialog points at it.
        let mut file = fs::OpenOptions::new()
            .write(true).create_new(true).open(&destination).map_err(|error| {
                if error.kind() == std::io::ErrorKind::AlreadyExists {
                    "동일한 이름의 파일이 이미 있습니다. 다른 이름으로 저장해 주세요.".into()
                } else {
                    err(error)
                }
            })?;
        if let Err(error) = file.write_all(&bytes).and_then(|_| file.sync_all()) {
            drop(file);
            let _ = fs::remove_file(&destination);
            return Err(err(error));
        }
        Ok(Some(destination.to_string_lossy().into_owned()))
    }).await.map_err(err)?
}

#[tauri::command]
async fn save_product_workbook(
    app: tauri::AppHandle, bytes: Vec<u8>,
) -> Result<Option<String>, String> {
    save_xlsx_with_dialog(app, "상품가격표", bytes).await
}

#[tauri::command]
async fn save_product_sync_workbook(
    app: tauri::AppHandle, bytes: Vec<u8>,
) -> Result<Option<String>, String> {
    save_xlsx_with_dialog(app, "상품전체목록", bytes).await
}

#[tauri::command]
async fn save_client_workbook(
    app: tauri::AppHandle, bytes: Vec<u8>,
) -> Result<Option<String>, String> {
    save_xlsx_with_dialog(app, "거래처전체목록", bytes).await
}

#[tauri::command]
async fn save_registration_workbook(
    app: tauri::AppHandle, kind: String, bytes: Vec<u8>,
) -> Result<Option<String>, String> {
    let label = match kind.as_str() {
        "양식" => "상품등록양식",
        "결과" => "상품등록결과",
        _ => return Err("허용되지 않은 상품 등록 파일 유형입니다.".into()),
    };
    save_xlsx_with_dialog(app, label, bytes).await
}

fn validate_official_product_url(target: &str) -> Result<url::Url, String> {
    if target.len() > 2048 {
        return Err("상품 URL이 너무 깁니다.".into());
    }
    let url = url::Url::parse(target).map_err(|_| "상품 상세 URL을 확인하세요.".to_string())?;
    if url.scheme() != "https" ||
        url.port().is_some() ||
        !url.username().is_empty() ||
        url.password().is_some() ||
        !matches!(url.host_str(), Some("bandostand.com" | "www.bandostand.com" |
            "bandomall.co.kr" | "www.bandomall.co.kr")) {
        return Err("반도스탠드 또는 반도몰의 HTTPS 상품 상세 주소만 허용됩니다.".into());
    }
    let segments: Vec<&str> = url.path_segments()
        .map(|parts| parts.filter(|part| !part.is_empty()).collect())
        .unwrap_or_default();
    let is_cafe24 = url.path() == "/product/detail.html" &&
        url.query_pairs().any(|(key, value)| key == "product_no" &&
            !value.is_empty() && value.chars().all(|c| c.is_ascii_digit()));
    let is_seo = segments.len() >= 3 && segments[0] == "product" &&
        segments[1] != "detail.html" && segments[2].chars().all(|c| c.is_ascii_digit());
    if !is_cafe24 && !is_seo {
        return Err("상품번호가 포함된 공식 상세페이지 URL을 사용하세요.".into());
    }
    Ok(url)
}

#[cfg(test)]
mod official_url_tests {
    use super::validate_official_product_url;

    #[test]
    fn accepts_cafe24_and_seo_product_urls() {
        assert!(validate_official_product_url(
            "https://bandostand.com/product/detail.html?product_no=42"
        ).is_ok());
        assert!(validate_official_product_url(
            "https://www.bandostand.com/product/stand-bd-701/54/"
        ).is_ok());
        assert!(validate_official_product_url(
            "https://bandomall.co.kr/product/guitar-string/3449/category/1/display/1/"
        ).is_ok());
    }
    #[test]
    fn rejects_non_official_and_unsafe_urls() {
        for item in [
            "http://bandostand.com/product/x/42/",
            "https://bandostand.com.evil.example/product/x/42/",
            "https://127.0.0.1/product/x/42/",
            "https://user:pass@bandostand.com/product/x/42/",
            "https://bandostand.com:8443/product/x/42/",
            "https://bandostand.com/product/detail.html?product_no=foo",
            "https://bandostand.com/shopinfo/guide.html",
            "https://bandostand.com/product/no-number/",
        ] {
            assert!(validate_official_product_url(item).is_err(), "{item}");
        }
    }
}

// Read-only official product fetch. URL validation and redirect blocking prevent
// arbitrary network requests from the renderer (including local-network targets).
#[tauri::command]
async fn fetch_official_product_html(target: String) -> Result<String, String> {
    const MAX_BODY: usize = 4 * 1024 * 1024;
    let url = validate_official_product_url(&target)?;

    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(15))
        .user_agent("BANDO-HUB/0.0.4 (official product preview)")
        .build().map_err(err)?;
    let mut response = client.get(url).send().await.map_err(|e| format!("공식 홈페이지 연결 실패: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("상품 페이지를 읽지 못했습니다 (HTTP {}).", response.status()));
    }
    let content_type = response.headers().get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok()).unwrap_or("");
    if !content_type.to_ascii_lowercase().starts_with("text/html") &&
        !content_type.to_ascii_lowercase().starts_with("application/xhtml+xml") {
        return Err("상품 페이지가 HTML 형식이 아닙니다.".into());
    }
    if response.content_length().is_some_and(|length| length > MAX_BODY as u64) {
        return Err("상품 페이지가 허용 크기를 초과했습니다.".into());
    }
    let mut body = Vec::new();
    while let Some(part) = response.chunk().await.map_err(err)? {
        if body.len().saturating_add(part.len()) > MAX_BODY {
            return Err("상품 페이지가 허용 크기를 초과했습니다.".into());
        }
        body.extend_from_slice(&part);
    }
    String::from_utf8(body).map_err(|_| "현재 페이지의 문자 인코딩을 안전하게 해석할 수 없습니다.".into())
}


pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let base = app.path().app_data_dir()?;
            fs::create_dir_all(&base)?;
            let conn = initialize_database(&base.join("bando-hub-v001.sqlite"))
                .map_err(std::io::Error::other)?;
            app.manage(Database { connection: Mutex::new(conn), base });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            state_load, state_save, settings_patch, price_set, clipboard_write, clipboard_read,
            product_open, catalog_report, catalog_approve, receipt_archive, backup_create, backup_list, backup_restore, save_product_workbook, save_registration_workbook, save_client_workbook, save_product_sync_workbook,
            fetch_official_product_html
        ])
        .run(tauri::generate_context!())
        .expect("BANDO HUB Tauri runtime error");
}
