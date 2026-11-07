//! Validate a persisted factory export before opening it with its associated app.
//! No JavaScript supplied paths, shell commands or bulk filesystem access.
use serde_json::Value;
use std::{fs, io::Read, path::{Path,PathBuf}};

pub(crate) fn resolve_export_path(state: &Value, id: &str) -> Result<PathBuf, String> {
    if id.trim().is_empty() || id.len()>256 {
        return Err("출력 이력 ID가 올바르지 않습니다.".into());
    }
    let record = state["exports"].as_array()
        .and_then(|rows| rows.iter().find(|r| r["id"].as_str()==Some(id)))
        .ok_or("해당 Excel 출력 이력을 찾지 못했습니다.")?;
    let saved = record["savedPath"].as_str().map(str::trim)
        .filter(|p| !p.is_empty())
        .ok_or("이 출력 이력에는 저장된 파일 위치가 없습니다.".to_string())?;
    let file = Path::new(saved);
    if !file.is_absolute() {
        return Err("저장된 Excel 파일의 경로가 올바르지 않습니다.".into());
    }
    let filename = record["filename"].as_str()
        .filter(|s| !s.is_empty())
        .ok_or("출력 파일 이름을 확인할 수 없습니다.")?;
    if file.file_name().and_then(|name|name.to_str())
        .is_none_or(|name| !name.eq_ignore_ascii_case(filename)) {
        return Err("출력 이력에 기록된 파일 이름과 실제 경로가 다릅니다.".into());
    }
    let is_xlsx = |path: &Path| path.extension().and_then(|e|e.to_str())
        .is_some_and(|ext|ext.eq_ignore_ascii_case("xlsx"));
    if !is_xlsx(file) {
        return Err("Excel .xlsx 파일만 열 수 있습니다.".into());
    }
    // Resolve any symbolic links before checking the file type and extension.
    let canonical = fs::canonicalize(file)
        .map_err(|_| "저장된 Excel 파일이 이동되었거나 삭제됐습니다. 경로를 확인하세요.".to_string())?;
    if !is_xlsx(&canonical) || !canonical.is_file() {
        return Err("정상적인 Excel .xlsx 파일만 열 수 있습니다.".into());
    }
    let metadata = fs::metadata(&canonical).map_err(|e|e.to_string())?;
    if metadata.len()<4 || metadata.len()>25*1024*1024 {
        return Err("출력 Excel 파일의 크기가 올바르지 않습니다.".into());
    }
    let mut magic = [0u8; 4];
    fs::File::open(&canonical).and_then(|mut f|f.read_exact(&mut magic))
        .map_err(|_| "저장된 Excel 파일을 읽을 수 없습니다.".to_string())?;
    if &magic != b"PK\x03\x04" {
        return Err("저장된 파일은 정상적인 XLSX 형식이 아닙니다.".into());
    }
    // Keep the original native path so Windows Excel can open it without
    // possible verbatim-path prefix incompatibilities.
    Ok(file.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::time::{SystemTime,UNIX_EPOCH};

    fn fixture() -> (PathBuf,Value) {
        let n = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir()
            .join(format!("bando-export-open-{}-{}",std::process::id(),n));
        fs::create_dir_all(&dir).unwrap();
        let file=dir.join("BANDO-공장출력.xlsx");
        fs::write(&file,b"PK\x03\x04synthetic-zip-payload").unwrap();
        let state=json!({"exports":[{"id":"export-1",
            "filename":"BANDO-공장출력.xlsx",
            "savedPath":file.to_string_lossy()}]});
        (file,state)
    }
    #[test]
    fn opens_only_recorded_existing_excel_file_and_rejects_unknown_ids() {
        let (file,state)=fixture();
        assert_eq!(resolve_export_path(&state,"export-1").unwrap(),file);
        assert!(resolve_export_path(&state,"other-id").is_err());
        assert!(resolve_export_path(&state,"").is_err());
        let mut unlisted=state.clone();
        unlisted["exports"][0]["savedPath"]=json!(file.parent().unwrap().join("different.xlsx").to_string_lossy());
        assert!(resolve_export_path(&unlisted,"export-1").is_err());
        fs::remove_dir_all(file.parent().unwrap()).unwrap();
    }
    #[test]
    fn rejects_missing_misnamed_non_xlsx_or_invalid_archives() {
        let (file,mut state)=fixture();
        state["exports"][0]["filename"]=json!("different.xlsx");
        assert!(resolve_export_path(&state,"export-1").is_err());
        state["exports"][0]["filename"]=json!("BANDO-공장출력.xlsx");
        fs::write(&file,b"NOTXLSX").unwrap();
        assert!(resolve_export_path(&state,"export-1").is_err());
        fs::remove_file(&file).unwrap();
        assert!(resolve_export_path(&state,"export-1").is_err());
        let renamed=file.with_extension("exe");
        fs::write(&renamed,b"PK\x03\x04data").unwrap();
        state["exports"][0]["filename"]=json!("BANDO-공장출력.exe");
        state["exports"][0]["savedPath"]=json!(renamed.to_string_lossy());
        assert!(resolve_export_path(&state,"export-1").is_err());
        fs::remove_dir_all(file.parent().unwrap()).unwrap();
    }
}
